import { describe, it, expect } from 'vitest';
import {
  calculatePartnership,
  formatDollarsCents,
  formatPercentBps,
  formatWholeDollars,
  formatWholeHours,
  parseDollarsToMinor,
  parseHoursToHundredths,
  parsePercentToBps,
  PartnershipInputError,
  serializeForClient,
  type PartnershipInputs,
} from '../../src/strategicPartnership/calculate.js';

/**
 * The financial model (Summit_Strategic_Partnership_Financial_Model_v2.xlsx) with its
 * shipped Treetop inputs: $16,514 standard project, 17.5% partner discount, 41 PM
 * hours at $75, 10 centers a year. Every expected figure below is what the workbook's
 * formulas produce for those inputs, to the cent.
 */
const TREETOP: PartnershipInputs = {
  partnerDiscountBps: 1750,
  standardProjectValueMinor: 1_651_400n,
  pmHoursReturnedPerCenterHundredths: 4100,
  pmHourValueMinor: 7_500n,
  year1PlannedCenters: 10,
  year2PlannedCenters: 10,
  year3PlannedCenters: 10,
  year4PlannedCenters: 10,
  year5PlannedCenters: 10,
};

describe('strategic partnership economics — the workbook, ported', () => {
  const o = calculatePartnership(TREETOP);

  it('per-center economics (Economics!B5:B10)', () => {
    expect(o.partnerProjectValueMinor).toBe(1_362_405n); // 16514 x 0.825 = 13,624.05
    expect(o.savingsPerCenterMinor).toBe(288_995n); // 2,889.95
    expect(o.pmCapacityValuePerCenterMinor).toBe(307_500n); // 41 x 75 = 3,075
    expect(o.combinedValuePerCenterMinor).toBe(596_495n); // 5,964.95
  });

  it('3-Year Equipment Savings is cumulative year-3 centers x savings per center (Rollout!D6)', () => {
    expect(o.threeYearCumulativeCenters).toBe(30);
    expect(o.threeYearEquipmentSavingsMinor).toBe(8_669_850n); // $86,698.50
  });

  it('the other horizon outputs (Economics!B22:B26, Rollout!C8)', () => {
    expect(o.fiveYearCumulativeCenters).toBe(50);
    expect(o.fiveYearEquipmentSavingsMinor).toBe(14_449_750n); // $144,497.50
    expect(o.threeYearPmCapacityValueMinor).toBe(9_225_000n); // $92,250
    expect(o.fiveYearPmCapacityValueMinor).toBe(15_375_000n); // $153,750
    expect(o.threeYearCombinedValueMinor).toBe(17_894_850n); // $178,948.50
    expect(o.fiveYearCombinedValueMinor).toBe(29_824_750n); // $298,247.50
  });

  it('the rollout table accumulates year by year', () => {
    expect(o.rollout.map((r) => r.cumulativeCenters)).toEqual([10, 20, 30, 40, 50]);
    expect(o.rollout[0]!.cumulativeEquipmentSavingsMinor).toBe(2_889_950n);
  });

  it('the scale scenario is 10/20/30/50 centers (Economics!A15:D18)', () => {
    expect(o.scaleScenario.map((r) => r.centers)).toEqual([10, 20, 30, 50]);
    expect(o.scaleScenario[0]).toEqual({
      centers: 10,
      equipmentSavingsMinor: 2_889_950n,
      pmCapacityValueMinor: 3_075_000n,
      combinedValueMinor: 5_964_950n,
    });
    expect(o.scaleScenario[3]!.combinedValueMinor).toBe(29_824_750n);
  });

  it('partner value and savings always add back to the standard value', () => {
    for (const bps of [1, 333, 1234, 1750, 9999]) {
      const r = calculatePartnership({
        ...TREETOP,
        partnerDiscountBps: bps,
        standardProjectValueMinor: 1_234_567n,
      });
      expect(r.partnerProjectValueMinor + r.savingsPerCenterMinor).toBe(1_234_567n);
    }
  });

  it('rounds each horizon total once from the exact value, not from a rounded per-center figure', () => {
    // $100.01 at 12.5%: savings per center is exactly 12.50125 dollars.
    const r = calculatePartnership({
      ...TREETOP,
      standardProjectValueMinor: 10_001n,
      partnerDiscountBps: 1250,
      year1PlannedCenters: 1000,
      year2PlannedCenters: 0,
      year3PlannedCenters: 0,
    });
    expect(r.savingsPerCenterMinor).toBe(1_250n); // $12.50
    // 1000 x 12.50125 = 12,501.25 — not 1000 x 12.50 = 12,500.00
    expect(r.threeYearEquipmentSavingsMinor).toBe(1_250_125n);
  });

  it('fractional PM hours stay exact', () => {
    const r = calculatePartnership({
      ...TREETOP,
      pmHoursReturnedPerCenterHundredths: 4150,
      pmHourValueMinor: 7_525n,
    });
    // 41.5 x $75.25 = $3,122.875 -> $3,122.88
    expect(r.pmCapacityValuePerCenterMinor).toBe(312_288n);
  });

  it('an omitted Year 4 / Year 5 uses Year 3, the model rule, and says so', () => {
    const r = calculatePartnership({
      ...TREETOP,
      year1PlannedCenters: 2,
      year2PlannedCenters: 4,
      year3PlannedCenters: 6,
      year4PlannedCenters: null,
      year5PlannedCenters: undefined,
    });
    expect(r.threeYearCumulativeCenters).toBe(12);
    expect(r.fiveYearCumulativeCenters).toBe(24);
    expect(r.year4Assumed).toBe(true);
    expect(r.year5Assumed).toBe(true);
    expect(calculatePartnership(TREETOP).year4Assumed).toBe(false);
  });

  it('zero discount means zero savings, not an error', () => {
    const r = calculatePartnership({ ...TREETOP, partnerDiscountBps: 0 });
    expect(r.savingsPerCenterMinor).toBe(0n);
    expect(r.threeYearEquipmentSavingsMinor).toBe(0n);
  });

  it('refuses out-of-range inputs', () => {
    expect(() => calculatePartnership({ ...TREETOP, partnerDiscountBps: 10_001 })).toThrow(
      PartnershipInputError,
    );
    expect(() => calculatePartnership({ ...TREETOP, standardProjectValueMinor: -1n })).toThrow(
      PartnershipInputError,
    );
    expect(() => calculatePartnership({ ...TREETOP, year2PlannedCenters: 1.5 })).toThrow(
      PartnershipInputError,
    );
    expect(() => calculatePartnership({ ...TREETOP, year1PlannedCenters: -1 })).toThrow(
      PartnershipInputError,
    );
  });

  it('serializes bigints as cents for the browser', () => {
    const j = serializeForClient(o) as { threeYearEquipmentSavingsMinor: number };
    expect(j.threeYearEquipmentSavingsMinor).toBe(8_669_850);
  });
});

describe('formatting matches the workbook TEXT() formats', () => {
  it('whole dollars, $#,##0, half-up', () => {
    expect(formatWholeDollars(8_669_850n)).toBe('$86,699');
    expect(formatWholeDollars(1_362_405n)).toBe('$13,624');
    expect(formatWholeDollars(288_995n)).toBe('$2,890');
    expect(formatWholeDollars(0n)).toBe('$0');
    expect(formatWholeDollars(29_824_750n)).toBe('$298,248');
  });
  it('dollars and cents, hours, percent', () => {
    expect(formatDollarsCents(1_651_400n)).toBe('$16,514.00');
    expect(formatWholeHours(4100)).toBe('41');
    expect(formatWholeHours(4150)).toBe('42');
    expect(formatPercentBps(1750)).toBe('17.5%');
    expect(formatPercentBps(1725)).toBe('17.25%');
    expect(formatPercentBps(2000)).toBe('20%');
  });
});

describe('form parsing never coerces a bad value to zero', () => {
  it('percent', () => {
    expect(parsePercentToBps('17.5')).toBe(1750);
    expect(parsePercentToBps('17.5%')).toBe(1750);
    expect(parsePercentToBps('0')).toBe(0);
    expect(() => parsePercentToBps('17.555')).toThrow(PartnershipInputError);
    expect(() => parsePercentToBps('abc')).toThrow(PartnershipInputError);
    expect(() => parsePercentToBps('100.01')).toThrow(PartnershipInputError);
  });
  it('dollars', () => {
    expect(parseDollarsToMinor('$16,514')).toBe(1_651_400n);
    expect(parseDollarsToMinor('16514.5')).toBe(1_651_450n);
    expect(() => parseDollarsToMinor('16,514.555')).toThrow(PartnershipInputError);
    expect(() => parseDollarsToMinor('-5')).toThrow(PartnershipInputError);
  });
  it('hours', () => {
    expect(parseHoursToHundredths('41')).toBe(4100);
    expect(parseHoursToHundredths('41.25')).toBe(4125);
    expect(() => parseHoursToHundredths('forty')).toThrow(PartnershipInputError);
  });
});
