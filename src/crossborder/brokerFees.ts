/**
 * Customs brokerage fee schedules.
 *
 * A broker's fee is the one border charge on a Canadian job that is genuinely
 * knowable in advance: it comes off a published tariff of the broker's own, not off
 * a tariff classification this database does not hold. So unlike duty, it can be
 * computed — and unlike duty, computing it is useful.
 *
 * What this module does NOT do is apply that figure to a proposal on its own. It
 * SUGGESTS. `ProposalCustomsEntry.brokerFeeMinor` is still written by a person, and
 * still needs the same approval as every other customs figure, for the same reason:
 * the number that goes on a landed-cost quote should have somebody's name against
 * it. The suggestion exists so that person is typing a checked figure rather than
 * doing arithmetic in a browser tab.
 *
 * Pure. No database, no clock, no config — the caller supplies the schedule row and
 * the shipment facts, which is what makes fee behaviour a fixture table.
 *
 * Money is integer minor units throughout, matching `src/lib/money.ts`. Percentages
 * are `Decimal(7,4)` strings and are read as PERCENT, not as a fraction: `0.2500`
 * means a quarter of one percent. Rounding is half-up away from zero, the same rule
 * `fx.ts` uses, so a fee and a converted fee round the same direction.
 */

export type BrokerFeeTypeValue =
  'FLAT' | 'PERCENTAGE' | 'TIERED' | 'PER_ENTRY' | 'PER_SHIPMENT' | 'PER_LINE' | 'MANUAL';

/** The subset of `CustomsBrokerFeeSchedule` the evaluator reads. */
export interface BrokerFeeSchedule {
  id: string;
  name: string;
  brokerName: string | null;
  feeType: BrokerFeeTypeValue;
  currency: string;
  amountMinor: number | null;
  /** Decimal string, a PERCENT. `0.2500` is 0.25%. */
  percent: string | null;
  minMinor: number | null;
  maxMinor: number | null;
  tiers: unknown;
  disbursementMinor: number | null;
  advancementMinor: number | null;
  bondMinor: number | null;
}

/**
 * One tier of a TIERED schedule.
 *
 * `upToMinor` is the INCLUSIVE top of the band, in the same currency as the value
 * being banded, and `null` means "and above" — exactly one tier may have it. A tier
 * may carry a flat amount, a percent, or both (a base fee plus a rate).
 */
export interface BrokerFeeTier {
  upToMinor: number | null;
  amountMinor?: number | null;
  percent?: string | null;
  label?: string | null;
}

export interface BrokerFeeContext {
  /**
   * The value the broker bills against — normally the customs value of the entry.
   * Must already be in the schedule's currency; this module never converts, because
   * a fee converted from a value converted from a rate is two roundings deep and the
   * caller is the only one who knows which rate applied.
   */
  valueMinor: number;
  /** Entries, shipments and lines on the crossing. Default 1, 1 and 0. */
  entryCount?: number;
  shipmentCount?: number;
  lineCount?: number;
}

export interface BrokerFeeComponent {
  label: string;
  amountMinor: number;
}

export interface BrokerFeeEstimate {
  scheduleId: string;
  currency: string;
  /** Null for MANUAL, and for a schedule whose own figures are incomplete. */
  amountMinor: number | null;
  /** Every part of the figure, in the order it was added. For the UI and the audit. */
  components: BrokerFeeComponent[];
  /** Set when a floor or ceiling moved the computed figure. */
  adjustment: 'MINIMUM_APPLIED' | 'MAXIMUM_APPLIED' | null;
  /** Plain-language reason there is no figure. Null when there is one. */
  unavailableReason: string | null;
  /** True when a person has to supply the number regardless. */
  manual: boolean;
}

const ROUND_UNIT = 10n;

/** round(a / b) half-up away from zero, on integers. */
function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  const neg = a < 0n !== b < 0n;
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  const q = (x * ROUND_UNIT) / y;
  const rounded = (q + 5n) / ROUND_UNIT;
  return neg ? -rounded : rounded;
}

/**
 * A percent of a minor-unit base.
 *
 * The scale comes from the string rather than from the column, so a hand-entered
 * `2.5` and a database-round-tripped `2.5000` give the same answer.
 */
export function percentOfMinor(baseMinor: number, percent: string): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(percent.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const frac = m[3] ?? '';
  const digits = BigInt(m[2] + frac) * sign;
  // × 100 because the value is a percent, not a fraction.
  const denominator = 10n ** BigInt(frac.length) * 100n;
  return Number(divRound(BigInt(Math.trunc(baseMinor)) * digits, denominator));
}

/** Sorted tiers, or null when the JSON is not a usable tier table. */
export function parseTiers(raw: unknown): BrokerFeeTier[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const tiers: BrokerFeeTier[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') return null;
    const row = t as Record<string, unknown>;
    const up = row.upToMinor;
    if (up != null && (typeof up !== 'number' || !Number.isInteger(up) || up < 0)) return null;
    const amt = row.amountMinor;
    if (amt != null && (typeof amt !== 'number' || !Number.isInteger(amt))) return null;
    const pct = row.percent;
    if (pct != null && typeof pct !== 'string') return null;
    if (amt == null && pct == null) return null;
    tiers.push({
      upToMinor: up == null ? null : (up as number),
      amountMinor: amt == null ? null : (amt as number),
      percent: pct == null ? null : (pct as string),
      label: typeof row.label === 'string' ? row.label : null,
    });
  }
  // An open-ended tier sorts last; everything else by its ceiling. A table with two
  // open-ended tiers is ambiguous and rejected rather than silently resolved.
  if (tiers.filter((t) => t.upToMinor == null).length > 1) return null;
  return tiers.sort((a, b) => {
    if (a.upToMinor == null) return 1;
    if (b.upToMinor == null) return -1;
    return a.upToMinor - b.upToMinor;
  });
}

/** The band a value falls in. Inclusive ceilings; the open tier catches the rest. */
export function tierFor(tiers: BrokerFeeTier[], valueMinor: number): BrokerFeeTier | null {
  for (const t of tiers) {
    if (t.upToMinor == null || valueMinor <= t.upToMinor) return t;
  }
  return null;
}

function unavailable(
  schedule: BrokerFeeSchedule,
  reason: string,
  manual = false,
): BrokerFeeEstimate {
  return {
    scheduleId: schedule.id,
    currency: schedule.currency,
    amountMinor: null,
    components: [],
    adjustment: null,
    unavailableReason: reason,
    manual,
  };
}

/**
 * What this schedule would charge on this crossing.
 *
 * Returns a figure and its parts, or a reason there is no figure. It never throws on
 * incomplete schedule data: an administrator saving a half-finished schedule should
 * see "this schedule has no percentage" on the proposal, not a 500.
 */
export function estimateBrokerFee(
  schedule: BrokerFeeSchedule,
  ctx: BrokerFeeContext,
): BrokerFeeEstimate {
  if (schedule.feeType === 'MANUAL') {
    return unavailable(
      schedule,
      'This schedule is marked manual — enter the figure from the broker’s quote.',
      true,
    );
  }

  const value = Math.max(0, Math.trunc(ctx.valueMinor || 0));
  const entries = Math.max(1, Math.trunc(ctx.entryCount ?? 1));
  const shipments = Math.max(1, Math.trunc(ctx.shipmentCount ?? 1));
  const lines = Math.max(0, Math.trunc(ctx.lineCount ?? 0));

  const components: BrokerFeeComponent[] = [];
  let base: number | null = null;

  switch (schedule.feeType) {
    case 'FLAT': {
      if (schedule.amountMinor == null) {
        return unavailable(schedule, 'This flat-fee schedule has no amount on it.');
      }
      base = schedule.amountMinor;
      components.push({ label: 'Entry preparation', amountMinor: base });
      break;
    }
    case 'PERCENTAGE': {
      if (!schedule.percent) {
        return unavailable(schedule, 'This percentage schedule has no rate on it.');
      }
      const pct = percentOfMinor(value, schedule.percent);
      if (pct == null) {
        return unavailable(schedule, `“${schedule.percent}” is not a usable percentage.`);
      }
      base = pct;
      components.push({ label: `${schedule.percent}% of entry value`, amountMinor: base });
      break;
    }
    case 'TIERED': {
      const tiers = parseTiers(schedule.tiers);
      if (!tiers) {
        return unavailable(schedule, 'This tiered schedule has no usable tier table.');
      }
      const tier = tierFor(tiers, value);
      if (!tier) {
        // Every ceiling is below the value and no open-ended tier exists. Saying so
        // is better than charging the top band and hoping.
        return unavailable(
          schedule,
          'The entry value is above every tier on this schedule, and it has no “and above” tier.',
        );
      }
      base = 0;
      if (tier.amountMinor != null) {
        base += tier.amountMinor;
        components.push({
          label: tier.label || 'Tier fee',
          amountMinor: tier.amountMinor,
        });
      }
      if (tier.percent) {
        const pct = percentOfMinor(value, tier.percent);
        if (pct == null) {
          return unavailable(schedule, `“${tier.percent}” is not a usable percentage.`);
        }
        base += pct;
        components.push({ label: `${tier.percent}% of entry value`, amountMinor: pct });
      }
      break;
    }
    case 'PER_ENTRY':
    case 'PER_SHIPMENT':
    case 'PER_LINE': {
      if (schedule.amountMinor == null) {
        return unavailable(schedule, 'This per-unit schedule has no unit amount on it.');
      }
      const count =
        schedule.feeType === 'PER_ENTRY'
          ? entries
          : schedule.feeType === 'PER_SHIPMENT'
            ? shipments
            : lines;
      if (schedule.feeType === 'PER_LINE' && lines === 0) {
        return unavailable(
          schedule,
          'This schedule charges per line and the crossing has no line count yet.',
        );
      }
      base = schedule.amountMinor * count;
      const unit =
        schedule.feeType === 'PER_ENTRY'
          ? 'entry'
          : schedule.feeType === 'PER_SHIPMENT'
            ? 'shipment'
            : 'line';
      components.push({ label: `${count} × per-${unit} fee`, amountMinor: base });
      break;
    }
    default:
      return unavailable(schedule, 'Unrecognized fee type.');
  }

  // The floor and ceiling bound the broker's own fee, before the pass-through
  // charges below. A minimum that also capped disbursement would be wrong: those are
  // amounts the broker advanced, not fees it set.
  let adjustment: BrokerFeeEstimate['adjustment'] = null;
  if (schedule.minMinor != null && base < schedule.minMinor) {
    components.push({
      label: 'Minimum fee applied',
      amountMinor: schedule.minMinor - base,
    });
    base = schedule.minMinor;
    adjustment = 'MINIMUM_APPLIED';
  } else if (schedule.maxMinor != null && base > schedule.maxMinor) {
    components.push({
      label: 'Maximum fee applied',
      amountMinor: schedule.maxMinor - base,
    });
    base = schedule.maxMinor;
    adjustment = 'MAXIMUM_APPLIED';
  }

  for (const [label, amount] of [
    ['Disbursement fee', schedule.disbursementMinor],
    ['Advancement fee', schedule.advancementMinor],
    ['Bond', schedule.bondMinor],
  ] as const) {
    if (amount != null && amount !== 0) {
      base += amount;
      components.push({ label, amountMinor: amount });
    }
  }

  return {
    scheduleId: schedule.id,
    currency: schedule.currency,
    amountMinor: base,
    components,
    adjustment,
    unavailableReason: null,
    manual: false,
  };
}

/**
 * The schedule in force on a date, preferring the one marked default.
 *
 * `effectiveTo` is EXCLUSIVE, matching the tax and registration tables. Abutting rows
 * must share a boundary date exactly or the scheme is wrong by a day at every change.
 */
export function selectSchedule<
  T extends { active: boolean; isDefault: boolean; effectiveFrom: Date; effectiveTo: Date | null },
>(schedules: T[], asOf: Date): T | null {
  const inForce = schedules.filter(
    (s) => s.active && s.effectiveFrom <= asOf && (s.effectiveTo == null || s.effectiveTo > asOf),
  );
  if (inForce.length === 0) return null;
  const preferred = inForce.filter((s) => s.isDefault);
  const pool = preferred.length > 0 ? preferred : inForce;
  // Newest effective date wins among equals, so a correction entered later governs.
  return pool.reduce((a, b) => (b.effectiveFrom > a.effectiveFrom ? b : a));
}
