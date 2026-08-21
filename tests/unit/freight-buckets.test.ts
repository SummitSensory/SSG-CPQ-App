import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../../src/lib/audit.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  env: { MONDAY_DEALS_BOARD_ID: '123' },
  isMondayPushConfigured: () => true,
  qboEnvironment: () => 'SANDBOX',
}));

import {
  BUCKETS,
  alertIsQuiet,
  apportion,
  applyFreightEntries,
  assertEvidence,
  assertFreightOnlyChange,
  describeGaps,
  freightGaps,
  freightLines,
  normalizeBucket,
  urgencyFor,
  type FreightEntryInput,
} from '../../src/proposals/freightTrueUp.js';
import { parseBoardMoney } from '../../src/integrations/monday/freightPull.js';
import { versionTotals } from '../../src/proposals/analytics.js';

/**
 * Freight, four buckets.
 *
 * The money rules that a customer would notice if they were wrong: that a shared
 * amount splits to the cent, that a second quote adds rather than replacing, that a
 * hand-typed board figure cannot be saved anonymously, and that the amendment refuses
 * to touch anything except freight.
 */

const line = (
  ref: string,
  sku: string,
  name: string,
  unit: number,
  qty = 1,
  extra: Record<string, unknown> = {},
) => ({
  ref,
  sku,
  name,
  quantity: qty,
  unitPriceMinor: unit,
  lineType: 'PRODUCT',
  ...extra,
});

function fixture() {
  return {
    items: [
      line('l1', 'SP-SWING', 'Southpaw platform swing', 120_000),
      line('l2', 'SP-PAD', 'Crash pad', 40_000),
      line('l3', 'R-SSG-1010CLM', 'Floor padding', 60_000),
      { ref: 'n1', lineType: 'NOTE', name: 'Site note' },
    ],
    sections: [{ id: 'meta', data: { taxAmountMinor: 0, discountPct: 0 } }],
  };
}

describe('the four buckets', () => {
  it('reads the old names as the new ones, so old records still resolve', () => {
    expect(normalizeBucket('STRUCTURE')).toBe('STEEL');
    expect(normalizeBucket('STANDARD')).toBe('OTHER');
    expect(normalizeBucket('THIRD_PARTY')).toBe('THERAPEUTIC');
    expect(normalizeBucket('steel')).toBe('STEEL');
    expect(normalizeBucket('nonsense')).toBeNull();
  });

  it('knows which two come off the board and which two are typed', () => {
    expect(BUCKETS.STEEL.source).toBe('MONDAY');
    expect(BUCKETS.MATS.source).toBe('MONDAY');
    expect(BUCKETS.THERAPEUTIC.source).toBe('MANUAL');
    expect(BUCKETS.OTHER.source).toBe('MANUAL');
  });

  it('lets other freight go on the job or on items, and therapeutic only on items', () => {
    expect(BUCKETS.OTHER.scopes).toEqual(['JOB', 'LINES']);
    expect(BUCKETS.THERAPEUTIC.scopes).toEqual(['LINES']);
    expect(BUCKETS.STEEL.scopes).toEqual(['JOB']);
  });
});

describe('the item list', () => {
  it('offers every product line, not only the ones with a gap', () => {
    const { items } = fixture();
    const lines = freightLines(items, { freightQuotedSkus: new Set(['SP-SWING']) });
    expect(lines.map((l) => l.ref)).toEqual(['l1', 'l2', 'l3']); // the note is not a product
    expect(lines.find((l) => l.ref === 'l1')!.freightQuoted).toBe(true);
    expect(lines.find((l) => l.ref === 'l2')!.freightQuoted).toBe(false);
  });

  it('extends by quantity, so the split weights are what the customer is paying', () => {
    const lines = freightLines([line('l1', 'X', 'Thing', 25_000, 4)]);
    expect(lines[0]!.extendedMinor).toBe(100_000);
  });

  it('names the vendor so a row says whose freight is missing', () => {
    const lines = freightLines([line('l1', 'SP-SWING', 'Swing', 1000)], {
      vendorBySku: new Map([['SP-SWING', 'Southpaw']]),
    });
    expect(lines[0]!.vendor).toBe('Southpaw');
  });
});

describe('apportionment', () => {
  it('splits pro-rata on price and always sums to the whole', () => {
    const split = apportion(184_000, [
      { ref: 'a', extendedMinor: 120_000 },
      { ref: 'b', extendedMinor: 40_000 },
      { ref: 'c', extendedMinor: 60_000 },
    ]);
    expect(split.reduce((a, x) => a + x.amountMinor, 0)).toBe(184_000);
    // 120/220, 40/220, 60/220 of 184000 — the cent goes to the largest remainder.
    expect(split.map((x) => x.amountMinor)).toEqual([100_364, 33_454, 50_182]);
  });

  it('never loses or invents a cent on an awkward division', () => {
    for (const total of [1, 7, 99, 100_001, 333_333]) {
      const split = apportion(total, [
        { ref: 'a', extendedMinor: 1 },
        { ref: 'b', extendedMinor: 1 },
        { ref: 'c', extendedMinor: 1 },
      ]);
      expect(
        split.reduce((a, x) => a + x.amountMinor, 0),
        String(total),
      ).toBe(total);
    }
  });

  it('splits evenly when the selection has no price to go on', () => {
    const split = apportion(300, [
      { ref: 'a', extendedMinor: 0 },
      { ref: 'b', extendedMinor: 0 },
    ]);
    expect(split.map((x) => x.amountMinor)).toEqual([150, 150]);
  });

  it('is deterministic — the same selection and amount split the same way twice', () => {
    const lines = [
      { ref: 'a', extendedMinor: 5_000 },
      { ref: 'b', extendedMinor: 5_000 },
      { ref: 'c', extendedMinor: 5_000 },
    ];
    expect(apportion(1_000, lines)).toEqual(apportion(1_000, lines));
  });

  it('refuses an empty selection rather than quietly charging nobody', () => {
    expect(() => apportion(1_000, [])).toThrow(/at least one item/i);
  });
});

describe('applying entries', () => {
  const entry = (over: Partial<FreightEntryInput>): FreightEntryInput => ({
    bucket: 'STEEL',
    scope: 'JOB',
    amountMinor: 0,
    ...over,
  });

  it('writes a job-level steel figure onto the meta and clears the TBD wording', () => {
    const f = fixture();
    (f.sections[0]!.data as Record<string, unknown>).tbdStructureFreight = 'TBD';
    const out = applyFreightEntries(f.sections, f.items, [
      entry({ bucket: 'STEEL', amountMinor: 425_000 }),
    ]);
    const meta = (out.sections as Array<{ id: string; data: Record<string, unknown> }>)[0]!.data;
    expect(meta.structureFreightMinor).toBe(425_000);
    expect(meta.tbdStructureFreight).toBe('');
    expect(out.after.structureFreight).toBe(425_000);
    expect(out.deltaMinor).toBe(425_000);
  });

  it('ticks the other-freight switch, or the money would silently vanish', () => {
    const f = fixture();
    const out = applyFreightEntries(f.sections, f.items, [
      entry({ bucket: 'OTHER', amountMinor: 12_500 }),
    ]);
    const meta = (out.sections as Array<{ id: string; data: Record<string, unknown> }>)[0]!.data;
    expect(meta.stdFreightOn).toBe(true);
    expect(out.after.stdFreight).toBe(12_500);
  });

  it('adds to a line rather than replacing it — a second quote is a second shipment', () => {
    const f = fixture();
    (f.items[0] as Record<string, unknown>).tpFreightMinor = 20_000;
    const out = applyFreightEntries(f.sections, f.items, [
      entry({
        bucket: 'THERAPEUTIC',
        scope: 'LINES',
        amountMinor: 15_000,
        allocations: [{ ref: 'l1', amountMinor: 15_000 }],
      }),
    ]);
    const items = out.items as Array<Record<string, unknown>>;
    expect(items[0]!.tpFreightMinor).toBe(35_000);
  });

  it('sums two amounts in the same job bucket', () => {
    const f = fixture();
    const out = applyFreightEntries(f.sections, f.items, [
      entry({ bucket: 'MATS', amountMinor: 80_000 }),
      entry({ bucket: 'MATS', amountMinor: 15_000 }),
    ]);
    expect(out.after.matsFreight).toBe(95_000);
  });

  it('refuses a split that does not add up to the amount entered', () => {
    const f = fixture();
    expect(() =>
      applyFreightEntries(f.sections, f.items, [
        entry({
          bucket: 'THERAPEUTIC',
          scope: 'LINES',
          amountMinor: 10_000,
          allocations: [{ ref: 'l1', amountMinor: 9_000 }],
        }),
      ]),
    ).toThrow(/comes to .* but the amount entered/i);
  });

  it('refuses to write to an item that is no longer on the proposal', () => {
    const f = fixture();
    expect(() =>
      applyFreightEntries(f.sections, f.items, [
        entry({
          bucket: 'THERAPEUTIC',
          scope: 'LINES',
          amountMinor: 1_000,
          allocations: [{ ref: 'gone', amountMinor: 1_000 }],
        }),
      ]),
    ).toThrow(/no longer on this proposal/i);
  });

  it('refuses a bucket in a scope it does not use', () => {
    const f = fixture();
    expect(() =>
      applyFreightEntries(f.sections, f.items, [
        entry({ bucket: 'STEEL', scope: 'LINES', amountMinor: 1_000 }),
      ]),
    ).toThrow(/cannot be entered/i);
    expect(() =>
      applyFreightEntries(f.sections, f.items, [
        entry({ bucket: 'THERAPEUTIC', scope: 'JOB', amountMinor: 1_000 }),
      ]),
    ).toThrow(/cannot be entered/i);
  });

  it('reports one change per bucket that moved, and nothing for the ones that did not', () => {
    const f = fixture();
    const out = applyFreightEntries(f.sections, f.items, [
      entry({ bucket: 'STEEL', amountMinor: 100_000 }),
      entry({ bucket: 'MATS', amountMinor: 50_000 }),
    ]);
    expect(out.changes.map((c) => c.bucket).sort()).toEqual(['MATS', 'STEEL']);
    expect(out.deltaMinor).toBe(150_000);
  });
});

describe('the guard on a signed proposal', () => {
  it('allows all four freight buckets to move', () => {
    const before = versionTotals(fixture().items, fixture().sections);
    const after = {
      ...before,
      structureFreight: 1,
      matsFreight: 2,
      tpFreight: 3,
      stdFreight: 4,
      total: before.total + 10,
    };
    expect(() => assertFreightOnlyChange(before, after)).not.toThrow();
  });

  it('aborts when the subtotal, the discount, the tax or the cost of goods moves', () => {
    const before = versionTotals(fixture().items, fixture().sections);
    for (const field of ['subtotal', 'discount', 'tax', 'cogs'] as const) {
      expect(
        () => assertFreightOnlyChange(before, { ...before, [field]: before[field] + 1 }),
        field,
      ).toThrow(/may only change freight/i);
    }
  });

  it('names what moved, so the person reading it knows what to do instead', () => {
    const before = versionTotals(fixture().items, fixture().sections);
    expect(() => assertFreightOnlyChange(before, { ...before, tax: before.tax + 500 })).toThrow(
      /freight tax pass-through/i,
    );
  });
});

describe('evidence', () => {
  it('lets a zero through — nothing has been claimed', () => {
    expect(() =>
      assertEvidence({ bucket: 'THERAPEUTIC', scope: 'LINES', amountMinor: 0, source: 'MANUAL' }),
    ).not.toThrow();
  });

  it('demands a quote reference or an attachment for a hand-entered figure', () => {
    expect(() =>
      assertEvidence({
        bucket: 'THERAPEUTIC',
        scope: 'LINES',
        amountMinor: 100_000,
        source: 'MANUAL',
      }),
    ).toThrow(/vendor quote reference/i);
    expect(() =>
      assertEvidence({
        bucket: 'THERAPEUTIC',
        scope: 'LINES',
        amountMinor: 100_000,
        source: 'MANUAL',
        vendorQuoteRef: 'Q-88121',
      }),
    ).not.toThrow();
    expect(() =>
      assertEvidence({
        bucket: 'THERAPEUTIC',
        scope: 'LINES',
        amountMinor: 100_000,
        source: 'MANUAL',
        quoteAttachmentId: 'att_1',
      }),
    ).not.toThrow();
  });

  it('demands a reason when a board figure is typed in by hand', () => {
    expect(() =>
      assertEvidence({ bucket: 'STEEL', scope: 'JOB', amountMinor: 425_000, source: 'MANUAL' }),
    ).toThrow(/say why/i);
    expect(() =>
      assertEvidence({
        bucket: 'STEEL',
        scope: 'JOB',
        amountMinor: 425_000,
        source: 'MANUAL',
        overrideReason: 'Column empty; figure from the carrier quote',
      }),
    ).not.toThrow();
  });

  it('takes the board itself as the evidence when the figure was read from it', () => {
    expect(() =>
      assertEvidence({ bucket: 'MATS', scope: 'JOB', amountMinor: 80_000, source: 'MONDAY' }),
    ).not.toThrow();
  });

  it('demands a description on a job-level other charge, which prints on the estimate', () => {
    expect(() =>
      assertEvidence({
        bucket: 'OTHER',
        scope: 'JOB',
        amountMinor: 12_500,
        source: 'MANUAL',
        vendorQuoteRef: 'BOL-4471',
      }),
    ).toThrow(/what the other freight is for/i);
    expect(() =>
      assertEvidence({
        bucket: 'OTHER',
        scope: 'JOB',
        amountMinor: 12_500,
        source: 'MANUAL',
        vendorQuoteRef: 'BOL-4471',
        description: 'Redelivery after the site was not ready',
      }),
    ).not.toThrow();
  });
});

describe('what is outstanding', () => {
  it('treats an unquoted steel or mats figure as outstanding, not as zero', () => {
    const f = fixture();
    const gaps = freightGaps(f.items, f.sections);
    expect(gaps.buckets).toContain('STEEL');
    expect(gaps.buckets).toContain('MATS');
    expect(gaps.any).toBe(true);
  });

  it('does not chase other freight nobody switched on', () => {
    const f = fixture();
    expect(freightGaps(f.items, f.sections).buckets).not.toContain('OTHER');
  });

  it('chases other freight that was switched on and left at zero', () => {
    const f = fixture();
    (f.sections[0]!.data as Record<string, unknown>).stdFreightOn = true;
    expect(freightGaps(f.items, f.sections).buckets).toContain('OTHER');
  });

  it('only chases therapeutic freight on items whose vendor quotes it separately', () => {
    const f = fixture();
    const none = freightGaps(f.items, f.sections);
    expect(none.buckets).not.toContain('THERAPEUTIC');

    const some = freightGaps(f.items, f.sections, {
      freightQuotedSkus: new Set(['SP-SWING', 'SP-PAD']),
    });
    expect(some.buckets).toContain('THERAPEUTIC');
    expect(some.gapLines.map((l) => l.ref)).toEqual(['l1', 'l2']);
  });

  it('stops chasing a line once it carries freight', () => {
    const f = fixture();
    (f.items[0] as Record<string, unknown>).tpFreightMinor = 15_000;
    const gaps = freightGaps(f.items, f.sections, { freightQuotedSkus: new Set(['SP-SWING']) });
    expect(gaps.buckets).not.toContain('THERAPEUTIC');
  });

  it('says what is outstanding in words a person would use', () => {
    const f = fixture();
    const gaps = freightGaps(f.items, f.sections, { freightQuotedSkus: new Set(['SP-SWING']) });
    const text = describeGaps(gaps);
    expect(text).toContain('no steel freight');
    expect(text).toContain('1 item with no therapeutic freight');
  });
});

describe('board figures', () => {
  it('reads the shapes a board cell actually arrives in', () => {
    expect(parseBoardMoney('$4,250.00')).toBe(425_000);
    expect(parseBoardMoney('4250')).toBe(425_000);
    expect(parseBoardMoney(' 4,250.5 ')).toBe(425_050);
    expect(parseBoardMoney('4250.00 USD')).toBe(425_000);
  });

  it('reads an empty or unparseable cell as unanswered, not as zero', () => {
    for (const value of ['', '   ', null, undefined, 'TBD', 'see email', '-100']) {
      expect(parseBoardMoney(value as string | null), String(value)).toBeNull();
    }
  });

  it('reads a genuine zero as zero', () => {
    expect(parseBoardMoney('0')).toBe(0);
    expect(parseBoardMoney('$0.00')).toBe(0);
  });
});

describe('the alert and the clock', () => {
  it('escalates at five days', () => {
    expect(urgencyFor(0)).toBe('NEW');
    expect(urgencyFor(2)).toBe('AGEING');
    expect(urgencyFor(5)).toBe('ESCALATED');
    expect(urgencyFor(12)).toBe('ESCALATED');
  });

  it('stays quiet for a day after a dismissal, then speaks up again', () => {
    const now = new Date('2026-08-21T12:00:00Z');
    expect(alertIsQuiet(new Date('2026-08-21T11:00:00Z'), now)).toBe(true);
    expect(alertIsQuiet(new Date('2026-08-20T11:59:00Z'), now)).toBe(false);
    expect(alertIsQuiet(null, now)).toBe(false);
  });
});
