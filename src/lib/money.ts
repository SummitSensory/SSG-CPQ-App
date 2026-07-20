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
