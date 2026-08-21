import { describe, expect, it } from 'vitest';
import { versionTotals } from '../../src/proposals/analytics.js';
import { auditPriceEntry } from '../../src/proposals/priceEntry.js';

/**
 * A bundle is one priced line followed by its component rows. The components are
 * written zero-rate — they carry the part numbers, costs and weights for the BOM
 * while the customer sees the parent's single price.
 *
 * When rates land on the components as well, summing every row counted the bundle
 * twice: the Obie Pro bundle priced at $11,268.45 totalled $22,536.90 on the section
 * header, in the totals panel and on the printed proposal, and that figure reached
 * the price snapshot and QuickBooks.
 *
 * The numbers below are the real ones from that proposal.
 */
const meta = [{ id: 'meta', data: {} }];

const bundle = [
  { lineType: 'GROUP', name: 'OBIE PRO INTERACTIVE PROJECTION SYSTEM - PEDIATRIC BUNDLE' },
  {
    lineType: 'PRODUCT',
    sku: 'OBIE-BUNDLE',
    name: 'Obie Pro Interactive Projection System - Pediatric Bundle',
    quantity: 1,
    rateMinor: 1_126_845,
    costEach: 0,
  },
  {
    lineType: 'PRODUCT',
    sku: '901240',
    name: '\u2014 Obie Mobile Cart',
    quantity: 1,
    rateMinor: 337_500,
    costEach: 250_000,
  },
  {
    lineType: 'PRODUCT',
    sku: 'WG0267',
    name: '\u2014 Obie Pro Interactive Projection System - Pediatric Game Bundle',
    quantity: 1,
    rateMinor: 776_250,
    costEach: 575_000,
  },
  {
    lineType: 'PRODUCT',
    sku: '901238',
    name: '\u2014 Obie Drop Ceiling Kit',
    quantity: 1,
    rateMinor: 13_095,
    costEach: 9_700,
  },
];

describe('bundle revenue is counted once', () => {
  it('takes the parent price and ignores rates on the components', () => {
    const t = versionTotals(bundle, meta);
    expect(t.subtotal).toBe(1_126_845);
    expect(t.total).toBe(1_126_845);
  });

  it('still sums cost across the components, where the real cost lives', () => {
    // 2,500.00 + 5,750.00 + 97.00 — the parent carries no cost.
    expect(versionTotals(bundle, meta).cogs).toBe(834_700);
  });

  it('lets the components carry the price when the parent is zero', () => {
    const parentZero = bundle.map((l) => (l.sku === 'OBIE-BUNDLE' ? { ...l, rateMinor: 0 } : l));
    expect(versionTotals(parentZero, meta).subtotal).toBe(1_126_845);
  });

  it('is zero when neither the parent nor the components are priced', () => {
    const nothing = bundle.map((l) =>
      (l.lineType ?? 'PRODUCT') === 'PRODUCT' ? { ...l, rateMinor: 0 } : l,
    );
    expect(versionTotals(nothing, meta).subtotal).toBe(0);
  });
});

describe('lines that are not bundles', () => {
  it('sums ordinary lines exactly as before', () => {
    const items = [
      { lineType: 'PRODUCT', name: 'Cuddle Swing', quantity: 1, rateMinor: 33_941 },
      { lineType: 'PRODUCT', name: 'Rainbow Acrobat Swing', quantity: 2, rateMinor: 74_060 },
    ];
    expect(versionTotals(items, meta).subtotal).toBe(33_941 + 148_120);
  });

  it('counts a component row that has no parent above it', () => {
    // A data error, but the row has nothing to double with, so dropping it would
    // silently lose revenue.
    const items = [
      { lineType: 'PRODUCT', name: '\u2014 Orphaned component', quantity: 1, rateMinor: 50_000 },
    ];
    expect(versionTotals(items, meta).subtotal).toBe(50_000);
  });

  it('ends the bundle at a heading, so the next section is not absorbed', () => {
    const items = [
      { lineType: 'PRODUCT', name: 'Kit', quantity: 1, rateMinor: 100_000 },
      { lineType: 'PRODUCT', name: '\u2014 Part', quantity: 1, rateMinor: 40_000 },
      { lineType: 'GROUP', name: 'HARDWARE' },
      { lineType: 'PRODUCT', name: 'Hardware Kit', quantity: 1, rateMinor: 13_095 },
    ];
    expect(versionTotals(items, meta).subtotal).toBe(113_095);
  });

  it('handles two bundles in a row', () => {
    const items = [
      { lineType: 'PRODUCT', name: 'Kit A', quantity: 1, rateMinor: 100_000 },
      { lineType: 'PRODUCT', name: '\u2014 A1', quantity: 1, rateMinor: 60_000 },
      { lineType: 'PRODUCT', name: '\u2014 A2', quantity: 1, rateMinor: 40_000 },
      { lineType: 'PRODUCT', name: 'Kit B', quantity: 1, rateMinor: 0 },
      { lineType: 'PRODUCT', name: '\u2014 B1', quantity: 1, rateMinor: 25_000 },
    ];
    // Kit A's own price, then Kit B's components because Kit B is unpriced.
    expect(versionTotals(items, meta).subtotal).toBe(125_000);
  });

  it('does not treat a hyphen or an en dash as a component marker', () => {
    const items = [
      { lineType: 'PRODUCT', name: 'Kit', quantity: 1, rateMinor: 100_000 },
      { lineType: 'PRODUCT', name: '- Not a component', quantity: 1, rateMinor: 10_000 },
      { lineType: 'PRODUCT', name: '\u2013 Nor this one', quantity: 1, rateMinor: 20_000 },
    ];
    expect(versionTotals(items, meta).subtotal).toBe(130_000);
  });
});

describe('the discount still applies to the corrected subtotal', () => {
  it('takes the percentage off the once-counted bundle, not the doubled one', () => {
    const t = versionTotals(bundle, [{ id: 'meta', data: { discountPct: 10 } }]);
    expect(t.subtotal).toBe(1_126_845);
    expect(t.discount).toBe(112_685); // 10% of 1,126,845, rounded
    expect(t.total).toBe(1_014_160);
  });
});

/**
 * The cause, not the symptom.
 *
 * The release gate demanded a price or a reason for three $0.00 lines that were the
 * bundle's components. The only way through it is to type rates into them, which is
 * what doubled the bundle. The gate must not ask.
 */
describe('the price gate and bundle components', () => {
  const withZeroComponents = [
    {
      ref: 'p',
      lineType: 'PRODUCT',
      sku: 'OBIE-BUNDLE',
      name: 'Obie Pro Bundle',
      quantity: 1,
      rateMinor: 1_126_845,
    },
    {
      ref: 'c1',
      lineType: 'PRODUCT',
      sku: '901240',
      name: '\u2014 Obie Mobile Cart',
      quantity: 1,
      rateMinor: 0,
    },
    {
      ref: 'c2',
      lineType: 'PRODUCT',
      sku: 'WG0267',
      name: '\u2014 Obie Pro Pediatric Game Bundle',
      quantity: 1,
      rateMinor: 0,
    },
    {
      ref: 'c3',
      lineType: 'PRODUCT',
      sku: '901238',
      name: '\u2014 Obie Drop Ceiling Kit',
      quantity: 1,
      rateMinor: 0,
    },
  ];

  it('does not ask for a reason for a zero-rate component', () => {
    const audit = auditPriceEntry(withZeroComponents);
    expect(audit.zeroWithoutReason).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('does not ask for a price on a component with no rate at all', () => {
    const audit = auditPriceEntry([
      { ref: 'p', lineType: 'PRODUCT', name: 'Kit', quantity: 1, rateMinor: 100_000 },
      { ref: 'c', lineType: 'PRODUCT', name: '\u2014 Part', quantity: 1 },
    ]);
    expect(audit.awaiting).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('still blocks a real product line left at zero with no reason', () => {
    const audit = auditPriceEntry([
      { ref: 'a', lineType: 'PRODUCT', name: 'Cuddle Swing', quantity: 1, rateMinor: 0 },
    ]);
    expect(audit.zeroWithoutReason).toHaveLength(1);
    expect(audit.ok).toBe(false);
  });

  it('still blocks a real product line with no price entered', () => {
    const audit = auditPriceEntry([
      { ref: 'a', lineType: 'PRODUCT', name: 'Cuddle Swing', quantity: 1 },
    ]);
    expect(audit.awaiting).toHaveLength(1);
    expect(audit.ok).toBe(false);
  });

  it('still blocks an unpriced bundle PARENT', () => {
    // The parent is where the price belongs, so this one must be caught.
    const audit = auditPriceEntry([
      { ref: 'p', lineType: 'PRODUCT', name: 'Obie Pro Bundle', quantity: 1, rateMinor: 0 },
      { ref: 'c', lineType: 'PRODUCT', name: '\u2014 Obie Mobile Cart', quantity: 1, rateMinor: 0 },
    ]);
    expect(audit.zeroWithoutReason.map((i) => i.ref)).toEqual(['p']);
  });
});
