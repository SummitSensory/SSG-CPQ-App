import { describe, it, expect } from 'vitest';
import { versionTotals } from '../../src/proposals/analytics.js';

/**
 * PROPOSAL-009 — proposal money is an integer number of cents by contract, but the
 * contract was enforced only in the browser, and the totals were accumulated in
 * floating point. A sub-cent residue reaches PriceSnapshot.grandTotal and then blocks
 * a QuickBooks document, because transactions.ts asserts the live total against the
 * frozen one.
 */
describe('versionTotals integer safety', () => {
  it('produces whole minor units even from legacy fractional rows', () => {
    const items = [
      { lineType: 'PRODUCT', quantity: 3, rateMinor: 10.1 },
      { lineType: 'PRODUCT', quantity: 7, rateMinor: 0.2 },
      { lineType: 'PRODUCT', quantity: 1, rateMinor: 0.3, costEach: 0.1, tpFreightMinor: 0.7 },
    ];
    const t = versionTotals(items, [{ id: 'meta', data: {} }]);
    for (const value of [t.subtotal, t.cogs, t.tpFreight, t.tax, t.total, t.revenue]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('keeps ordinary integer arithmetic exact', () => {
    const items = [
      { lineType: 'PRODUCT', quantity: 2, rateMinor: 250_000, costEach: 100_000, weightEach: 12 },
      { lineType: 'PRODUCT', quantity: 1, rateMinor: 125_50 },
      { lineType: 'NOTE', quantity: 0, rateMinor: 0 },
    ];
    const t = versionTotals(items, [{ id: 'meta', data: { taxAmountMinor: 1_000 } }]);
    expect(t.subtotal).toBe(512_550);
    expect(t.total).toBe(513_550);
    expect(t.cogs).toBe(200_000);
    expect(t.weight).toBe(24);
  });

  it('clamps a discount to the subtotal rather than going negative', () => {
    const items = [{ lineType: 'PRODUCT', quantity: 1, rateMinor: 10_000 }];
    const t = versionTotals(items, [
      { id: 'meta', data: { discountMode: 'AMT', discountAmountMinor: 999_999 } },
    ]);
    expect(t.discount).toBe(10_000);
    expect(t.total).toBe(0);
  });

  it('counts standard freight only while its box is ticked', () => {
    const items = [{ lineType: 'PRODUCT', quantity: 1, rateMinor: 10_000 }];
    const off = versionTotals(items, [{ id: 'meta', data: { stdFreightMinor: 5_000 } }]);
    const on = versionTotals(items, [
      { id: 'meta', data: { stdFreightMinor: 5_000, stdFreightOn: true } },
    ]);
    expect(off.total).toBe(10_000);
    expect(on.total).toBe(15_000);
  });
});
