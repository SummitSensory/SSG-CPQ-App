import { describe, it, expect } from 'vitest';
import { divRound, applyRate, parseMinor, formatMinor } from '../../src/pricing/decimal.js';

describe('decimal rounding — defined at every level', () => {
  it('HALF_UP rounds .5 away from zero', () => {
    expect(divRound(5n, 2n, 'HALF_UP')).toBe(3n);   // 2.5 -> 3
    expect(divRound(-5n, 2n, 'HALF_UP')).toBe(-3n);
    expect(divRound(4n, 2n, 'HALF_UP')).toBe(2n);
  });
  it('HALF_EVEN rounds .5 to nearest even', () => {
    expect(divRound(5n, 2n, 'HALF_EVEN')).toBe(2n);  // 2.5 -> 2
    expect(divRound(7n, 2n, 'HALF_EVEN')).toBe(4n);  // 3.5 -> 4
  });
  it('DOWN truncates toward zero, UP away', () => {
    expect(divRound(9n, 4n, 'DOWN')).toBe(2n);
    expect(divRound(9n, 4n, 'UP')).toBe(3n);
  });
  it('exact division needs no rounding', () => {
    expect(divRound(10n, 2n, 'HALF_UP')).toBe(5n);
  });
});

describe('applyRate (basis points)', () => {
  it('computes 8.25% tax on $1000.00 = $82.50', () => {
    // 100000 minor * 825 bps / 10000 = 8250
    expect(applyRate(100000n, 825, 'HALF_UP')).toBe(8250n);
  });
  it('rounds a fractional-cent tax correctly', () => {
    // $19.99 * 8.25% = 1.649175 -> 165 minor (HALF_UP)
    expect(applyRate(1999n, 825, 'HALF_UP')).toBe(165n);
  });
  it('rejects non-integer bps', () => {
    expect(() => applyRate(1000n, 8.25 as unknown as number, 'HALF_UP')).toThrow();
  });
});

describe('parse / format', () => {
  it('round-trips decimal strings', () => {
    expect(parseMinor('1234.56')).toBe(123456n);
    expect(formatMinor(123456n, 'USD')).toBe('1234.56 USD');
  });
  it('throws on malformed money (never coerces to 0)', () => {
    expect(() => parseMinor('12.345')).toThrow();
    expect(() => parseMinor('abc')).toThrow();
  });
});
