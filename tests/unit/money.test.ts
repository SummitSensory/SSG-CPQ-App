import { describe, it, expect } from 'vitest';
import { Money, priceForMarginMinor } from '../../src/lib/money.js';

describe('Money (integer minor units)', () => {
  it('parses decimal strings without float error', () => {
    expect(Money.parse('19.99', 'USD').toString()).toBe('19.99 USD');
  });
  it('adds without floating-point drift', () => {
    const total = Money.parse('0.10', 'USD').add(Money.parse('0.20', 'USD'));
    expect(total.toString()).toBe('0.30 USD'); // 0.1 + 0.2 !== 0.3 in floats
  });
  it('rejects mismatched currencies', () => {
    expect(() => Money.parse('1.00', 'USD').add(Money.parse('1.00', 'EUR'))).toThrow();
  });
  it('rejects malformed amounts', () => {
    expect(() => Money.parse('1.999', 'USD')).toThrow();
  });
});

describe('priceForMarginMinor (gross margin, not markup)', () => {
  it('prices a $60.00 cost at 40% margin at $100.00', () => {
    expect(priceForMarginMinor(6000, 40)).toBe(10000n);
  });
  it('rounds half-up to the cent', () => {
    // 1234 / 0.65 = 1898.4615…
    expect(priceForMarginMinor(1234, 35)).toBe(1898n);
    // 100 / 0.7 = 142.857… → 143
    expect(priceForMarginMinor(100, 30)).toBe(143n);
    // 1 / 0.5 = 2 exactly
    expect(priceForMarginMinor(1, 50)).toBe(2n);
  });
  it('takes the margin to two decimals', () => {
    // 10000 / (1 - 0.3333) = 14999.25…
    expect(priceForMarginMinor(10000, 33.33)).toBe(14999n);
  });
  it('0% margin is the cost', () => {
    expect(priceForMarginMinor(4321, 0)).toBe(4321n);
  });
  it('refuses 100% or more, a negative margin, and a negative cost', () => {
    expect(() => priceForMarginMinor(100, 100)).toThrow();
    expect(() => priceForMarginMinor(100, 99.999)).toThrow();
    expect(() => priceForMarginMinor(100, -1)).toThrow();
    expect(() => priceForMarginMinor(-1, 10)).toThrow();
  });
  it('refuses a price too large to store', () => {
    expect(() => priceForMarginMinor(2_000_000_000, 50)).toThrow(/too large/);
  });
});
