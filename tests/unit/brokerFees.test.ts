/**
 * Broker fee schedule arithmetic.
 *
 * Pure function, so the interesting cases are a table rather than a fixture database.
 * The three that matter and would not be caught by eyeballing the code: percent is a
 * PERCENT and not a fraction, a minimum applies to the broker's own fee and not to
 * amounts it merely advanced, and a tier table with no open-ended band refuses rather
 * than charging the top band to a value above it.
 */
import { describe, expect, it } from 'vitest';
import {
  estimateBrokerFee,
  parseTiers,
  percentOfMinor,
  selectSchedule,
  tierFor,
  type BrokerFeeSchedule,
} from '../../src/crossborder/brokerFees.js';

const base: BrokerFeeSchedule = {
  id: 'sched_1',
  name: 'Test tariff',
  brokerName: null,
  feeType: 'FLAT',
  currency: 'CAD',
  amountMinor: null,
  percent: null,
  minMinor: null,
  maxMinor: null,
  tiers: null,
  disbursementMinor: null,
  advancementMinor: null,
  bondMinor: null,
};

const s = (over: Partial<BrokerFeeSchedule>): BrokerFeeSchedule => ({ ...base, ...over });

describe('percentOfMinor', () => {
  it('reads the value as a percent, not a fraction', () => {
    // 0.25% of $10,000.00 is $25.00 — not $2,500.00, which is what a fraction gives.
    expect(percentOfMinor(1_000_000, '0.25')).toBe(2500);
  });

  it('rounds half-up away from zero', () => {
    // 1% of $0.05 is 0.05 cents. Half-up on the half-cent, not banker's rounding.
    expect(percentOfMinor(5, '10')).toBe(1); // 0.5 → 1
    expect(percentOfMinor(4, '10')).toBe(0); // 0.4 → 0
  });

  it('gives the same answer at any scale of the same rate', () => {
    expect(percentOfMinor(1_234_567, '0.25')).toBe(percentOfMinor(1_234_567, '0.2500'));
  });

  it('refuses a rate that is not a number', () => {
    expect(percentOfMinor(100_000, '0.25%')).toBeNull();
  });
});

describe('estimateBrokerFee', () => {
  it('returns no figure and no throw for a MANUAL schedule', () => {
    const e = estimateBrokerFee(s({ feeType: 'MANUAL' }), { valueMinor: 1_000_000 });
    expect(e.amountMinor).toBeNull();
    expect(e.manual).toBe(true);
  });

  it('returns no figure for a percentage schedule with no rate', () => {
    const e = estimateBrokerFee(s({ feeType: 'PERCENTAGE' }), { valueMinor: 1_000_000 });
    expect(e.amountMinor).toBeNull();
    expect(e.unavailableReason).toMatch(/no rate/i);
  });

  it('applies a minimum to the computed fee', () => {
    const e = estimateBrokerFee(
      s({ feeType: 'PERCENTAGE', percent: '0.25', minMinor: 12_500 }),
      { valueMinor: 1_000_000 }, // 0.25% = $25.00, below the $125.00 floor
    );
    expect(e.amountMinor).toBe(12_500);
    expect(e.adjustment).toBe('MINIMUM_APPLIED');
  });

  it('adds disbursement and bond AFTER the minimum, so the floor is not spent on them', () => {
    const e = estimateBrokerFee(
      s({
        feeType: 'FLAT',
        amountMinor: 5_000,
        minMinor: 12_500,
        disbursementMinor: 2_000,
        bondMinor: 1_000,
      }),
      { valueMinor: 1_000_000 },
    );
    // $125.00 floor on the broker's own fee, then $20.00 disbursement and $10.00 bond.
    expect(e.amountMinor).toBe(15_500);
  });

  it('caps at the maximum', () => {
    const e = estimateBrokerFee(s({ feeType: 'PERCENTAGE', percent: '1', maxMinor: 50_000 }), {
      valueMinor: 100_000_000,
    });
    expect(e.amountMinor).toBe(50_000);
    expect(e.adjustment).toBe('MAXIMUM_APPLIED');
  });

  it('multiplies a per-line fee by the line count', () => {
    const e = estimateBrokerFee(s({ feeType: 'PER_LINE', amountMinor: 750 }), {
      valueMinor: 1_000_000,
      lineCount: 6,
    });
    expect(e.amountMinor).toBe(4_500);
  });

  it('refuses a per-line fee when the crossing has no line count', () => {
    const e = estimateBrokerFee(s({ feeType: 'PER_LINE', amountMinor: 750 }), {
      valueMinor: 1_000_000,
    });
    expect(e.amountMinor).toBeNull();
  });

  it('itemizes a tiered band that carries both a base and a rate', () => {
    const e = estimateBrokerFee(
      s({
        feeType: 'TIERED',
        tiers: [
          { upToMinor: 500_000, amountMinor: 8_500, label: 'Up to $5,000' },
          { upToMinor: null, amountMinor: 8_500, percent: '0.15', label: 'Above $5,000' },
        ],
      }),
      { valueMinor: 2_000_000 },
    );
    // $85.00 base plus 0.15% of $20,000.00 = $30.00.
    expect(e.amountMinor).toBe(11_500);
    expect(e.components).toHaveLength(2);
  });

  it('refuses a value above every tier when no open-ended tier exists', () => {
    const e = estimateBrokerFee(
      s({ feeType: 'TIERED', tiers: [{ upToMinor: 500_000, amountMinor: 8_500 }] }),
      { valueMinor: 2_000_000 },
    );
    expect(e.amountMinor).toBeNull();
    expect(e.unavailableReason).toMatch(/above every tier/i);
  });
});

describe('parseTiers', () => {
  it('sorts by ceiling and puts the open-ended tier last', () => {
    const tiers = parseTiers([
      { upToMinor: null, amountMinor: 3 },
      { upToMinor: 200, amountMinor: 2 },
      { upToMinor: 100, amountMinor: 1 },
    ]);
    expect(tiers?.map((t) => t.amountMinor)).toEqual([1, 2, 3]);
  });

  it('rejects two open-ended tiers rather than picking one', () => {
    expect(
      parseTiers([
        { upToMinor: null, amountMinor: 1 },
        { upToMinor: null, amountMinor: 2 },
      ]),
    ).toBeNull();
  });

  it('rejects a tier with neither an amount nor a rate', () => {
    expect(parseTiers([{ upToMinor: 100 }])).toBeNull();
  });

  it('treats a ceiling as inclusive', () => {
    const tiers = parseTiers([
      { upToMinor: 100, amountMinor: 1 },
      { upToMinor: null, amountMinor: 2 },
    ])!;
    expect(tierFor(tiers, 100)?.amountMinor).toBe(1);
    expect(tierFor(tiers, 101)?.amountMinor).toBe(2);
  });
});

describe('selectSchedule', () => {
  interface Dated {
    id: string;
    active: boolean;
    isDefault: boolean;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  }

  const row = (over: Partial<Dated> = {}): Dated => ({
    id: 'x',
    active: true,
    isDefault: false,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
    ...over,
  });

  it('treats effectiveTo as exclusive', () => {
    const r = row({ effectiveTo: new Date('2026-06-01') });
    expect(selectSchedule([r], new Date('2026-05-31'))).toBe(r);
    expect(selectSchedule([r], new Date('2026-06-01'))).toBeNull();
  });

  it('prefers the default over another schedule in force', () => {
    const plain = row({ id: 'plain' });
    const def = row({ id: 'def', isDefault: true });
    expect(selectSchedule([plain, def], new Date('2026-03-01'))?.id).toBe('def');
  });

  it('ignores a retired schedule', () => {
    expect(selectSchedule([row({ active: false })], new Date('2026-03-01'))).toBeNull();
  });

  it('takes the newest start date among equals, so a later correction governs', () => {
    const old = row({ id: 'old' });
    const corrected = row({ id: 'corrected', effectiveFrom: new Date('2026-04-01') });
    expect(selectSchedule([old, corrected], new Date('2026-05-01'))?.id).toBe('corrected');
  });
});
