import { describe, it, expect } from 'vitest';
import { upchargeFromAnswers } from '../../src/portal/colorUpchargeAnswers.js';
import {
  upchargeStatus,
  upchargeLineDescription,
  upchargeDocNumber,
  withUpchargeLines,
} from '../../src/integrations/quickbooks/colorUpcharge.js';
import {
  isSupplementInvoice,
  isFreightSupplement,
} from '../../src/integrations/quickbooks/freightInvoiced.js';
import { unlinkedUpchargesOf, type MfgRow } from '../../src/portal/orderPortal.js';

describe('upchargeFromAnswers — the portal snapshot', () => {
  it('reads a confirmed total in dollars into minor units, and counts distinct Prismatic colors', () => {
    const u = upchargeFromAnswers({
      selections: {
        structure_frame_paint: {
          legs: { brand: 'prismatic', code: 'PRB-1' },
          horizontal_beams: { brand: 'prismatic', code: 'PRB-1' },
          ladder_rungs_and_leg: { brand: 'cardinal', code: 'T009' },
        },
        climbing_wall_color: { climbing_wall: { brand: 'prismatic', code: 'PRB-2' } },
      },
      totalUpcharge: 800,
      confirmedAt: '2026-10-21T15:00:00.000Z',
    });
    expect(u).toEqual({
      confirmed: true,
      confirmedAt: '2026-10-21T15:00:00.000Z',
      totalMinor: 80_000n,
      prismaticColors: 2,
    });
  });

  it('a draft is not confirmed, and unreadable or absurd figures are not figures', () => {
    expect(upchargeFromAnswers({ totalUpcharge: 500, confirmedAt: null }).confirmed).toBe(false);
    expect(upchargeFromAnswers({ totalUpcharge: '500', confirmedAt: 'x' }).totalMinor).toBeNull();
    expect(upchargeFromAnswers({ totalUpcharge: -5, confirmedAt: 'x' }).totalMinor).toBeNull();
    expect(upchargeFromAnswers({ totalUpcharge: 5e9, confirmedAt: 'x' }).totalMinor).toBeNull();
    expect(upchargeFromAnswers(null).confirmed).toBe(false);
    expect(upchargeFromAnswers({ text: 'garbage' }).totalMinor).toBeNull();
  });
});

describe('upchargeStatus', () => {
  it('compares what the portal says with what was billed', () => {
    expect(upchargeStatus(80_000n, 0n, true)).toBe('TO_BILL');
    expect(upchargeStatus(80_000n, 80_000n, true)).toBe('BILLED');
    expect(upchargeStatus(50_000n, 80_000n, true)).toBe('TO_REDUCE');
    expect(upchargeStatus(0n, 0n, true)).toBe('NONE');
    expect(upchargeStatus(80_000n, 0n, false)).toBe('UNCONFIRMED');
  });
});

describe('invoice rows', () => {
  const product = {
    Id: '1',
    DetailType: 'SalesItemLineDetail',
    Amount: 20000,
    Description: 'Adventure Series',
  };
  const ours = (amount: number) => ({
    DetailType: 'SalesItemLineDetail',
    Amount: amount,
    Description: upchargeLineDescription('SO-7', 2),
  });

  it('names the order on the row, so the CRM can recognise its own', () => {
    expect(upchargeLineDescription('SO-7', 1)).toBe(
      'Prismatic paint color upcharge — 1 Prismatic color chosen in the customer portal (order SO-7)',
    );
  });

  it('replaces only its own row and passes every other line back untouched', () => {
    const lines = withUpchargeLines([product, ours(800)], 'SO-7', 110_000n, 3);
    expect(lines[0]).toBe(product);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ Amount: 1100 });
  });

  it('removes its row at zero, and never touches another order’s row', () => {
    const other = {
      DetailType: 'SalesItemLineDetail',
      Amount: 500,
      Description: upchargeLineDescription('SO-8', 1),
    };
    expect(withUpchargeLines([product, other, ours(800)], 'SO-7', 0n, 0)).toEqual([product, other]);
  });

  it('refuses an invoice with no lines rather than emptying it', () => {
    expect(() => withUpchargeLines([], 'SO-7', 800n, 1)).toThrow(/no lines/);
  });

  it('numbers upcharge-only invoices after the proposal', () => {
    expect(upchargeDocNumber('P-2026-0117', 1)).toBe('P-2026-0117-CLR');
    expect(upchargeDocNumber('P-2026-0117', 2)).toBe('P-2026-0117-CLR2');
  });
});

describe('isSupplementInvoice — what is never the job’s main invoice', () => {
  it('covers freight-only and upcharge-only invoices, and nothing else', () => {
    expect(isSupplementInvoice({ kind: 'FREIGHT_SUPPLEMENT' })).toBe(true);
    expect(isSupplementInvoice({ kind: 'COLOR_UPCHARGE_SUPPLEMENT' })).toBe(true);
    expect(isSupplementInvoice({ priceSnapshotId: 'x' })).toBe(false);
    expect(isSupplementInvoice(null)).toBe(false);
    expect(isFreightSupplement({ kind: 'COLOR_UPCHARGE_SUPPLEMENT' })).toBe(false);
  });
});

describe('unlinkedUpchargesOf — upcharges the CRM cannot bill until the row is linked', () => {
  const row = (id: string, answers: unknown): MfgRow => ({
    id,
    name: `Job ${id}`,
    dealIds: [],
    labels: { DELIVERY: '', COLOR: '✅', BILLING: '', CONTACT: '', REQUIRED: '' },
    answers: { DELIVERY: null, COLOR: answers, BILLING: null, CONTACT: null, REQUIRED: null },
  });
  const now = new Date('2026-10-21T00:00:00Z');

  it('lists recent confirmed upcharges on unlinked rows only', () => {
    const rows = [
      row('1', { totalUpcharge: 500, confirmedAt: '2026-10-20T00:00:00Z' }), // linked
      row('2', { totalUpcharge: 800, confirmedAt: '2026-10-19T00:00:00Z' }), // listed
      row('3', { totalUpcharge: 0, confirmedAt: '2026-10-19T00:00:00Z' }), // no upcharge
      row('4', { totalUpcharge: 500, confirmedAt: null }), // draft
      row('5', { totalUpcharge: 500, confirmedAt: '2026-08-01T00:00:00Z' }), // too old
    ];
    const linked = new Map([['order-a', rows[0]!]]);
    expect(unlinkedUpchargesOf(rows, linked, now)).toEqual([
      {
        mondayItemId: '2',
        name: 'Job 2',
        totalMinor: '80000',
        confirmedAt: '2026-10-19T00:00:00Z',
      },
    ]);
  });
});
