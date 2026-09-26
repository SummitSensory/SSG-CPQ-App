/**
 * Money is stored and computed as an integer number of minor units (e.g. cents)
 * using bigint. Never use floating-point arithmetic for financial values.
 */
export class Money {
  private constructor(
    readonly minorUnits: bigint,
    readonly currency: string,
  ) {}

  static ofMinor(minorUnits: bigint | number, currency: string): Money {
    return new Money(BigInt(minorUnits), currency.toUpperCase());
  }

  /** Parse a decimal string like "19.99" into minor units (2dp). */
  static parse(amount: string, currency: string): Money {
    if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) {
      throw new Error(`Invalid money amount: ${amount}`);
    }
    const [whole, frac = ''] = amount.split('.');
    const minor = BigInt(whole + frac.padEnd(2, '0'));
    return new Money(minor, currency.toUpperCase());
  }

  private assertSame(other: Money): void {
    if (other.currency !== this.currency) {
      throw new Error(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  add(other: Money): Money {
    this.assertSame(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }
  subtract(other: Money): Money {
    this.assertSame(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  toString(): string {
    const neg = this.minorUnits < 0n;
    const abs = neg ? -this.minorUnits : this.minorUnits;
    const s = abs.toString().padStart(3, '0');
    const whole = s.slice(0, -2);
    const frac = s.slice(-2);
    return `${neg ? '-' : ''}${whole}.${frac} ${this.currency}`;
  }
}

/** Largest value the catalog's Int price column holds (cents). */
const MAX_INT_MINOR = 2_147_483_647n;

/**
 * The sales price that earns `marginPercent` GROSS MARGIN on `costMinor`:
 * price = cost / (1 − margin). Margin is profit as a share of the PRICE, not of the
 * cost (that would be markup): a $60 part at 40% margin sells for $100, not $84.
 *
 * Integer arithmetic throughout. The margin is taken to two decimals (basis points)
 * and the price rounded half-up to the cent. Throws on a margin outside 0–99.99%,
 * a negative cost, or a price too large to store.
 */
export function priceForMarginMinor(costMinor: number | bigint, marginPercent: number): bigint {
  if (!Number.isFinite(marginPercent) || marginPercent < 0 || marginPercent >= 100) {
    throw new RangeError('Margin must be at least 0% and less than 100%.');
  }
  const cost = BigInt(costMinor);
  if (cost < 0n) throw new RangeError('Cost cannot be negative.');
  const bps = BigInt(Math.round(marginPercent * 100));
  if (bps >= 10_000n) throw new RangeError('Margin must be at least 0% and less than 100%.');
  const denom = 10_000n - bps;
  // Half-up: (2·cost·10000 + denom) / (2·denom).
  const price = (2n * cost * 10_000n + denom) / (2n * denom);
  if (price > MAX_INT_MINOR) throw new RangeError('That price is too large to store.');
  return price;
}
