import { describe, expect, it } from 'vitest';
import {
  ALL_PROVINCES,
  EXPECTED_2026,
  HST_PROVINCES,
  PRODUCTION_TAX_RATES,
  PRODUCTION_TAXABILITY,
} from '../fixtures/canadianTax.js';
import {
  applicableTaxTypes,
  applyPercent,
  taxableBasis,
  type CanadianTaxType,
} from '../../src/crossborder/tax.js';
import type { ProvinceCode } from '../../src/lib/country.js';

/**
 * The rate table, checked against itself.
 *
 * `crossBorderCharges.test.ts` proves the arithmetic on round numbers. This file
 * proves the TABLE: that every province a proposal can ship to has a rate in force,
 * that no province has two of the same tax at once, and that a rate change lands on
 * the right day. Those are the failures a fixture of 5% and 13% cannot show, and
 * they are the ones that mis-quote a real job.
 */

const ASOF = '2026-08-21';

function describeRates(province: ProvinceCode, asOf: string): string[] {
  return applicableTaxTypes(province, asOf, PRODUCTION_TAX_RATES)
    .map((r) => `${r.taxType} ${r.ratePercent}`)
    .sort();
}

describe('the production Canadian rate table', () => {
  it('has a rate in force for every province and territory', () => {
    for (const province of ALL_PROVINCES) {
      expect(describeRates(province, ASOF), province).not.toHaveLength(0);
    }
  });

  it('charges what each province actually charges today', () => {
    for (const province of ALL_PROVINCES) {
      const expected = [...(EXPECTED_2026[province] ?? [])].sort();
      expect(describeRates(province, ASOF), province).toEqual(expected);
    }
  });

  it('shows one harmonized line and no GST beside it', () => {
    for (const province of HST_PROVINCES) {
      const live = applicableTaxTypes(province, ASOF, PRODUCTION_TAX_RATES);
      expect(live, province).toHaveLength(1);
      expect(live[0]!.taxType, province).toBe('HST');
    }
  });

  it('never has two provincial sales taxes in force in one province', () => {
    const provincial: CanadianTaxType[] = ['PST', 'RST', 'QST'];
    for (const province of ALL_PROVINCES) {
      const live = applicableTaxTypes(province, ASOF, PRODUCTION_TAX_RATES).filter((r) =>
        provincial.includes(r.taxType),
      );
      expect(live.length, province).toBeLessThanOrEqual(1);
    }
  });

  it('never has two rows of the same tax overlapping in one province', () => {
    // Every distinct boundary date in the table, plus the day either side of it. If
    // two rows overlap by a single day, one of these dates lands inside both.
    const dates = new Set<string>();
    for (const r of PRODUCTION_TAX_RATES) {
      for (const iso of [r.effectiveFrom, r.effectiveTo]) {
        if (!iso) continue;
        const day = new Date(`${iso}T00:00:00Z`);
        for (const shift of [-1, 0, 1]) {
          const d = new Date(day.getTime() + shift * 86_400_000);
          dates.add(d.toISOString().slice(0, 10));
        }
      }
    }

    for (const asOf of dates) {
      for (const province of ALL_PROVINCES) {
        const counts = new Map<string, number>();
        for (const r of PRODUCTION_TAX_RATES) {
          if (r.province !== province) continue;
          if (r.effectiveFrom > asOf) continue;
          if (r.effectiveTo != null && r.effectiveTo <= asOf) continue;
          counts.set(r.taxType, (counts.get(r.taxType) ?? 0) + 1);
        }
        for (const [taxType, n] of counts) {
          expect(n, `${province} ${taxType} on ${asOf}`).toBe(1);
        }
      }
    }
  });
});

describe('a rate change lands on the right day', () => {
  /* Nova Scotia went from 15% to 14% on 1 April 2025. `effectiveTo` is exclusive, so
   * the last day at 15% is 31 March. A proposal dated the 1st is a 14% proposal. Both
   * assertions have to hold, or the table is a day out and quotes written around the
   * change are wrong by a point. */
  it('quotes Nova Scotia at 15% up to the day before, and 14% from the day itself', () => {
    expect(describeRates('NS', '2025-03-31')).toEqual(['HST 15']);
    expect(describeRates('NS', '2025-04-01')).toEqual(['HST 14']);
  });

  it('prices the same equipment differently either side of the change', () => {
    const charges = [{ category: 'EQUIPMENT' as const, usdMinor: 100_000n }];
    for (const [asOf, expected] of [
      ['2025-03-31', 15_000n],
      ['2025-04-01', 14_000n],
    ] as const) {
      const rate = applicableTaxTypes('NS', asOf, PRODUCTION_TAX_RATES)[0]!;
      const { basisMinor, missing } = taxableBasis(
        'HST',
        'NS',
        asOf,
        charges,
        PRODUCTION_TAXABILITY,
      );
      expect(missing).toEqual([]);
      expect(applyPercent(basisMinor, rate.ratePercent), asOf).toBe(expected);
    }
  });

  it('still quotes a pre-harmonization Prince Edward Island date at nothing rather than guessing', () => {
    // PEI harmonized in October 2016. A proposal dated before that has no rate on
    // file, which is the state the readiness panel reports as "not covered" — not a
    // silent zero-tax quote.
    expect(describeRates('PE', '2016-09-30')).toEqual([]);
    expect(describeRates('PE', '2016-10-01')).toEqual(['HST 15']);
  });
});

describe('taxability against the production table', () => {
  it('taxes equipment, freight and installation, and no border charge', () => {
    const charges = [
      { category: 'EQUIPMENT' as const, usdMinor: 100_000n },
      { category: 'FREIGHT' as const, usdMinor: 20_000n },
      { category: 'INSTALLATION' as const, usdMinor: 30_000n },
      { category: 'CUSTOMS_DUTY' as const, usdMinor: 5_000n },
      { category: 'BROKERAGE' as const, usdMinor: 7_500n },
    ];
    const { basisMinor, missing } = taxableBasis('HST', 'ON', ASOF, charges, PRODUCTION_TAXABILITY);
    expect(missing).toEqual([]);
    expect(basisMinor).toBe(150_000n);
    expect(applyPercent(basisMinor, '13')).toBe(19_500n);
  });

  it('reports a category nobody has ruled on instead of assuming it', () => {
    const { missing } = taxableBasis(
      'HST',
      'ON',
      ASOF,
      [{ category: 'DESIGN', usdMinor: 10_000n }],
      PRODUCTION_TAXABILITY,
    );
    expect(missing).toEqual(['DESIGN']);
  });
});
