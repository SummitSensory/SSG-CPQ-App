import { describe, it, expect } from 'vitest';
import { splitBalances } from '../../src/handoff/shippingReadiness.js';

/**
 * The order page's "Customer balance" must never add two currencies together:
 * USD 3,300 owed plus CAD 5,700 owed is not "USD 9,000 owed". Found by the
 * 2026-10-09 browser walk-through of the receivables screen.
 */
describe('splitBalances', () => {
  it('reports null when nothing has been invoiced', () => {
    expect(splitBalances([], 'USD')).toEqual({
      balanceMinor: null,
      invoiceCount: 0,
      otherCurrencyBalances: [],
    });
  });

  it('sums the order currency, using the amount when no balance is recorded', () => {
    const r = splitBalances(
      [
        { balanceMinor: 80000n, amountMinor: 100000n, currency: 'USD' },
        { balanceMinor: null, amountMinor: 250000n, currency: 'usd' },
      ],
      'USD',
    );
    expect(r).toEqual({ balanceMinor: 330000n, invoiceCount: 2, otherCurrencyBalances: [] });
  });

  it('keeps another currency apart instead of adding it in', () => {
    const r = splitBalances(
      [
        { balanceMinor: 330000n, amountMinor: 350000n, currency: 'USD' },
        { balanceMinor: 500000n, amountMinor: 500000n, currency: 'CAD' },
        { balanceMinor: 70000n, amountMinor: 70000n, currency: 'CAD' },
      ],
      'USD',
    );
    expect(r.balanceMinor).toBe(330000n);
    expect(r.invoiceCount).toBe(3);
    expect(r.otherCurrencyBalances).toEqual([{ currency: 'CAD', balanceMinor: 570000n }]);
  });

  it('reads 0 in the order currency when every invoice is in another one', () => {
    const r = splitBalances([{ balanceMinor: 1000n, amountMinor: 1000n, currency: 'CAD' }], 'USD');
    expect(r.balanceMinor).toBe(0n);
    expect(r.otherCurrencyBalances).toEqual([{ currency: 'CAD', balanceMinor: 1000n }]);
  });
});
