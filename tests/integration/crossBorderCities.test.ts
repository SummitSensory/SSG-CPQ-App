/**
 * The six city fixtures.
 *
 * Every other cross-border test proves one module. This one runs a whole proposal
 * through the pipeline — rates, taxability, registrations, customs figures, FX — once
 * per tax regime Canada actually has, and asserts what would print on the document.
 *
 * Six cities because there are six regimes, not because six is a nice number:
 *
 *   Toronto     ON   HST, one line at 13%
 *   Halifax     NS   HST at 14% — the rate that changed on 2025-04-01
 *   Vancouver   BC   GST + PST, two lines, neither compounding
 *   Winnipeg    MB   GST + RST — RST, not PST, and the label matters
 *   Montreal    QC   GST + QST at 9.975%, on the same base as GST
 *   Calgary     AB   GST alone
 *
 * The rule tables here are written out in full rather than read from the database.
 * That is the point: these are the answers the engine must give for a KNOWN rule set,
 * so a seeded rate being wrong shows up as a failing seed test, not as six failing
 * pipeline tests that say nothing about which layer moved.
 */
import { describe, expect, it } from 'vitest';
import {
  buildChargeLines,
  type PipelineInput,
  type SellerCharge,
} from '../../src/crossborder/chargeLines.js';
import type {
  ChargeCategory,
  CanadianTaxType,
  TaxRateRule,
  TaxabilityRule,
  TaxRegistration,
} from '../../src/crossborder/tax.js';
import type { ProvinceCode } from '../../src/lib/country.js';

const AS_OF = '2026-08-21';

/** 1 USD = 1.3729 CAD. A real-looking rate with an exact cent product, so an assertion
 *  that fails is a bug rather than a rounding argument. */
const FX = { rate: '1.372900', observationDate: '2026-08-20' };

/* ── The rule set ──────────────────────────────────────────────────────────── */

const rate = (
  province: ProvinceCode,
  taxType: CanadianTaxType,
  ratePercent: string,
  effectiveFrom = '2016-01-01',
  effectiveTo: string | null = null,
): TaxRateRule => ({
  id: `${province}_${taxType}_${effectiveFrom}`,
  province,
  taxType,
  ratePercent,
  effectiveFrom,
  effectiveTo,
});

const RATES: TaxRateRule[] = [
  rate('ON', 'HST', '13'),
  // Nova Scotia's two rows, written as [.., 2025-04-01) and [2025-04-01, ..) so
  // exactly one is ever in force. The boundary is asserted below.
  rate('NS', 'HST', '15', '2016-01-01', '2025-04-01'),
  rate('NS', 'HST', '14', '2025-04-01'),
  rate('BC', 'GST', '5'),
  rate('BC', 'PST', '7'),
  rate('MB', 'GST', '5'),
  rate('MB', 'RST', '7'),
  rate('QC', 'GST', '5'),
  rate('QC', 'QST', '9.975'),
  rate('AB', 'GST', '5'),
];

const TAX_TYPES: CanadianTaxType[] = ['GST', 'HST', 'PST', 'RST', 'QST'];

/** Equipment and freight form the consideration; border charges do not. */
const taxabilityFor = (category: ChargeCategory, taxable: boolean): TaxabilityRule[] =>
  TAX_TYPES.map((taxType) => ({
    id: `${category}_${taxType}`,
    category,
    taxType,
    province: null,
    taxable,
    effectiveFrom: '2016-01-01',
    effectiveTo: null,
  }));

const TAXABILITY: TaxabilityRule[] = [
  ...taxabilityFor('EQUIPMENT', true),
  ...taxabilityFor('FREIGHT', true),
  ...taxabilityFor('CUSTOMS_DUTY', false),
  ...taxabilityFor('BROKERAGE', false),
  ...taxabilityFor('IMPORT_TAX', false),
  // INSTALLATION is deliberately absent — see the last test in this file.
];

const registration = (
  taxType: CanadianTaxType,
  province: ProvinceCode | null,
): TaxRegistration => ({
  taxType,
  province,
  status: 'REGISTERED',
  effectiveFrom: '2016-01-01',
  effectiveTo: null,
});

/** One federal row covers GST and HST in every province. The rest are per province. */
const REGISTRATIONS: TaxRegistration[] = [
  registration('GST', null),
  registration('PST', 'BC'),
  registration('RST', 'MB'),
  registration('QST', 'QC'),
];

/* ── The proposal ──────────────────────────────────────────────────────────── */

/** $50,000 of equipment and $2,000 of freight. USD, minor units. */
const SELLER_CHARGES: SellerCharge[] = [
  { category: 'EQUIPMENT', label: 'Adventure Series structure', usdMinor: 5_000_000 },
  { category: 'FREIGHT', label: 'Freight', usdMinor: 200_000 },
];

const TAXABLE_BASE = 5_200_000;

/** Duty of CA$1,000, approved, paid by the customer at the border. */
const CUSTOMS = {
  status: 'CONFIRMED' as const,
  currency: 'CAD' as const,
  dutyMinor: 100_000,
  surtaxMinor: null,
  simaMinor: null,
  otherDutyMinor: null,
  importTaxMinor: null,
  brokerFeeMinor: null,
  importerOfRecord: 'CUSTOMER' as const,
  includedInSellerTotal: false,
};

const run = (province: ProvinceCode, over: Partial<PipelineInput> = {}) =>
  buildChargeLines({
    province,
    asOf: AS_OF,
    fx: FX,
    sellerCharges: SELLER_CHARGES,
    customs: CUSTOMS,
    taxResponsibility: 'SELLER_COLLECTS',
    rates: RATES,
    taxability: TAXABILITY,
    registrations: REGISTRATIONS,
    exemptions: [],
    ...over,
  });

/** The charged tax lines as `LABEL rate = amount`, which is what a reader checks. */
const charged = (province: ProvinceCode) =>
  run(province)
    .tax.lines.filter((l) => l.status === 'CHARGED')
    .map((l) => `${l.label} ${l.ratePercent}% = ${l.taxUsdMinor}`);

/* ── The six ───────────────────────────────────────────────────────────────── */

describe('city fixtures', () => {
  it('Toronto — one HST line at 13%, never split into federal and provincial parts', () => {
    expect(charged('ON')).toEqual(['HST 13% = 676000']);
    expect(run('ON').tax.readyForCustomer).toBe(true);
  });

  it('Halifax — HST at 14%, the post-2025 rate', () => {
    expect(charged('NS')).toEqual(['HST 14% = 728000']);
  });

  it('Halifax before 2025-04-01 — the old 15% row, because effectiveTo is exclusive', () => {
    const before = run('NS', { asOf: '2025-03-31' });
    const on = run('NS', { asOf: '2025-04-01' });
    expect(before.tax.lines.map((l) => l.ratePercent)).toEqual(['15']);
    expect(on.tax.lines.map((l) => l.ratePercent)).toEqual(['14']);
  });

  it('Vancouver — GST and PST as two lines, neither compounding on the other', () => {
    expect(charged('BC')).toEqual(['GST 5% = 260000', 'PST 7% = 364000']);
    // 5% + 7% of the same base, not 7% of a base that already carries the 5%.
    const total = run('BC').tax.totalTaxUsdMinor;
    expect(total).toBe(624_000n);
  });

  it('Winnipeg — RST, labelled RST and not PST', () => {
    expect(charged('MB')).toEqual(['GST 5% = 260000', 'RST 7% = 364000']);
  });

  it('Montreal — QST at 9.975%, on the same base as GST', () => {
    expect(charged('QC')).toEqual(['GST 5% = 260000', 'QST 9.975% = 518700']);
    // 9.975% of 5,200,000 is 518,700 exactly. Of a GST-inclusive base it would be
    // 544,635 — the 2013 rule change this asserts has not been undone.
    expect(run('QC').tax.lines[1].taxableBasisUsdMinor).toBe(BigInt(TAXABLE_BASE));
  });

  it('Calgary — GST alone, and no empty provincial line', () => {
    expect(charged('AB')).toEqual(['GST 5% = 260000']);
    expect(run('AB').tax.lines).toHaveLength(1);
  });
});

/* ── The three totals ──────────────────────────────────────────────────────── */

describe('the three totals', () => {
  it('keeps a customer-paid duty out of what Summit is owed', () => {
    const r = run('ON');
    // Equipment + freight + HST. The duty is the customer's to pay at the border.
    expect(r.payableToSummit.usdMinor).toBe(TAXABLE_BASE + 676_000);
    expect(r.separatelyPayable.usdMinor).toBeGreaterThan(0);
    expect(r.estimatedLandedCost.usdMinor).toBe(
      r.payableToSummit.usdMinor + r.separatelyPayable.usdMinor,
    );
  });

  it('moves the duty into Summit’s total when Summit is collecting it', () => {
    const r = run('ON', { customs: { ...CUSTOMS, includedInSellerTotal: true } });
    expect(r.separatelyPayable.usdMinor).toBe(0);
    expect(r.payableToSummit.usdMinor).toBeGreaterThan(TAXABLE_BASE + 676_000);
  });

  it('converts every total at the one rate the proposal is quoted on', () => {
    const r = run('ON');
    // 5,200,000 + 676,000 = 5,876,000 USD minor. The CAD total is the sum of the
    // ROUNDED CAD lines, not a conversion of the USD total, so the CAD column a
    // customer checks with a calculator adds up: 6,864,500 + 274,580 + 928,080.
    expect(r.payableToSummit.cadMinor).toBe(8_067_160);
    expect(r.lines.every((l) => l.exchangeRate === FX.rate)).toBe(true);
  });

  it('CAD lines still sum to the CAD total with four lines and two tax rates', () => {
    // 6,864,500 + 274,580 + 356,954 (GST) + 499,736 (PST). Half-up away from zero on
    // every line is what makes the parts and the whole agree; banker's rounding on
    // the PST line would leave the column a cent short of its own total.
    expect(run('BC').payableToSummit.cadMinor).toBe(7_995_770);
  });
});

/* ── The gates ─────────────────────────────────────────────────────────────── */

describe('what holds a Canadian proposal up', () => {
  it('will not charge PST where there is no PST registration', () => {
    const r = run('BC', { registrations: [registration('GST', null)] });
    const pst = r.tax.lines.find((l) => l.taxType === 'PST');
    // A missing registration is a REVIEW, not a quiet zero: it may mean Summit has
    // to register before quoting British Columbia at all.
    expect(pst?.status).toBe('REQUIRES_TAX_REVIEW');
    expect(pst?.taxUsdMinor).toBe(0n);
    expect(r.tax.issues).toContain('missing_registration');
    expect(r.readyForCustomer).toBe(false);
    // The GST line beside it is unaffected — one missing provincial registration
    // does not stop the federal tax being charged.
    expect(r.tax.lines[0].status).toBe('CHARGED');
  });

  it('accepts the federal registration in an HST province — GST and HST are one number', () => {
    // The regression this file exists to lock: matching taxType exactly meant a
    // correctly registered company failed the check in every HST province.
    const r = run('ON', { registrations: [registration('GST', null)] });
    expect(r.tax.lines[0].status).toBe('CHARGED');
  });

  it('holds the proposal when a charge category has no taxability rule at all', () => {
    const r = run('ON', {
      sellerCharges: [
        ...SELLER_CHARGES,
        { category: 'INSTALLATION', label: 'Installation', usdMinor: 800_000 },
      ],
    });
    // Installation into real property varies by province and has no seeded rule, so
    // it goes to review rather than defaulting to taxable or exempt.
    expect(r.tax.issues).toContain('missing_taxability_rule');
    expect(r.readyForCustomer).toBe(false);
  });

  it('holds the proposal while the customs figures are unreviewed', () => {
    const r = run('ON', {
      customs: { ...CUSTOMS, status: 'REQUIRES_CUSTOMS_REVIEW', dutyMinor: null },
    });
    expect(r.issues).toContain('customs_requires_review');
    expect(r.readyForCustomer).toBe(false);
    // And the duty line still appears, unpriced. Silence about a duty reads as no
    // duty, which is the misreading the whole design exists to prevent.
    const duty = r.lines.find((l) => l.category === 'CUSTOMS_DUTY');
    expect(duty?.status).toBe('REQUIRES_CUSTOMS_REVIEW');
    expect(duty?.usdMinor).toBeNull();
  });

  it('treats a blank figure on an approved entry as a charge that does not arise', () => {
    const r = run('ON');
    const brokerage = r.lines.find((l) => l.category === 'BROKERAGE');
    expect(brokerage?.status).toBe('NOT_APPLICABLE');
    // The ordinary case: the customer arranges their own broker. It must not hold
    // the proposal up.
    expect(r.issues).not.toContain('broker_fee_unconfirmed');
    expect(r.readyForCustomer).toBe(true);
  });

  it('holds the proposal when the importer of record is undetermined', () => {
    const r = run('ON', {
      customs: { ...CUSTOMS, importerOfRecord: 'TO_BE_DETERMINED' },
    });
    expect(r.issues).toContain('importer_of_record_undetermined');
    expect(r.readyForCustomer).toBe(false);
  });

  it('charges no tax where the customer pays it at import', () => {
    const r = run('ON', { taxResponsibility: 'CUSTOMER_PAYS_AT_IMPORT' });
    expect(r.tax.totalTaxUsdMinor).toBe(0n);
    expect(r.payableToSummit.usdMinor).toBe(TAXABLE_BASE);
  });

  it('suppresses tax only for an APPROVED exemption', () => {
    const unapproved = run('ON', {
      exemptions: [
        {
          taxTypes: ['HST'],
          certificateNumber: 'X',
          effectiveFrom: '2016-01-01',
          effectiveTo: null,
          approved: false,
        },
      ],
    });
    const approved = run('ON', {
      exemptions: [
        {
          taxTypes: ['HST'],
          certificateNumber: 'X',
          effectiveFrom: '2016-01-01',
          effectiveTo: null,
          approved: true,
        },
      ],
    });
    // Being a school or a charity is not itself an exemption, and a rebate the
    // customer claims later is not a point-of-sale one.
    expect(unapproved.tax.lines[0].status).toBe('CHARGED');
    expect(approved.tax.lines[0].status).toBe('EXEMPT');
    expect(approved.tax.totalTaxUsdMinor).toBe(0n);
  });
});
