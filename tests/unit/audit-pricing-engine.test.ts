import { describe, it, expect } from 'vitest';
import { computePricing, type PricingInput } from '../../src/pricing/engine.js';
import { applyRate, divRound, type RoundingMode } from '../../src/pricing/decimal.js';

/**
 * Audit: src/pricing/engine.ts (computePricing) — edge cases the existing
 * pricing-engine.test.ts does not reach. Passing tests pin behaviour that is correct;
 * `it.fails` tests document confirmed defects (they pass while the bug exists and
 * will start failing — loudly — once it is fixed, at which point flip them to `it`).
 */

const line = (
  over: Partial<PricingInput['lines'][number]> = {},
): PricingInput['lines'][number] => ({
  ref: 'L1',
  productId: 'P1',
  quantity: 1,
  unitPrice: 10000n,
  unitCost: 6000n,
  priceSource: 'price-list',
  ...over,
});

/** Deterministic PRNG so the property checks are reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('computePricing — invariants (PASS)', () => {
  it('grandTotal = goodsNet + fees + tax + card fee, and the payment split sums exactly, across 500 random quotes', () => {
    const r = prng(42);
    const int = (max: number) => Math.floor(r() * max);
    for (let i = 0; i < 500; i++) {
      const lines = Array.from({ length: 1 + int(5) }, (_, k) =>
        line({
          ref: `L${k}`,
          quantity: 1 + int(20),
          unitPrice: BigInt(int(500_000)),
          unitCost: BigInt(int(300_000)),
          lineDiscountBps: int(2500),
        }),
      );
      const dep = int(6000);
      const prog = int(10000 - dep);
      const out = computePricing({
        currency: 'USD',
        lines,
        orderDiscounts: [{ bps: int(1500), reason: 'r' }],
        fees: {
          freight: { amount: BigInt(int(100_000)), confirmed: true },
          travel: { amount: BigInt(int(50_000)), confirmed: true },
          creditCardBps: int(400),
        },
        tax: { rateBps: int(1100), exempt: false },
        payment: { depositBps: dep, progressBps: prog, finalBps: 10000 - dep - prog },
      });
      expect(out.grandTotal).toBe(out.goodsNet + out.feesTotal + out.tax + out.creditCardFee);
      expect(out.payment.deposit + out.payment.progress + out.payment.final).toBe(out.grandTotal);
      expect(out.subtotal).toBe(out.lines.reduce((a, l) => a + (l.net ?? 0n), 0n));
      expect(out.findings.filter((f) => f.code === 'CONFIG_ERROR')).toHaveLength(0);
      for (const v of [out.subtotal, out.tax, out.grandTotal, out.creditCardFee])
        expect(typeof v).toBe('bigint');
    }
  });

  it('honours a per-level rounding override (HALF_EVEN tax) without touching other levels', () => {
    // 1012 × 1250 bps = 126.5 cents exactly → HALF_UP 127, HALF_EVEN 126.
    const base = computePricing({
      currency: 'USD',
      lines: [line({ unitPrice: 1012n, unitCost: 0n })],
      tax: { rateBps: 1250, exempt: false },
    });
    const even = computePricing({
      currency: 'USD',
      lines: [line({ unitPrice: 1012n, unitCost: 0n })],
      tax: { rateBps: 1250, exempt: false },
      rounding: { tax: 'HALF_EVEN' },
    });
    expect(base.tax).toBe(127n);
    expect(even.tax).toBe(126n);
  });

  it('a zero-quantity line contributes nothing and has no margin percentage (no divide-by-zero)', () => {
    const out = computePricing({ currency: 'USD', lines: [line({ quantity: 0 })] });
    expect(out.subtotal).toBe(0n);
    expect(out.lines[0]!.marginBps).toBeNull();
    expect(out.marginBps).toBeNull();
  });

  it('a missing unit cost leaves total cost/margin null and never raises a margin approval', () => {
    const out = computePricing({
      currency: 'USD',
      lines: [line({ unitCost: null })],
      thresholds: { minMarginBps: 9999 },
    });
    expect(out.totalCost).toBeNull();
    expect(out.totalMargin).toBeNull();
    expect(out.requiresApproval).toBe(false);
  });

  it('a missing price is excluded from the subtotal but marks the quote incomplete', () => {
    const out = computePricing({
      currency: 'USD',
      lines: [line(), line({ ref: 'L2', unitPrice: null })],
    });
    expect(out.subtotal).toBe(10000n);
    expect(out.incomplete).toBe(true);
  });

  it('tax-exempt still reports the taxable base but charges 0', () => {
    const out = computePricing({
      currency: 'USD',
      lines: [line()],
      tax: { rateBps: 800, exempt: true, exemptionRef: 'EX-1' },
    });
    expect(out.tax).toBe(0n);
    expect(out.taxableBase).toBe(10000n);
    expect(out.findings).toHaveLength(0);
  });
});

describe('decimal.divRound — agrees with exact rational rounding (PASS)', () => {
  it('matches a reference implementation for every mode, sign and remainder in a grid', () => {
    const modes: RoundingMode[] = ['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP'];
    const ref = (num: number, den: number, mode: RoundingMode): number => {
      const sign = Math.sign(num) * Math.sign(den);
      const a = Math.abs(num),
        b = Math.abs(den);
      const q = Math.floor(a / b),
        rem = a - q * b;
      let up = false;
      if (rem !== 0) {
        if (mode === 'UP') up = true;
        else if (mode === 'HALF_UP') up = 2 * rem >= b;
        else if (mode === 'HALF_EVEN') up = 2 * rem > b || (2 * rem === b && q % 2 === 1);
      }
      const mag = up ? q + 1 : q;
      return sign < 0 && mag !== 0 ? -mag : mag;
    };
    for (const mode of modes)
      for (let num = -60; num <= 60; num++)
        for (const den of [-7, -4, -2, 1, 2, 3, 4, 10]) {
          const got = Number(divRound(BigInt(num), BigInt(den), mode));
          expect(got === 0 ? 0 : got, `${num}/${den} ${mode}`).toBe(ref(num, den, mode));
        }
  });

  it('applyRate is symmetric for negative amounts (credits round like debits)', () => {
    expect(applyRate(-1005n, 1000, 'HALF_UP')).toBe(-applyRate(1005n, 1000, 'HALF_UP'));
  });
});

describe('computePricing — confirmed defects (it.fails)', () => {
  it.fails(
    'BUG: fractional mileage (12.5 mi, allowed by the /pricing/quote schema) is priced, not a RangeError crash',
    () => {
      // engine.ts: `f.mileage.ratePerMile * BigInt(f.mileage.miles)` — BigInt(12.5) throws.
      const out = computePricing({
        currency: 'USD',
        lines: [line()],
        fees: { mileage: { miles: 12.5, ratePerMile: 70n, confirmed: true } },
      });
      expect(out.fees.mileage?.amount).toBe(875n);
    },
  );

  it.fails('BUG: line-level discounts are not counted against the discount authority', () => {
    // A 50% line discount with a 10% authority ceiling sails through: the authority
    // check only looks at orderDiscount, never at lines[].discount.
    const out = computePricing({
      currency: 'USD',
      lines: [line({ lineDiscountBps: 5000 })],
      thresholds: { discountAuthorityBps: 1000 },
    });
    expect(out.requiresApproval).toBe(true);
  });

  it.fails(
    'BUG: discount authority truncates the effective bps, so 10.09% passes a 10.00% ceiling',
    () => {
      // effBps = Number((10009n * 10000n) / 100000n) = 1000 (truncated from 1000.9).
      const out = computePricing({
        currency: 'USD',
        lines: [line({ unitPrice: 100000n })],
        orderDiscounts: [{ amount: 10009n, reason: 'loyalty' }],
        thresholds: { discountAuthorityBps: 1000 },
      });
      expect(out.requiresApproval).toBe(true);
    },
  );

  it.fails(
    'BUG: selling below cost is not flagged when minMarginBps is 0 (negative margin truncates to 0 bps)',
    () => {
      // net 300.00, cost 300.01 → margin −1 cent → (−1·10000)/30000 truncates toward zero → 0 bps.
      const out = computePricing({
        currency: 'USD',
        lines: [line({ unitPrice: 30000n, unitCost: 30001n })],
        thresholds: { minMarginBps: 0 },
      });
      expect(out.totalMargin).toBe(-1n);
      expect(out.requiresApproval).toBe(true);
    },
  );

  it.fails(
    'BUG: an order discount larger than the subtotal drives goods and tax negative with no finding',
    () => {
      const out = computePricing({
        currency: 'USD',
        lines: [line({ unitPrice: 10000n })],
        orderDiscounts: [{ amount: 25000n, reason: 'typo' }],
        tax: { rateBps: 800, exempt: false },
      });
      // Either clamp (like versionTotals' discountOf does) or raise a finding.
      const flagged = out.findings.some((f) => f.field?.startsWith('orderDiscount'));
      expect(out.goodsNet >= 0n || flagged).toBe(true);
      expect(out.tax >= 0n).toBe(true);
    },
  );

  it.fails(
    'BUG: a line discount above 100% (lineDiscountBps > 10000, accepted by the route schema) makes a negative line with no finding',
    () => {
      const out = computePricing({ currency: 'USD', lines: [line({ lineDiscountBps: 15000 })] });
      const flagged = out.findings.length > 0;
      expect((out.lines[0]!.net ?? 0n) >= 0n || flagged).toBe(true);
    },
  );

  it.fails(
    'BUG: an "other" fee marked confirmed:false is flagged unconfirmed on the fee but raises no UNCONFIRMED finding',
    () => {
      const out = computePricing({
        currency: 'USD',
        lines: [line()],
        fees: { other: [{ label: 'crane', amount: 50000n, confirmed: false }] },
      });
      expect(out.fees['other:crane']?.unconfirmed).toBe(true);
      expect(out.findings.some((f) => f.code === 'UNCONFIRMED')).toBe(true);
    },
  );
});
