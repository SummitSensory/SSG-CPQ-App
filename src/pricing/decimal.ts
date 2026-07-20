/**
 * Decimal-safe money math. Money is ALWAYS integer minor units (bigint).
 * Rates are integer basis points (bps): 100% = 10000 bps, 8.25% = 825 bps.
 * No JavaScript floating point ever touches a monetary value.
 */

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

/** Rounding policy per calculation level — defined explicitly and tested. */
export interface RoundingPolicy {
  lineDiscount: RoundingMode;
  orderDiscount: RoundingMode;
  tax: RoundingMode;
  fee: RoundingMode;
  ccFee: RoundingMode;
  payment: RoundingMode;
}

export const DEFAULT_ROUNDING: RoundingPolicy = {
  lineDiscount: 'HALF_UP',
  orderDiscount: 'HALF_UP',
  tax: 'HALF_UP',
  fee: 'HALF_UP',
  ccFee: 'HALF_UP',
  payment: 'HALF_UP',
};

/** Divide num/den with the given rounding mode, returning an exact bigint. */
export function divRound(num: bigint, den: bigint, mode: RoundingMode): bigint {
  if (den === 0n) throw new Error('division by zero');
  const negative = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = a / b;
  const r = a % b;
  if (r === 0n) return negative ? -q : q;

  let roundUp = false;
  switch (mode) {
    case 'DOWN':
      roundUp = false;
      break;
    case 'UP':
      roundUp = true;
      break;
    case 'HALF_UP':
      roundUp = r * 2n >= b;
      break;
    case 'HALF_EVEN': {
      const twice = r * 2n;
      if (twice > b) roundUp = true;
      else if (twice < b) roundUp = false;
      else roundUp = q % 2n === 1n; // round to even
      break;
    }
  }
  const mag = roundUp ? q + 1n : q;
  return negative ? -mag : mag;
}

/** amount * bps / 10000, rounded. Used for discounts, tax, fees. */
export function applyRate(amountMinor: bigint, bps: number, mode: RoundingMode): bigint {
  if (!Number.isInteger(bps)) throw new Error('bps must be an integer');
  return divRound(amountMinor * BigInt(bps), 10000n, mode);
}

/** Format minor units as a decimal string (2 dp) for explanations/serialization. */
export function formatMinor(minor: bigint, currency: string): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const s = abs.toString().padStart(3, '0');
  return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)} ${currency}`;
}

/** Parse a decimal string ("1234.56") to minor units. Throws on malformed input — never coerces to 0. */
export function parseMinor(amount: string): bigint {
  if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) throw new Error(`Invalid money amount: ${amount}`);
  const [whole, frac = ''] = amount.split('.');
  return BigInt(whole + frac.padEnd(2, '0'));
}

export function sum(values: bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n);
}
