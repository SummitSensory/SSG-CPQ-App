import { describe, it, expect } from 'vitest';
import { Money } from '../../src/lib/money.js';

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
