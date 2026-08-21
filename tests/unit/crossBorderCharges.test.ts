import { describe, expect, it } from 'vitest';
import {
  buildChargeLines,
  type CustomsEntryInput,
  type PipelineInput,
} from '../../src/crossborder/chargeLines.js';
import type { TaxabilityRule, TaxRateRule, TaxRegistration } from '../../src/crossborder/tax.js';

/**
 * The six acceptance scenarios, as fixtures.
 *
 * A rate of 1.25 is used deliberately: it converts the round figures below without
 * a fractional cent, so every expectation is a number that can be checked by hand
 * rather than one copied out of a previous run. The rounding behaviour itself is
 * tested against a realistic rate in crossBorder.test.ts.
 */
const RATE = { rate: '1.25', observationDate: '2026-08-14' };

const RATES: TaxRateRule[] = [
  {
    id: 'ab-gst',
    province: 'AB',
    taxType: 'GST',
    ratePercent: '5',
    effectiveFrom: '2008-01-01',
    effectiveTo: null,
  },
  {
    id: 'bc-gst',
    province: 'BC',
    taxType: 'GST',
    ratePercent: '5',
    effectiveFrom: '2013-04-01',
    effectiveTo: null,
  },
  {
    id: 'bc-pst',
    province: 'BC',
    taxType: 'PST',
    ratePercent: '7',
    effectiveFrom: '2013-04-01',
    effectiveTo: null,
  },
  {
    id: 'on-hst',
    province: 'ON',
    taxType: 'HST',
    ratePercent: '13',
    effectiveFrom: '2010-07-01',
    effectiveTo: null,
  },
  {
    id: 'qc-gst',
    province: 'QC',
    taxType: 'GST',
    ratePercent: '5',
    effectiveFrom: '2008-01-01',
    effectiveTo: null,
  },
  {
    id: 'qc-qst',
    province: 'QC',
    taxType: 'QST',
    ratePercent: '9.975',
    effectiveFrom: '2013-01-01',
    effectiveTo: null,
  },
  {
    id: 'ns-hst-15',
    province: 'NS',
    taxType: 'HST',
    ratePercent: '15',
    effectiveFrom: '2010-07-01',
    effectiveTo: '2025-04-01',
  },
  {
    id: 'ns-hst-14',
    province: 'NS',
    taxType: 'HST',
    ratePercent: '14',
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
  },
];

/** Equipment and freight taxable everywhere; border charges not. As seeded. */
const TAXABILITY: TaxabilityRule[] = [
  ...(['GST', 'HST', 'PST', 'RST', 'QST'] as const).flatMap((taxType) =>
    (['EQUIPMENT', 'FREIGHT'] as const).map((category) => ({
      id: `${category}-${taxType}`,
      category,
      taxType,
      province: null,
      taxable: true,
      effectiveFrom: '2008-01-01',
      effectiveTo: null,
    })),
  ),
  ...(['GST', 'HST', 'PST', 'RST', 'QST'] as const).flatMap((taxType) =>
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

const FEDERAL: TaxRegistration[] = [
  {
    taxType: 'GST',
    province: null,
    status: 'REGISTERED',
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
  },
];

const SELLER = [
  { category: 'EQUIPMENT' as const, label: 'Equipment', usdMinor: 100_000 },
  { category: 'FREIGHT' as const, label: 'Freight', usdMinor: 20_000 },
];

/** Nothing entered yet — the state every Canadian proposal starts in. */
const UNREVIEWED: CustomsEntryInput = {
  status: 'REQUIRES_CUSTOMS_REVIEW',
  currency: 'CAD',
  dutyMinor: null,
  surtaxMinor: null,
  simaMinor: null,
  otherDutyMinor: null,
  importTaxMinor: null,
  brokerFeeMinor: null,
  importerOfRecord: 'CUSTOMER',
  includedInSellerTotal: false,
};

function run(over: Partial<PipelineInput> = {}) {
  return buildChargeLines({
    province: 'AB',
    asOf: '2026-08-20',
    fx: RATE,
    sellerCharges: SELLER,
    customs: UNREVIEWED,
    taxResponsibility: 'SELLER_COLLECTS',
    rates: RATES,
    taxability: TAXABILITY,
    registrations: FEDERAL,
    exemptions: [],
    ...over,
  });
}

const line = (r: ReturnType<typeof run>, label: string) => r.lines.find((l) => l.label === label);

describe('an unquoted border charge', () => {
  it('appears as a line with no amount, never as zero', () => {
    const duty = line(run(), 'Customs duty');
    expect(duty).toBeDefined();
    expect(duty?.usdMinor).toBeNull();
    expect(duty?.cadMinor).toBeNull();
    expect(duty?.status).toBe('REQUIRES_CUSTOMS_REVIEW');
  });

  it('reports an unconfigured broker fee as to be confirmed', () => {
    const r = run();
    expect(line(r, 'Customs brokerage')?.status).toBe('TO_BE_CONFIRMED');
    expect(line(r, 'Customs brokerage')?.usdMinor).toBeNull();
    expect(r.issues).toContain('broker_fee_unconfirmed');
  });

  it('contributes nothing to any total', () => {
    const r = run();
    expect(r.separatelyPayable.usdMinor).toBe(0);
    // Equipment + freight + 5% GST on both.
    expect(r.payableToSummit.usdMinor).toBe(126_000);
  });

  it('blocks the proposal from going out as final', () => {
    expect(run().readyForCustomer).toBe(false);
  });
});

describe('Calgary, Alberta — customer is importer of record', () => {
  const customs: CustomsEntryInput = {
    ...UNREVIEWED,
    status: 'ESTIMATED',
    dutyMinor: 10_000, // CAD 100.00
    brokerFeeMinor: 25_000, // CAD 250.00
    importerOfRecord: 'CUSTOMER',
    includedInSellerTotal: false,
  };

  it('charges GST only, with no provincial line', () => {
    const r = run({ customs });
    const tax = r.lines.filter((l) => l.category === 'SALES_TAX');
    expect(tax.map((l) => l.label)).toEqual(['GST']);
    expect(tax[0]?.usdMinor).toBe(6_000);
  });

  it('keeps duty and brokerage out of the amount payable to Summit', () => {
    const r = run({ customs });
    expect(r.payableToSummit.usdMinor).toBe(126_000);
    // CAD 100 duty and CAD 250 brokerage, converted at 1.25.
    expect(r.separatelyPayable.usdMinor).toBe(8_000 + 20_000);
    expect(r.estimatedLandedCost.usdMinor).toBe(154_000);
  });

  it('names who each border charge is payable to', () => {
    const r = run({ customs });
    expect(line(r, 'Customs duty')?.payableTo).toBe('CUSTOMS_OR_BROKER');
    expect(line(r, 'GST')?.payableTo).toBe('SUMMIT');
  });

  it('does not tax the border charges', () => {
    // 5% of equipment + freight only, not of duty or brokerage.
    expect(line(run({ customs }), 'GST')?.taxableBasisUsdMinor).toBe(120_000);
  });

  it('records a CAD-quoted fee as CAD with a USD equivalent', () => {
    const fee = line(run({ customs }), 'Customs brokerage');
    expect(fee?.sourceCurrency).toBe('CAD');
    expect(fee?.sourceAmountMinor).toBe(25_000);
    expect(fee?.usdMinor).toBe(20_000);
    expect(fee?.calculationSource).toBe('FX_CONVERSION');
  });
});

describe('Vancouver, British Columbia', () => {
  const registrations: TaxRegistration[] = [
    ...FEDERAL,
    {
      taxType: 'PST',
      province: 'BC',
      status: 'REGISTERED',
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
    },
  ];

  it('produces separate GST and PST lines', () => {
    const r = run({ province: 'BC', registrations });
    const tax = r.lines.filter((l) => l.category === 'SALES_TAX');
    expect(tax.map((l) => l.label).sort()).toEqual(['GST', 'PST']);
    expect(line(r, 'GST')?.usdMinor).toBe(6_000);
    expect(line(r, 'PST')?.usdMinor).toBe(8_400);
  });

  it('taxes freight along with the equipment', () => {
    expect(line(run({ province: 'BC', registrations }), 'PST')?.taxableBasisUsdMinor).toBe(120_000);
  });

  it('needs review when the PST registration is missing', () => {
    const r = run({ province: 'BC' });
    expect(line(r, 'PST')?.status).toBe('REQUIRES_TAX_REVIEW');
    expect(line(r, 'PST')?.usdMinor).toBeNull();
    expect(r.readyForCustomer).toBe(false);
  });

  it('has no rate before the province left HST', () => {
    const r = run({ province: 'BC', asOf: '2012-06-01', registrations });
    expect(r.lines.filter((l) => l.category === 'SALES_TAX')).toEqual([]);
    expect(r.tax.issues).toContain('no_rate_for_province');
  });
});

describe('Toronto, Ontario — Summit is importer of record', () => {
  const customs: CustomsEntryInput = {
    ...UNREVIEWED,
    status: 'CONFIRMED',
    currency: 'USD',
    dutyMinor: 5_000,
    brokerFeeMinor: 15_000,
    importerOfRecord: 'SUMMIT',
    includedInSellerTotal: true,
  };

  it('shows one HST line, never split into federal and provincial parts', () => {
    const r = run({ province: 'ON', customs });
    const tax = r.lines.filter((l) => l.category === 'SALES_TAX');
    expect(tax).toHaveLength(1);
    expect(tax[0]?.label).toBe('HST');
    expect(tax[0]?.percent).toBe('13');
  });

  it('adds the duty and brokerage it is collecting to the Summit total', () => {
    const r = run({ province: 'ON', customs });
    expect(r.separatelyPayable.usdMinor).toBe(0);
    // 100,000 + 20,000 + 5,000 duty + 15,000 brokerage + 13% of the taxable 120,000.
    expect(r.payableToSummit.usdMinor).toBe(140_000 + 15_600);
    expect(line(r, 'Customs duty')?.payableTo).toBe('SUMMIT');
  });

  it('still does not tax the border charges it collects', () => {
    // They are in the seller total, but the taxability rule says not taxable —
    // the rule decides, not the total.
    expect(line(run({ province: 'ON', customs }), 'HST')?.taxableBasisUsdMinor).toBe(120_000);
  });

  it('marks a confirmed entry as confirmed rather than estimated', () => {
    expect(line(run({ province: 'ON', customs }), 'Customs duty')?.status).toBe('CONFIRMED');
  });

  it('reads a blank field on a confirmed entry as a charge that does not arise', () => {
    // A reviewer signed this entry off. A blank surtax means there is no surtax,
    // not that nobody has looked — so it must not read "to be confirmed".
    const r = run({ province: 'ON', customs });
    expect(line(r, 'Tariff or surtax')?.status).toBe('NOT_APPLICABLE');
    expect(line(r, 'Tariff or surtax')?.usdMinor).toBeNull();
  });

  it('is ready for the customer once customs is confirmed', () => {
    expect(run({ province: 'ON', customs }).readyForCustomer).toBe(true);
  });
});

describe('a customer who arranges their own broker', () => {
  it('does not hold the proposal up over a blank broker fee', () => {
    // Confirmed entry, no brokerage line of our own. Before this was handled, a
    // blank fee raised broker_fee_unconfirmed forever and nothing could be
    // released.
    const r = run({
      province: 'ON',
      customs: {
        ...UNREVIEWED,
        status: 'CONFIRMED',
        currency: 'USD',
        dutyMinor: 5_000,
        brokerFeeMinor: null,
        includedInSellerTotal: false,
      },
    });
    expect(line(r, 'Customs brokerage')?.status).toBe('NOT_APPLICABLE');
    expect(r.issues).not.toContain('broker_fee_unconfirmed');
    expect(r.readyForCustomer).toBe(true);
  });

  it('still holds it up when nobody has reviewed customs at all', () => {
    const r = run({ province: 'ON' });
    expect(r.issues).toContain('broker_fee_unconfirmed');
    expect(r.issues).toContain('customs_requires_review');
  });
});

describe('Montreal, Quebec', () => {
  const registrations: TaxRegistration[] = [
    ...FEDERAL,
    {
      taxType: 'QST',
      province: 'QC',
      status: 'REGISTERED',
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
    },
  ];

  it('labels the provincial tax QST and does not compound it on GST', () => {
    const r = run({ province: 'QC', registrations });
    expect(line(r, 'QST')?.usdMinor).toBe(11_970);
    expect(line(r, 'QST')?.taxableBasisUsdMinor).toBe(120_000);
    expect(line(r, 'GST')?.usdMinor).toBe(6_000);
  });

  it('suppresses only the exempted tax once an exemption is approved', () => {
    const r = run({
      province: 'QC',
      registrations,
      exemptions: [
        {
          taxTypes: ['QST'],
          certificateNumber: 'QC-1',
          effectiveFrom: '2020-01-01',
          effectiveTo: null,
          approved: true,
        },
      ],
    });
    expect(line(r, 'QST')?.status).toBe('EXEMPT');
    expect(line(r, 'QST')?.usdMinor).toBeNull();
    expect(line(r, 'GST')?.status).toBe('CALCULATED');
  });

  it('ignores an exemption nobody approved', () => {
    const r = run({
      province: 'QC',
      registrations,
      exemptions: [
        {
          taxTypes: ['QST'],
          certificateNumber: 'QC-1',
          effectiveFrom: '2020-01-01',
          effectiveTo: null,
          approved: false,
        },
      ],
    });
    expect(line(r, 'QST')?.usdMinor).toBe(11_970);
  });
});

describe('Halifax, Nova Scotia', () => {
  it('uses the rate in force on the proposal date', () => {
    expect(line(run({ province: 'NS', asOf: '2025-03-31' }), 'HST')?.percent).toBe('15');
    expect(line(run({ province: 'NS', asOf: '2026-08-20' }), 'HST')?.percent).toBe('14');
    expect(line(run({ province: 'NS', asOf: '2026-08-20' }), 'HST')?.usdMinor).toBe(16_800);
  });
});

describe('currency presentation', () => {
  it('gives every amount-bearing line a CAD equivalent', () => {
    const r = run({ province: 'ON' });
    for (const l of r.lines) {
      if (l.usdMinor === null) expect(l.cadMinor).toBeNull();
      else expect(l.cadMinor).toBe(Math.round(l.usdMinor * 1.25));
    }
  });

  it('makes the CAD column add up to the CAD total', () => {
    const r = run({ province: 'ON' });
    const summed = r.lines
      .filter((l) => l.includedInSellerTotal && l.cadMinor !== null)
      .reduce((t, l) => t + (l.cadMinor as number), 0);
    expect(r.payableToSummit.cadMinor).toBe(summed);
  });

  it('stamps every line with the rate and its observation date', () => {
    for (const l of run().lines) {
      expect(l.exchangeRate).toBe('1.25');
      expect(l.exchangeRateDate).toBe('2026-08-14');
    }
  });
});

describe('tax responsibility', () => {
  it('charges no seller tax when the customer pays at import', () => {
    const r = run({ province: 'ON', taxResponsibility: 'CUSTOMER_PAYS_AT_IMPORT' });
    expect(r.lines.filter((l) => l.category === 'SALES_TAX')).toEqual([]);
    expect(r.payableToSummit.usdMinor).toBe(120_000);
  });

  it('raises no customs lines at all when the border does not apply', () => {
    const r = run({ customs: { ...UNREVIEWED, status: 'NOT_APPLICABLE' } });
    expect(r.lines.some((l) => l.category === 'CUSTOMS_DUTY')).toBe(false);
    expect(r.issues).not.toContain('customs_requires_review');
  });

  it('flags an undetermined importer of record', () => {
    const r = run({ customs: { ...UNREVIEWED, importerOfRecord: 'TO_BE_DETERMINED' } });
    expect(r.issues).toContain('importer_of_record_undetermined');
  });
});

describe('discounts', () => {
  it('reduces the taxable basis and rounds the same way as a charge', () => {
    const r = run({
      province: 'ON',
      sellerCharges: [
        ...SELLER,
        { category: 'DISCOUNT' as const, label: 'Discount', usdMinor: -20_000 },
      ],
      taxability: [
        ...TAXABILITY,
        {
          id: 'disc-hst',
          category: 'DISCOUNT',
          taxType: 'HST',
          province: null,
          taxable: true,
          effectiveFrom: '2008-01-01',
          effectiveTo: null,
        },
      ],
    });
    expect(line(r, 'HST')?.taxableBasisUsdMinor).toBe(100_000);
    expect(line(r, 'HST')?.usdMinor).toBe(13_000);
    expect(line(r, 'Discount')?.cadMinor).toBe(-25_000);
  });
});
