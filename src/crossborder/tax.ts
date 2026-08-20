/**
 * Canadian sales tax — GST, HST, PST, RST and QST.
 *
 * A pure function over rule rows. Nothing here reads the database, the clock or
 * configuration: the caller loads the effective rules and passes them in, which is
 * what makes the whole of tax behaviour expressible as a fixture table.
 *
 * Three rules it will not break:
 *
 *   1. A province having a tax rate is not a reason to charge it. Tax is charged
 *      only where SSG holds a registration effective on the proposal date. A
 *      missing registration produces REQUIRES_TAX_REVIEW, never a silent zero and
 *      never a silent charge.
 *   2. HST is one line. It is never split into a federal and a provincial part on
 *      a customer-facing document.
 *   3. Manitoba is RST and Quebec is QST. They are not "PST". The label comes from
 *      the tax type on the rule, so there is no place to get this wrong.
 */
import type { ProvinceCode } from '../lib/country.js';

export type CanadianTaxType = 'GST' | 'HST' | 'PST' | 'RST' | 'QST' | 'IMPORT_GST';

/**
 * What a charge on a proposal is, for taxability purposes. Freight, installation,
 * brokerage and duty are all taxed differently from equipment in at least one
 * province, so they cannot share a category.
 */
export type ChargeCategory =
  | 'EQUIPMENT'
  | 'PARTS'
  | 'FREIGHT'
  | 'INSTALLATION'
  | 'DESIGN'
  | 'TRAINING'
  | 'TRAVEL'
  | 'CUSTOMS_DUTY'
  | 'TARIFF_SURTAX'
  | 'SIMA'
  | 'BROKERAGE'
  | 'BROKER_DISBURSEMENT'
  | 'IMPORT_TAX'
  | 'SALES_TAX'
  | 'DISCOUNT'
  | 'CREDIT'
  | 'OTHER';

export type TaxResponsibility =
  | 'SELLER_COLLECTS'
  | 'CUSTOMER_PAYS_AT_IMPORT'
  | 'SELLER_IS_IMPORTER_OF_RECORD'
  | 'TAX_EXEMPT'
  | 'REQUIRES_TAX_REVIEW';

export interface TaxRateRule {
  id: string;
  province: ProvinceCode;
  taxType: CanadianTaxType;
  /** Decimal string, e.g. "5", "13", "9.975". Never a float. */
  ratePercent: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
  /**
   * Tax types this rate is calculated ON TOP OF, when a jurisdiction genuinely
   * compounds. Empty for every current Canadian rate — Quebec stopped applying
   * QST to GST in 2013 — but the column exists so a future rule can express it
   * without a code change. Nothing compounds unless a rule says so.
   */
  compoundOn?: CanadianTaxType[];
}

export interface TaxabilityRule {
  id: string;
  category: ChargeCategory;
  taxType: CanadianTaxType;
  /** null means "every province", which is how the seed data is expressed. */
  province: ProvinceCode | null;
  taxable: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface TaxRegistration {
  taxType: CanadianTaxType;
  /**
   * null for GST/HST, which is federal and covers every province under one
   * number. Set for PST, RST and QST, which are registered province by province.
   */
  province: ProvinceCode | null;
  status: 'REGISTERED' | 'NOT_REGISTERED' | 'PENDING' | 'INACTIVE';
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface TaxExemption {
  taxTypes: CanadianTaxType[];
  certificateNumber: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  /**
   * An exemption suppresses tax only when an administrator has approved it. A
   * customer being a school, charity or public body is not itself an exemption,
   * and a rebate the customer can claim later is not a point-of-sale exemption.
   */
  approved: boolean;
}

export interface ChargeBasis {
  category: ChargeCategory;
  /** Authoritative USD minor units. Negative for discounts and credits. */
  usdMinor: bigint;
}

export type TaxLineStatus =
  'CHARGED' | 'NOT_REGISTERED' | 'EXEMPT' | 'REQUIRES_TAX_REVIEW' | 'NO_RATE';

export interface TaxLine {
  taxType: CanadianTaxType;
  /** What the customer sees: "GST", "HST", "PST", "RST", "QST". */
  label: string;
  ratePercent: string;
  taxableBasisUsdMinor: bigint;
  taxUsdMinor: bigint;
  rateRuleId: string | null;
  status: TaxLineStatus;
}

export type TaxIssue =
  | 'no_rate_for_province'
  | 'missing_registration'
  | 'registration_inactive'
  | 'missing_taxability_rule'
  | 'responsibility_requires_review';

export interface TaxResult {
  lines: TaxLine[];
  totalTaxUsdMinor: bigint;
  issues: TaxIssue[];
  /** False when any line needs a human before the proposal can go out as final. */
  readyForCustomer: boolean;
}

export interface TaxInput {
  province: ProvinceCode;
  /** The proposal date, as YYYY-MM-DD. Every rule is evaluated against it. */
  asOf: string;
  responsibility: TaxResponsibility;
  charges: ChargeBasis[];
  rates: TaxRateRule[];
  taxability: TaxabilityRule[];
  registrations: TaxRegistration[];
  exemptions: TaxExemption[];
}

function effective(from: string, to: string | null, asOf: string): boolean {
  // effectiveTo is EXCLUSIVE. Nova Scotia's HST went from 15% to 14% on
  // 2025-04-01, and the two rows are written as [.., 2025-04-01) and
  // [2025-04-01, ..) so exactly one of them is ever in force. Seed data and
  // admin entry must follow that convention.
  return from <= asOf && (to === null || asOf < to);
}

/** basis × percent, in bigint, rounded half-up away from zero. */
export function applyPercent(basisMinor: bigint, percent: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(percent)) throw new Error(`Invalid rate percent: ${percent}`);
  const [whole, frac = ''] = percent.split('.');
  const digits = BigInt(whole + frac);
  const divisor = 100n * 10n ** BigInt(frac.length);
  const product = basisMinor * digits;
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs * 2n + divisor) / (divisor * 2n);
  return negative ? -rounded : rounded;
}

/**
 * The tax types that apply in a province on a date.
 *
 * An HST province returns HST alone — the whole point of harmonization is that
 * there is one tax, and showing a customer a 5% GST line beside an 8% Ontario line
 * would be wrong as well as confusing.
 */
export function applicableTaxTypes(
  province: ProvinceCode,
  asOf: string,
  rates: TaxRateRule[],
): TaxRateRule[] {
  const live = rates.filter(
    (r) => r.province === province && effective(r.effectiveFrom, r.effectiveTo, asOf),
  );
  const hst = live.find((r) => r.taxType === 'HST');
  return hst ? [hst] : live.filter((r) => r.taxType !== 'IMPORT_GST');
}

/**
 * GST and HST are ONE federal registration.
 *
 * A business registers once for GST/HST and then charges GST in Alberta and HST in
 * Ontario under the same number. Requiring a separate row per tax type would mean a
 * correctly registered company failed the registration check in every HST province,
 * which blocks release on a proposal that is perfectly valid.
 *
 * PST, RST and QST are genuinely separate provincial registrations and are matched
 * exactly.
 */
const FEDERAL: CanadianTaxType[] = ['GST', 'HST'];

function registrationMatches(rowType: CanadianTaxType, wanted: CanadianTaxType): boolean {
  return FEDERAL.includes(wanted) ? FEDERAL.includes(rowType) : rowType === wanted;
}

function isRegistered(
  taxType: CanadianTaxType,
  province: ProvinceCode,
  asOf: string,
  registrations: TaxRegistration[],
): 'REGISTERED' | 'INACTIVE' | 'MISSING' {
  // A federal registration carries no province and covers every province. A
  // provincial one must match the province being quoted.
  const candidates = registrations.filter(
    (r) =>
      registrationMatches(r.taxType, taxType) &&
      (FEDERAL.includes(taxType) || r.province === province) &&
      effective(r.effectiveFrom, r.effectiveTo, asOf),
  );
  if (!candidates.length) return 'MISSING';
  return candidates.some((r) => r.status === 'REGISTERED') ? 'REGISTERED' : 'INACTIVE';
}

function exemptFrom(taxType: CanadianTaxType, asOf: string, exemptions: TaxExemption[]): boolean {
  return exemptions.some(
    (e) =>
      e.approved && e.taxTypes.includes(taxType) && effective(e.effectiveFrom, e.effectiveTo, asOf),
  );
}

/**
 * The taxable basis for one tax type: the sum of every charge whose taxability
 * rule says that charge is taxable for this tax type in this province.
 *
 * A charge category with NO applicable rule does not default to taxable or exempt.
 * It returns null, the caller raises `missing_taxability_rule`, and the proposal
 * needs a human. Defaulting either way here is how a freight line silently
 * acquires or loses 13% of tax.
 */
export function taxableBasis(
  taxType: CanadianTaxType,
  province: ProvinceCode,
  asOf: string,
  charges: ChargeBasis[],
  taxability: TaxabilityRule[],
): { basisMinor: bigint; missing: ChargeCategory[] } {
  let basisMinor = 0n;
  const missing: ChargeCategory[] = [];

  for (const charge of charges) {
    const applicable = taxability.filter(
      (t) =>
        t.category === charge.category &&
        t.taxType === taxType &&
        effective(t.effectiveFrom, t.effectiveTo, asOf),
    );
    // A province-specific rule wins over the "every province" default.
    const specific = applicable.find((t) => t.province === province);
    const general = applicable.find((t) => t.province === null);
    const rule = specific ?? general;

    if (!rule) {
      if (!missing.includes(charge.category)) missing.push(charge.category);
      continue;
    }
    if (rule.taxable) basisMinor += charge.usdMinor;
  }

  return { basisMinor, missing };
}

/** Compute every seller-collected Canadian tax line for a proposal. */
export function computeCanadianTax(input: TaxInput): TaxResult {
  const { province, asOf, responsibility, charges, rates, taxability, registrations, exemptions } =
    input;

  const empty = (issues: TaxIssue[], ready: boolean): TaxResult => ({
    lines: [],
    totalTaxUsdMinor: 0n,
    issues,
    readyForCustomer: ready,
  });

  // Only SELLER_COLLECTS produces seller tax lines. The other modes are legitimate
  // end states, not failures — except REQUIRES_TAX_REVIEW, which blocks release.
  switch (responsibility) {
    case 'CUSTOMER_PAYS_AT_IMPORT':
    case 'SELLER_IS_IMPORTER_OF_RECORD':
    case 'TAX_EXEMPT':
      return empty([], true);
    case 'REQUIRES_TAX_REVIEW':
      return empty(['responsibility_requires_review'], false);
    case 'SELLER_COLLECTS':
      break;
  }

  const applicable = applicableTaxTypes(province, asOf, rates);
  if (!applicable.length) return empty(['no_rate_for_province'], false);

  const lines: TaxLine[] = [];
  const issues: TaxIssue[] = [];
  let total = 0n;

  for (const rate of applicable) {
    const registration = isRegistered(rate.taxType, province, asOf, registrations);
    const { basisMinor, missing } = taxableBasis(rate.taxType, province, asOf, charges, taxability);

    if (missing.length && !issues.includes('missing_taxability_rule')) {
      issues.push('missing_taxability_rule');
    }

    let status: TaxLineStatus;
    let taxUsdMinor = 0n;

    if (registration === 'MISSING') {
      status = 'REQUIRES_TAX_REVIEW';
      if (!issues.includes('missing_registration')) issues.push('missing_registration');
    } else if (registration === 'INACTIVE') {
      status = 'NOT_REGISTERED';
      if (!issues.includes('registration_inactive')) issues.push('registration_inactive');
    } else if (exemptFrom(rate.taxType, asOf, exemptions)) {
      status = 'EXEMPT';
    } else if (missing.length) {
      status = 'REQUIRES_TAX_REVIEW';
    } else {
      status = 'CHARGED';
      taxUsdMinor = applyPercent(basisMinor, rate.ratePercent);
      total += taxUsdMinor;
    }

    lines.push({
      taxType: rate.taxType,
      label: rate.taxType === 'IMPORT_GST' ? 'Import GST' : rate.taxType,
      ratePercent: rate.ratePercent,
      taxableBasisUsdMinor: basisMinor,
      taxUsdMinor,
      rateRuleId: rate.id,
      status,
    });
  }

  return {
    lines,
    totalTaxUsdMinor: total,
    issues,
    readyForCustomer: !issues.length && lines.every((l) => l.status !== 'REQUIRES_TAX_REVIEW'),
  };
}
