import { describe, it, expect } from 'vitest';
import { versionTotals, metaOf } from '../../src/proposals/analytics.js';

/**
 * The proposal meta block — the fields beside the line items.
 *
 * version-totals-integer.test.ts covers integer safety, the discount clamp and
 * standard freight. bundle-totals.test.ts covers the bundle rule. This file covers
 * what was left: the percentage discount path, the "TBD override" fields, and the
 * legacy freight column.
 *
 * All three matter for the same reason. versionTotals() writes the accepted price
 * snapshot, transactions.ts asserts the live total against that snapshot before it
 * will send a QuickBooks document, and every figure downstream agrees with whatever
 * it produced. A defect here does not fail loudly — it succeeds at billing the wrong
 * amount, which is what analytics.ts documents having happened twice.
 */
const meta = (data: Record<string, unknown>) => [{ id: 'meta', data }];
const line = (rateMinor: number, quantity = 1, extra: Record<string, unknown> = {}) => ({
  lineType: 'PRODUCT',
  quantity,
  rateMinor,
  ...extra,
});

describe('discount, by percentage', () => {
  it('applies discountPct when no mode is set — the legacy default', () => {
    const t = versionTotals([line(100_000)], meta({ discountPct: 10 }));
    expect(t.discount).toBe(10_000);
    expect(t.total).toBe(90_000);
  });

  it('reads PCT even when discountAmountMinor also happens to be set', () => {
    // A rep who switches the toggle from $ to % leaves the old amount behind. The
    // mode decides, not the presence of a value.
    const t = versionTotals(
      [line(100_000)],
      meta({ discountPct: 5, discountMode: 'PCT', discountAmountMinor: 90_000 }),
    );
    expect(t.discount).toBe(5_000);
  });

  it('reads AMT when the mode says so', () => {
    // The defect this guards: discountMode 'AMT' was ignored, so a dollar discount
    // counted as zero here while the customer's document deducted it in full. The
    // order, deposit and invoice all came out HIGHER than the signed proposal.
    const t = versionTotals(
      [line(100_000)],
      meta({ discountMode: 'AMT', discountAmountMinor: 15_000, discountPct: 0 }),
    );
    expect(t.discount).toBe(15_000);
    expect(t.total).toBe(85_000);
  });

  it('never produces a negative discount', () => {
    const t = versionTotals([line(100_000)], meta({ discountPct: -20 }));
    expect(t.discount).toBe(0);
  });

  it('rounds a fractional percentage to whole cents', () => {
    const t = versionTotals([line(33_333)], meta({ discountPct: 7.5 }));
    expect(Number.isInteger(t.discount)).toBe(true);
    expect(t.discount).toBe(2_500);
  });
});

describe('TBD override fields', () => {
  /*
   * Each amount box has a companion text field that prints instead of "TBD". It takes
   * wording, but it sits beside the amount and people type figures into it. The rule:
   * a plain number there is money and counts toward the total; anything else is
   * wording and contributes nothing.
   */
  it('counts a bare number typed into the override', () => {
    const t = versionTotals([line(100_000)], meta({ tbdStructureFreight: '1250' }));
    expect(t.structureFreight).toBe(125_000);
    expect(t.total).toBe(225_000);
  });

  it('accepts a typed dollar sign and thousands separators', () => {
    const t = versionTotals([line(100_000)], meta({ tbdTax: '$1,250.50' }));
    expect(t.tax).toBe(125_050);
  });

  it('treats wording as wording, not money', () => {
    for (const wording of ['TBD', 'To be determined', 'quoted at shipment', 'call Bryan', '']) {
      const t = versionTotals([line(100_000)], meta({ tbdMatsFreight: wording }));
      expect(t.matsFreight).toBe(0);
      expect(t.total).toBe(100_000);
    }
  });

  it('prefers the real amount over the override when both are present', () => {
    const t = versionTotals(
      [line(100_000)],
      meta({ matsFreightMinor: 50_000, tbdMatsFreight: '9999' }),
    );
    expect(t.matsFreight).toBe(50_000);
  });

  it('handles a typed zero as an explicit zero, not as absent', () => {
    // "Type 0 in the box to print USD $0.00 instead of TBD" — the builder says this
    // out loud, so 0 must be a legitimate value rather than a falsy one.
    const t = versionTotals([line(100_000)], meta({ tbdStructureFreight: '0' }));
    expect(t.structureFreight).toBe(0);
  });
});

describe('legacy freight column', () => {
  it('falls back to freightMinor when structureFreightMinor is absent', () => {
    // Proposals written before crating and mats freight were split still carry the
    // single freightMinor column. They must keep totalling what they always did.
    const t = versionTotals([line(100_000)], meta({ freightMinor: 30_000 }));
    expect(t.structureFreight).toBe(30_000);
    expect(t.total).toBe(130_000);
  });

  it('prefers structureFreightMinor once it exists, even when zero', () => {
    const t = versionTotals(
      [line(100_000)],
      meta({ structureFreightMinor: 0, freightMinor: 30_000 }),
    );
    expect(t.structureFreight).toBe(0);
  });
});

describe('margin', () => {
  it('excludes freight and tax from revenue but includes third-party freight', () => {
    const t = versionTotals(
      [line(100_000, 1, { costEach: 60_000, tpFreightMinor: 10_000 })],
      meta({ taxAmountMinor: 5_000, structureFreightMinor: 20_000 }),
    );
    expect(t.revenue).toBe(110_000);
    expect(t.cogs).toBe(60_000);
    expect(t.margin).toBe(50_000);
    expect(t.marginPct).toBe(45.5);
    expect(t.total).toBe(135_000);
  });

  it('reports zero margin percent rather than dividing by zero', () => {
    const t = versionTotals([line(0)], meta({}));
    expect(t.marginPct).toBe(0);
  });
});

describe('metaOf', () => {
  it('survives every shape a stored section list has taken', () => {
    expect(metaOf(null)).toEqual({});
    expect(metaOf([])).toEqual({});
    expect(metaOf([{ id: 'other', data: { discountPct: 5 } }])).toEqual({});
    expect(metaOf([{ id: 'meta' }])).toEqual({});
    expect(metaOf([{ id: 'meta', data: null }])).toEqual({});
    expect(metaOf([{ id: 'meta', data: { discountPct: 5 } }])).toEqual({ discountPct: 5 });
  });
});
