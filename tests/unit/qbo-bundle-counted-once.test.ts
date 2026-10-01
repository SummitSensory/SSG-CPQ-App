import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P-2026-000086 (2026-10-01): the invoice push was refused with
 *   "Invoice lines total 2567186 but the accepted grand total is 2556239 — over by 10947".
 * The Slackline Line & Safety Bundle was priced at $109.47 on its parent line, and its
 * three "— " component rows ALSO carried rates ($24.98 + $40.49 + $44.00 = $109.47).
 * The proposal and its frozen total count a bundle once (versionTotals); the QuickBooks
 * line assembly summed quantity × rate on every row and billed it twice.
 */
const state = vi.hoisted(() => ({
  items: [] as unknown[],
  sections: [] as unknown[],
  grandTotal: 0n,
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    proposalVersion: {
      findUnique: async () => ({
        id: 'v7',
        status: 'ACCEPTED',
        priceSnapshotId: 'snap-1',
        items: state.items,
        sections: state.sections,
      }),
    },
    priceSnapshot: {
      findUnique: async () => ({
        id: 'snap-1',
        currency: 'USD',
        grandTotal: state.grandTotal,
        engineVersion: 'proposal-builder-1',
        breakdown: {
          thirdPartyFreightMinor: 0,
          structureFreightMinor: 0,
          matsFreightMinor: 0,
          discountMinor: 0,
          taxMinor: 0,
          payment: { deposit: 0 },
        },
      }),
    },
  },
}));
vi.mock('../../src/integrations/quickbooks/links.js', () => ({ findLink: async () => null }));
vi.mock('../../src/crossborder/sellerCharges.js', () => ({
  sellerCollectedCharges: async () => ({ lines: [] }),
}));

const { loadAcceptedTotals } = await import('../../src/integrations/quickbooks/transactions.js');
const { buildInvoiceBody } = await import('../../src/integrations/quickbooks/invoices.js');
const { versionTotals, countedRevenueByLine } = await import('../../src/proposals/analytics.js');

const product = (name: string, rateMinor: number, quantity = 1) => ({
  lineType: 'PRODUCT',
  name,
  quantity,
  rateMinor,
});

/** The shape of P-2026-000086 v7, reduced to the bundle and one ordinary line. */
const ITEMS = [
  { lineType: 'GROUP', name: 'Accessories' },
  product('Climbing wall panel', 250000),
  product('Slackline Line & Safety Bundle', 10947),
  product('— 2 in. Heavy-Duty Ratchet Tie-Down Strap with J Hook', 2498),
  product('— Protective Sleeves for Ratchet Straps', 4049),
  product('— Ratchet Strap Defender (2PK)', 4400),
];

beforeEach(() => {
  state.items = ITEMS;
  state.sections = [{ id: 'meta', data: {} }];
  state.grandTotal = BigInt(versionTotals(ITEMS, state.sections).total);
});

describe('a priced bundle on a QuickBooks document', () => {
  it('is counted once, so the invoice equals the accepted total', async () => {
    // The accepted total counts the bundle once.
    expect(state.grandTotal).toBe(250000n + 10947n);

    const totals = await loadAcceptedTotals('v7');
    const body = buildInvoiceBody({
      customerQboId: 'c1',
      currency: 'USD',
      memo: '',
      lines: totals.lines,
      fees: totals.fees,
      orderDiscountMinor: totals.orderDiscountMinor,
      taxMinor: totals.taxMinor,
      expectedTotalMinor: totals.grandTotalMinor,
    }) as { Line: Array<{ Amount: number; Description?: string }> };

    // The components still print, with their names, at $0.
    const amounts = totals.lines.filter((l) => l.kind === 'PRODUCT').map((l) => l.amountMinor);
    expect(amounts).toEqual([250000n, 10947n, 0n, 0n, 0n]);
    expect(body.Line.length).toBeGreaterThan(0);
  });

  it('bills the components when the bundle parent is unpriced', async () => {
    state.items = ITEMS.map((it) =>
      it.name === 'Slackline Line & Safety Bundle' ? { ...it, rateMinor: 0 } : it,
    );
    state.grandTotal = BigInt(versionTotals(state.items, state.sections).total);
    const totals = await loadAcceptedTotals('v7');
    const amounts = totals.lines.filter((l) => l.kind === 'PRODUCT').map((l) => l.amountMinor);
    expect(amounts).toEqual([250000n, 0n, 2498n, 4049n, 4400n]);
    expect(amounts.reduce((a, v) => a + v, 0n)).toBe(totals.grandTotalMinor);
  });
});

describe('countedRevenueByLine', () => {
  it('agrees with the subtotal on every shape, line for line', () => {
    const shapes = [
      ITEMS,
      [product('— orphan component', 500), product('Plain', 100)],
      [product('Parent', 0), product('— a', 300), { lineType: 'NOTE' }, product('— b', 7)],
    ];
    for (const lines of shapes) {
      const per = countedRevenueByLine(lines);
      expect(per).toHaveLength(lines.length);
      expect(per.reduce((a, v) => a + v, 0)).toBe(versionTotals(lines, []).subtotal);
    }
  });
});
