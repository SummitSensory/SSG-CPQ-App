import { describe, it, expect } from 'vitest';
import { computePricing, type PricingInput } from '../../src/pricing/engine.js';

const base = (over = {}) => ({ currency: 'USD', lines: [{ ref: 'L1', productId: 'A', quantity: 2, unitPrice: 10000n, unitCost: 6000n, priceSource: 'price-list' }], ...over } as PricingInput);

describe('pricing engine', () => {
  it('computes a simple line net and subtotal', () => {
    const r = computePricing(base());
    expect(r.subtotal).toBe(20000n);
    expect(r.grandTotal).toBe(20000n);
  });

  it('NEVER coerces a missing price to zero — flags MISSING_VALUE and incomplete', () => {
    const r = computePricing(base({ lines: [{ ref: 'L1', productId: 'A', quantity: 1, unitPrice: null, unitCost: null, priceSource: 'unresolved' }] }));
    expect(r.incomplete).toBe(true);
    expect(r.findings.some((f) => f.code === 'MISSING_VALUE')).toBe(true);
    expect(r.lines[0].net).toBeNull();
  });

  it('flags UNCONFIRMED freight and installation clearly', () => {
    const r = computePricing(base({ fees: { freight: { amount: 5000n, confirmed: false }, installation: { amount: 3000n, confirmed: true } } }));
    expect(r.fees.freight.unconfirmed).toBe(true);
    expect(r.fees.installation.unconfirmed).toBe(false);
    expect(r.findings.some((f) => f.code === 'UNCONFIRMED' && f.field === 'fee.freight')).toBe(true);
  });

  it('requires approval when discount exceeds authority', () => {
    const r = computePricing(base({ orderDiscounts: [{ bps: 2000, reason: 'volume' }], thresholds: { discountAuthorityBps: 1000 } }));
    expect(r.requiresApproval).toBe(true);
  });

  it('requires approval when margin below threshold', () => {
    const r = computePricing(base({ thresholds: { minMarginBps: 5000 } })); // margin 40% < 50%
    expect(r.marginBps).toBe(4000);
    expect(r.requiresApproval).toBe(true);
  });

  it('applies tax on goods + taxable fees and explains it', () => {
    const r = computePricing(base({ fees: { freight: { amount: 0n, confirmed: true } }, tax: { rateBps: 825, exempt: false } }));
    expect(r.tax).toBe(1650n); // 8.25% of 20000
    expect(r.explanations.some((e) => e.includes('Tax'))).toBe(true);
  });

  it('honors tax exemption but flags a missing exemption ref', () => {
    const r = computePricing(base({ tax: { rateBps: 825, exempt: true } }));
    expect(r.tax).toBe(0n);
    expect(r.findings.some((f) => f.code === 'TAX_EXEMPT_NO_REF')).toBe(true);
  });

  it('credit-card fee computed on goods+fees+tax', () => {
    const r = computePricing(base({ tax: { rateBps: 0, exempt: false }, fees: { creditCardBps: 300 } }));
    expect(r.creditCardFee).toBe(600n); // 3% of 20000
    expect(r.grandTotal).toBe(20600n);
  });

  it('payment schedule: final absorbs rounding residual so splits sum exactly', () => {
    // grandTotal 20000, thirds -> 6666 + 6667(progress) ... final = remainder
    const r = computePricing(base({ payment: { depositBps: 3333, progressBps: 3333, finalBps: 3334 } }));
    expect(r.payment.deposit + r.payment.progress + r.payment.final).toBe(r.grandTotal);
  });

  it('flags a payment schedule that does not sum to 100%', () => {
    const r = computePricing(base({ payment: { depositBps: 5000, progressBps: 3000, finalBps: 1000 } }));
    expect(r.findings.some((f) => f.code === 'CONFIG_ERROR' && f.field === 'payment')).toBe(true);
  });

  it('explains every line', () => {
    const r = computePricing(base());
    expect(r.lines[0].explanation.length).toBeGreaterThan(0);
  });
});
