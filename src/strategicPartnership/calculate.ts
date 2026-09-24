/**
 * Strategic Partnership Proposal economics.
 *
 * A direct port of the financial model the proposal was designed against
 * (Summit_Strategic_Partnership_Financial_Model_v2.xlsx — sheets Economics, Rollout,
 * Chart_Data and CRM_Outputs). The workbook was a calculation engine behind a Power
 * Automate flow; the CRM now does the arithmetic itself, so the formulas live here.
 *
 *   Partner Project Value      = Standard Project Value x (1 - Partner Discount)
 *   Savings Per Center         = Standard Project Value - Partner Project Value
 *   PM Capacity Value / Center = PM Hours Returned / Center x PM Hour Value
 *   Combined Value / Center    = Savings Per Center + PM Capacity Value / Center
 *   Cumulative centers (year n)= Year 1 + ... + Year n planned centers
 *   N-Year Equipment Savings   = cumulative centers at year N x Savings Per Center
 *   N-Year PM Capacity Value   = cumulative centers at year N x PM Capacity Value / Center
 *   N-Year Combined Value      = cumulative centers at year N x Combined Value / Center
 *   Scale scenario (10/20/30/50 centers by default) = centers x each per-center value
 *
 * Omitted Year 4 / Year 5 planned centers default to Year 3's figure — the model's own
 * rule (the Office Script wrote `year4PlannedCenters ?? year3PlannedCenters`).
 *
 * Money never touches floating point. Inputs are integer cents, the discount is basis
 * points and PM hours are hundredths of an hour, so every per-center value is an exact
 * rational number over a denominator of 10,000. Each OUTPUT is rounded once, half-up,
 * to the cent, from that exact value — a horizon total is NOT a rounded per-center
 * figure multiplied up, which is how the spreadsheet (full precision until display)
 * behaves too. The one deliberate coupling: Partner Project Value is Standard Project
 * Value minus the rounded Savings Per Center, so the two always add back to the
 * standard value exactly.
 */
import { divRound } from '../pricing/decimal.js';

/** Bump when a formula changes; stored on the record beside the outputs it produced. */
export const CALCULATION_VERSION = 1;

/** The model's 3-year and 5-year proposal horizons. */
export const THREE_YEAR = 3;
export const FIVE_YEAR = 5;

/** The workbook's default scale scenario (Economics!A15:A18). */
export const DEFAULT_SCALE_CENTERS: readonly number[] = [10, 20, 30, 50];

const DEN = 10_000n; // the common denominator every per-center value is held over

export interface PartnershipInputs {
  /** 0..10000 — 17.5% is 1750. */
  partnerDiscountBps: number;
  standardProjectValueMinor: bigint;
  /** 41 hours is 4100. */
  pmHoursReturnedPerCenterHundredths: number;
  pmHourValueMinor: bigint;
  year1PlannedCenters: number;
  year2PlannedCenters: number;
  year3PlannedCenters: number;
  year4PlannedCenters?: number | null;
  year5PlannedCenters?: number | null;
}

export interface RolloutYear {
  year: number;
  centersThisYear: number;
  cumulativeCenters: number;
  cumulativeEquipmentSavingsMinor: bigint;
  cumulativePmCapacityValueMinor: bigint;
  cumulativeCombinedValueMinor: bigint;
}

export interface ScaleScenarioRow {
  centers: number;
  equipmentSavingsMinor: bigint;
  pmCapacityValueMinor: bigint;
  combinedValueMinor: bigint;
}

export interface PartnershipOutputs {
  calculationVersion: number;
  standardProjectValueMinor: bigint;
  partnerProjectValueMinor: bigint;
  savingsPerCenterMinor: bigint;
  pmHoursReturnedPerCenterHundredths: number;
  pmCapacityValuePerCenterMinor: bigint;
  combinedValuePerCenterMinor: bigint;
  threeYearEquipmentSavingsMinor: bigint;
  fiveYearEquipmentSavingsMinor: bigint;
  threeYearPmCapacityValueMinor: bigint;
  fiveYearPmCapacityValueMinor: bigint;
  threeYearCombinedValueMinor: bigint;
  fiveYearCombinedValueMinor: bigint;
  threeYearCumulativeCenters: number;
  fiveYearCumulativeCenters: number;
  /** True when Year 4 / Year 5 were not entered and Year 3's figure was used. */
  year4Assumed: boolean;
  year5Assumed: boolean;
  rollout: RolloutYear[];
  scaleScenario: ScaleScenarioRow[];
}

export class PartnershipInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartnershipInputError';
  }
}

/** Upper bound on any one year's planned centers — a typo guard, not a business rule. */
export const MAX_CENTERS_PER_YEAR = 10_000;

function assertCenters(label: string, n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > MAX_CENTERS_PER_YEAR) {
    throw new PartnershipInputError(
      `${label} must be a whole number from 0 to ${MAX_CENTERS_PER_YEAR}.`,
    );
  }
}

function validate(i: PartnershipInputs): void {
  if (!Number.isInteger(i.partnerDiscountBps) || i.partnerDiscountBps < 0) {
    throw new PartnershipInputError('Partner discount must be a percentage from 0 to 100.');
  }
  if (i.partnerDiscountBps > 10_000) {
    throw new PartnershipInputError('Partner discount must be a percentage from 0 to 100.');
  }
  if (i.standardProjectValueMinor < 0n) {
    throw new PartnershipInputError('Standard project value cannot be negative.');
  }
  if (i.pmHourValueMinor < 0n) {
    throw new PartnershipInputError('PM hourly value cannot be negative.');
  }
  if (
    !Number.isInteger(i.pmHoursReturnedPerCenterHundredths) ||
    i.pmHoursReturnedPerCenterHundredths < 0
  ) {
    throw new PartnershipInputError('PM hours returned per center cannot be negative.');
  }
  assertCenters('Year 1 planned centers', i.year1PlannedCenters);
  assertCenters('Year 2 planned centers', i.year2PlannedCenters);
  assertCenters('Year 3 planned centers', i.year3PlannedCenters);
  if (i.year4PlannedCenters != null) assertCenters('Year 4 planned centers', i.year4PlannedCenters);
  if (i.year5PlannedCenters != null) assertCenters('Year 5 planned centers', i.year5PlannedCenters);
}

/** Round an exact value held over DEN to whole cents, half-up. */
function cents(numeratorOverDen: bigint): bigint {
  return divRound(numeratorOverDen, DEN, 'HALF_UP');
}

export function calculatePartnership(
  input: PartnershipInputs,
  scaleCenters: readonly number[] = DEFAULT_SCALE_CENTERS,
): PartnershipOutputs {
  validate(input);
  for (const c of scaleCenters) assertCenters('Scale scenario centers', c);

  // Exact per-center values, each over DEN (10,000).
  //   savings = SPV x bps / 10,000                      -> numerator SPV x bps
  //   PM      = (hours/100) x rate = hours x rate / 100  -> numerator hours x rate x 100
  const savingsNum = input.standardProjectValueMinor * BigInt(input.partnerDiscountBps);
  const pmNum =
    BigInt(input.pmHoursReturnedPerCenterHundredths) * input.pmHourValueMinor * (DEN / 100n);
  const combinedNum = savingsNum + pmNum;

  const savingsPerCenterMinor = cents(savingsNum);
  const partnerProjectValueMinor = input.standardProjectValueMinor - savingsPerCenterMinor;

  const year4Assumed = input.year4PlannedCenters == null;
  const year5Assumed = input.year5PlannedCenters == null;
  const perYear = [
    input.year1PlannedCenters,
    input.year2PlannedCenters,
    input.year3PlannedCenters,
    input.year4PlannedCenters ?? input.year3PlannedCenters,
    input.year5PlannedCenters ?? input.year3PlannedCenters,
  ];

  const rollout: RolloutYear[] = [];
  let cumulative = 0;
  perYear.forEach((centersThisYear, idx) => {
    cumulative += centersThisYear;
    const n = BigInt(cumulative);
    rollout.push({
      year: idx + 1,
      centersThisYear,
      cumulativeCenters: cumulative,
      cumulativeEquipmentSavingsMinor: cents(n * savingsNum),
      cumulativePmCapacityValueMinor: cents(n * pmNum),
      cumulativeCombinedValueMinor: cents(n * combinedNum),
    });
  });

  const y3 = rollout[THREE_YEAR - 1]!;
  const y5 = rollout[FIVE_YEAR - 1]!;

  const scaleScenario: ScaleScenarioRow[] = scaleCenters.map((centers) => {
    const n = BigInt(centers);
    return {
      centers,
      equipmentSavingsMinor: cents(n * savingsNum),
      pmCapacityValueMinor: cents(n * pmNum),
      combinedValueMinor: cents(n * combinedNum),
    };
  });

  return {
    calculationVersion: CALCULATION_VERSION,
    standardProjectValueMinor: input.standardProjectValueMinor,
    partnerProjectValueMinor,
    savingsPerCenterMinor,
    pmHoursReturnedPerCenterHundredths: input.pmHoursReturnedPerCenterHundredths,
    pmCapacityValuePerCenterMinor: cents(pmNum),
    combinedValuePerCenterMinor: cents(combinedNum),
    threeYearEquipmentSavingsMinor: y3.cumulativeEquipmentSavingsMinor,
    fiveYearEquipmentSavingsMinor: y5.cumulativeEquipmentSavingsMinor,
    threeYearPmCapacityValueMinor: y3.cumulativePmCapacityValueMinor,
    fiveYearPmCapacityValueMinor: y5.cumulativePmCapacityValueMinor,
    threeYearCombinedValueMinor: y3.cumulativeCombinedValueMinor,
    fiveYearCombinedValueMinor: y5.cumulativeCombinedValueMinor,
    threeYearCumulativeCenters: y3.cumulativeCenters,
    fiveYearCumulativeCenters: y5.cumulativeCenters,
    year4Assumed,
    year5Assumed,
    rollout,
    scaleScenario,
  };
}

/**
 * The outputs as JSON for the browser: every bigint becomes a number of cents.
 * Refuses rather than rounds a value past 2^53 cents (~$90 trillion).
 */
export function serializeForClient(o: PartnershipOutputs): unknown {
  return JSON.parse(
    JSON.stringify(o, (_k, v: unknown) => {
      if (typeof v !== 'bigint') return v;
      const n = Number(v);
      if (!Number.isSafeInteger(n))
        throw new PartnershipInputError('A figure is too large to show.');
      return n;
    }),
  ) as unknown;
}

/* ------------------------------------------------------------------ formatting */

/**
 * Whole dollars with thousands separators — Excel's TEXT(x, "$#,##0"), which is what
 * every currency field in the Canva master was filled with. Half-up on the cent.
 */
export function formatWholeDollars(minor: bigint): string {
  const dollars = divRound(minor, 100n, 'HALF_UP');
  const neg = dollars < 0n;
  const digits = (neg ? -dollars : dollars).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${digits}`;
}

/** Dollars and cents, "$16,514.00" — for the CRM screen, not the Canva copy. */
export function formatDollarsCents(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}$${whole}.${frac}`;
}

/** Hours to the nearest whole hour — TEXT(x, "0"). */
export function formatWholeHours(hundredths: number): string {
  return divRound(BigInt(hundredths), 100n, 'HALF_UP').toString();
}

/** Basis points as a percentage without trailing zeros: 1750 -> "17.5%". */
export function formatPercentBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''}%`;
}

/* --------------------------------------------------------------------- parsing */

/**
 * "17.5" (percent) -> 1750 bps. At most two decimals; never coerces a malformed
 * value to zero.
 */
export function parsePercentToBps(input: string): number {
  const s = input.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) {
    throw new PartnershipInputError(`"${input}" is not a percentage (up to two decimals).`);
  }
  const [whole, frac = ''] = s.split('.');
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (bps > 10_000) throw new PartnershipInputError('A percentage cannot exceed 100.');
  return bps;
}

/** "41" or "41.5" hours -> hundredths of an hour. */
export function parseHoursToHundredths(input: string): number {
  const s = input.trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) {
    throw new PartnershipInputError(`"${input}" is not a number of hours (up to two decimals).`);
  }
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** "$16,514" / "16514.00" -> 1651400 cents. Commas and a leading $ are accepted. */
export function parseDollarsToMinor(input: string): bigint {
  const s = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) {
    throw new PartnershipInputError(`"${input}" is not a dollar amount (up to two decimals).`);
  }
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole + frac.padEnd(2, '0'));
}
