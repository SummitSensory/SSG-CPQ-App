/**
 * The Canadian rate table as it stands in production, as a fixture.
 *
 * Nothing seeds these rates into the database — an administrator types them in with
 * a source against each one, because a rate this application invented is a rate
 * nobody checked. But the arithmetic still has to be tested against the real table
 * and not only against round numbers, for one reason: every rate row is bounded by
 * DATES, and a date that is off by a day is invisible in a fixture built from 5%
 * and 13%. Nova Scotia is the case that catches it, so it is here twice.
 *
 * `effectiveTo` is EXCLUSIVE everywhere in this codebase. A row ending 2025-04-01
 * does not apply on 2025-04-01; the row beginning that day does. Abutting rows must
 * share the boundary date exactly.
 *
 * Rates below are the ones in force in August 2026 and the dates they took effect.
 * If a province changes its rate, this fixture and the production table both change
 * — and `canadianRateFixture.test.ts` is what fails if only one of them does.
 */
import type { ProvinceCode } from '../../src/lib/country.js';
import type { CanadianTaxType, TaxRateRule, TaxabilityRule } from '../../src/crossborder/tax.js';

/** Every province and territory a proposal can ship to. */
export const ALL_PROVINCES: ProvinceCode[] = [
  'AB',
  'BC',
  'MB',
  'NB',
  'NL',
  'NS',
  'NT',
  'NU',
  'ON',
  'PE',
  'QC',
  'SK',
  'YT',
];

/** The five provinces where HST replaces GST outright. */
export const HST_PROVINCES: ProvinceCode[] = ['NB', 'NL', 'NS', 'ON', 'PE'];

export const PRODUCTION_TAX_RATES: TaxRateRule[] = [
  // GST, 5% federal, in every province that has not harmonized.
  ...(['AB', 'BC', 'MB', 'NT', 'NU', 'QC', 'SK', 'YT'] as ProvinceCode[]).map((province) => ({
    id: `gst-${province.toLowerCase()}`,
    province,
    taxType: 'GST' as CanadianTaxType,
    ratePercent: '5',
    effectiveFrom: '2008-01-01',
    effectiveTo: null,
  })),

  // HST. One line to the customer, no GST line beside it.
  {
    id: 'hst-on',
    province: 'ON',
    taxType: 'HST',
    ratePercent: '13',
    effectiveFrom: '2010-07-01',
    effectiveTo: null,
  },
  {
    id: 'hst-nb',
    province: 'NB',
    taxType: 'HST',
    ratePercent: '15',
    effectiveFrom: '2016-07-01',
    effectiveTo: null,
  },
  {
    id: 'hst-nl',
    province: 'NL',
    taxType: 'HST',
    ratePercent: '15',
    effectiveFrom: '2016-07-01',
    effectiveTo: null,
  },
  {
    id: 'hst-pe',
    province: 'PE',
    taxType: 'HST',
    ratePercent: '15',
    effectiveFrom: '2016-10-01',
    effectiveTo: null,
  },
  // Nova Scotia cut its rate on 1 April 2025. Both rows are kept: a proposal dated
  // before that day is still quoted, revised and invoiced at 15%.
  {
    id: 'hst-ns-15',
    province: 'NS',
    taxType: 'HST',
    ratePercent: '15',
    effectiveFrom: '2010-07-01',
    effectiveTo: '2025-04-01',
  },
  {
    id: 'hst-ns-14',
    province: 'NS',
    taxType: 'HST',
    ratePercent: '14',
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
  },

  // Provincial sales taxes, one per province, under three different names.
  {
    id: 'pst-bc',
    province: 'BC',
    taxType: 'PST',
    ratePercent: '7',
    effectiveFrom: '2013-04-01',
    effectiveTo: null,
  },
  {
    id: 'pst-sk',
    province: 'SK',
    taxType: 'PST',
    ratePercent: '6',
    effectiveFrom: '2017-03-23',
    effectiveTo: null,
  },
  {
    id: 'rst-mb',
    province: 'MB',
    taxType: 'RST',
    ratePercent: '7',
    effectiveFrom: '2019-07-01',
    effectiveTo: null,
  },
  {
    id: 'qst-qc',
    province: 'QC',
    taxType: 'QST',
    ratePercent: '9.975',
    effectiveFrom: '2013-01-01',
    effectiveTo: null,
  },
];

/** The rate a province charges on equipment in August 2026, for assertions. */
export const EXPECTED_2026: Record<string, string[]> = {
  AB: ['GST 5'],
  BC: ['GST 5', 'PST 7'],
  MB: ['GST 5', 'RST 7'],
  NB: ['HST 15'],
  NL: ['HST 15'],
  NS: ['HST 14'],
  NT: ['GST 5'],
  NU: ['GST 5'],
  ON: ['HST 13'],
  PE: ['HST 15'],
  QC: ['GST 5', 'QST 9.975'],
  SK: ['GST 5', 'PST 6'],
  YT: ['GST 5'],
};

const TAX_TYPES: CanadianTaxType[] = ['GST', 'HST', 'PST', 'RST', 'QST'];

/**
 * Taxability as an administrator would enter it: equipment and freight taxable,
 * border charges not. Deliberately NOT a default in the application — a category
 * with no rule sends the proposal to review instead of guessing.
 */
export const PRODUCTION_TAXABILITY: TaxabilityRule[] = [
  ...TAX_TYPES.flatMap((taxType) =>
    (['EQUIPMENT', 'PARTS', 'INSTALLATION', 'FREIGHT'] as const).map((category) => ({
      id: `${category}-${taxType}`,
      category,
      taxType,
      province: null,
      taxable: true,
      effectiveFrom: '2008-01-01',
      effectiveTo: null,
    })),
  ),
  ...TAX_TYPES.flatMap((taxType) =>
    (['CUSTOMS_DUTY', 'TARIFF_SURTAX', 'SIMA', 'IMPORT_TAX', 'BROKERAGE', 'OTHER'] as const).map(
      (category) => ({
        id: `${category}-${taxType}`,
        category,
        taxType,
        province: null,
        taxable: false,
        effectiveFrom: '2008-01-01',
        effectiveTo: null,
      }),
    ),
  ),
];
