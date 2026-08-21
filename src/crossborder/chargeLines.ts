/**
 * The Canadian charge-line pipeline.
 *
 * Turns a proposal's USD figures into the lines a Canadian proposal prints: every
 * charge with its USD amount, its CAD equivalent, where the number came from, and
 * — the part that matters most — whether it is payable to SSG or payable by the
 * customer to somebody else at the border.
 *
 * Pure. No database, no clock, no configuration: the caller loads the rules and
 * the customs entry and passes them in. That is what makes the six city scenarios
 * expressible as fixtures rather than as integration tests.
 *
 * Four rules the code will not break:
 *
 *   1. **USD is authoritative.** Every CAD figure is derived from a USD minor-unit
 *      amount and a dated rate. No CAD amount is ever a source value, and no
 *      derived CAD amount is ever converted back.
 *   2. **Customer-payable charges are never added to the amount payable to SSG.**
 *      They are a separate total, and each line names who expects the money.
 *   3. **A charge nobody has quoted is absent, not zero.** An unentered duty or an
 *      unconfigured broker fee produces a line with a status and no amount. Zero is
 *      a claim; this pipeline does not make it on the company's behalf.
 *   4. **Tax is computed on the seller's consideration**, and which charges that
 *      includes is decided by the taxability rules, not hardcoded here.
 */
import {
  computeCanadianTax,
  type CanadianTaxType,
  type ChargeBasis,
  type ChargeCategory,
  type TaxabilityRule,
  type TaxExemption,
  type TaxRateRule,
  type TaxRegistration,
  type TaxResponsibility,
  type TaxResult,
} from './tax.js';
import { convertCadMinorToUsd, convertUsdMinorToCad } from './fx.js';
import type { ProvinceCode } from '../lib/country.js';

export type Currency = 'USD' | 'CAD';

export type ImporterOfRecordValue = 'CUSTOMER' | 'SUMMIT' | 'THIRD_PARTY' | 'TO_BE_DETERMINED';

export type CustomsStatusValue =
  'REQUIRES_CUSTOMS_REVIEW' | 'ESTIMATED' | 'CONFIRMED' | 'NOT_APPLICABLE';

/** Where a number on the proposal came from. Printed nowhere; audited everywhere. */
export type CalculationSource =
  /** A figure the proposal itself already held (equipment, freight, install). */
  | 'PROPOSAL'
  /** A person typed it: a broker quote, a prior entry, a ruling. */
  | 'MANUAL_ENTRY'
  /** Computed from an effective-dated rule row. */
  | 'RULE'
  /** Converted from another currency at the proposal rate. */
  | 'FX_CONVERSION';

export type ChargeLineStatus =
  | 'CALCULATED'
  | 'ESTIMATED'
  | 'CONFIRMED'
  | 'TO_BE_CONFIRMED'
  | 'REQUIRES_CUSTOMS_REVIEW'
  | 'REQUIRES_TAX_REVIEW'
  | 'NOT_APPLICABLE'
  | 'EXEMPT'
  | 'NOT_REGISTERED';

/** Who the customer is expected to pay. Drives the three-summary presentation. */
export type PayableTo = 'SUMMIT' | 'CUSTOMS_OR_BROKER';

export interface ChargeLine {
  category: ChargeCategory;
  /** Customer-facing label. "HST", "Customs duty", "Freight". */
  label: string;
  /** The amount as quoted, in the currency it was quoted in. Null when unquoted. */
  sourceAmountMinor: number | null;
  sourceCurrency: Currency;
  /** Authoritative USD minor units. Null when the charge has no amount yet. */
  usdMinor: number | null;
  /** Derived. Null whenever usdMinor is null, never 0 as a stand-in. */
  cadMinor: number | null;
  exchangeRate: string;
  exchangeRateDate: string;
  /** Set on tax lines only: what the percentage was applied to. */
  taxableBasisUsdMinor: number | null;
  /** Decimal string for a percentage-derived line, e.g. "13". */
  percent: string | null;
  calculationSource: CalculationSource;
  status: ChargeLineStatus;
  /** The rule row that produced the figure, for tax lines. */
  effectiveRuleId: string | null;
  /** True when a person overrode a computed value. */
  manualOverride: boolean;
  includedInSellerTotal: boolean;
  payableTo: PayableTo;
}

export interface SellerCharge {
  category: ChargeCategory;
  label: string;
  /** USD minor units. Negative for discounts and credits. */
  usdMinor: number;
}

/**
 * The human-entered customs figures. Every amount is nullable and null means
 * "nobody has answered" — which is why these are `number | null` and not `number`
 * defaulting to 0.
 */
export interface CustomsEntryInput {
  status: CustomsStatusValue;
  /** The currency the broker quoted in. */
  currency: Currency;
  dutyMinor: number | null;
  surtaxMinor: number | null;
  simaMinor: number | null;
  otherDutyMinor: number | null;
  importTaxMinor: number | null;
  brokerFeeMinor: number | null;
  importerOfRecord: ImporterOfRecordValue;
  /** True only where SSG is collecting or advancing these amounts. */
  includedInSellerTotal: boolean;
}

export interface FxInput {
  rate: string;
  observationDate: string;
}

export interface PipelineInput {
  province: ProvinceCode;
  /** Proposal date, YYYY-MM-DD. Every effective-dated rule is read against it. */
  asOf: string;
  fx: FxInput;
  sellerCharges: SellerCharge[];
  customs: CustomsEntryInput;
  taxResponsibility: TaxResponsibility;
  rates: TaxRateRule[];
  taxability: TaxabilityRule[];
  registrations: TaxRegistration[];
  exemptions: TaxExemption[];
}

export interface Totals {
  usdMinor: number;
  cadMinor: number;
}

export type PipelineIssue =
  | 'customs_requires_review'
  | 'broker_fee_unconfirmed'
  | 'importer_of_record_undetermined'
  | 'tax_requires_review';

export interface PipelineResult {
  lines: ChargeLine[];
  /** What the customer owes SSG. Never includes a border charge SSG isn't collecting. */
  payableToSummit: Totals;
  /** What the customer should expect to pay CBSA, a broker or a carrier. */
  separatelyPayable: Totals;
  /** The two above, added. The number a buyer actually budgets for. */
  estimatedLandedCost: Totals;
  tax: TaxResult;
  issues: PipelineIssue[];
  /** False when something must be resolved before this can go out as final. */
  readyForCustomer: boolean;
}

/** The customs fields, in the order they present on a proposal. */
const CUSTOMS_FIELDS = [
  'dutyMinor',
  'surtaxMinor',
  'simaMinor',
  'otherDutyMinor',
  'importTaxMinor',
  'brokerFeeMinor',
] as const;

type CustomsField = (typeof CUSTOMS_FIELDS)[number];

const CUSTOMS_LABELS: Record<CustomsField, string> = {
  dutyMinor: 'Customs duty',
  surtaxMinor: 'Tariff or surtax',
  simaMinor: 'SIMA duties',
  otherDutyMinor: 'Other border duties',
  importTaxMinor: 'Estimated import tax',
  brokerFeeMinor: 'Customs brokerage',
};

const CUSTOMS_CATEGORIES: Record<CustomsField, ChargeCategory> = {
  dutyMinor: 'CUSTOMS_DUTY',
  surtaxMinor: 'TARIFF_SURTAX',
  simaMinor: 'SIMA',
  otherDutyMinor: 'OTHER',
  importTaxMinor: 'IMPORT_TAX',
  brokerFeeMinor: 'BROKERAGE',
};

/** Convert a quoted amount into authoritative USD minor units. */
function toUsdMinor(amount: number, currency: Currency, rate: string): number {
  if (currency === 'USD') return Math.round(amount);
  // The one sanctioned CAD→USD direction: the CAD figure IS the source document,
  // a broker's own quote. A derived CAD amount is never converted back.
  return Number(convertCadMinorToUsd(BigInt(Math.round(amount)), rate));
}

function cadFor(usdMinor: number | null, rate: string): number | null {
  if (usdMinor === null) return null;
  return Number(convertUsdMinorToCad(BigInt(usdMinor), rate));
}

/**
 * Build the charge lines and the three totals.
 *
 * Order matters: seller charges first, then border charges, then tax — because tax
 * is computed on whichever of the preceding lines the taxability rules say form
 * SSG's consideration for the supply.
 */
export function buildChargeLines(input: PipelineInput): PipelineResult {
  const { fx, province, asOf, customs } = input;
  const rate = fx.rate;
  const rateDate = fx.observationDate;
  const issues: PipelineIssue[] = [];
  const lines: ChargeLine[] = [];

  const base = {
    exchangeRate: rate,
    exchangeRateDate: rateDate,
    taxableBasisUsdMinor: null,
    percent: null,
    effectiveRuleId: null,
    manualOverride: false,
  };

  // 1. What SSG is selling. Already USD, already authoritative.
  for (const charge of input.sellerCharges) {
    lines.push({
      ...base,
      category: charge.category,
      label: charge.label,
      sourceAmountMinor: charge.usdMinor,
      sourceCurrency: 'USD',
      usdMinor: charge.usdMinor,
      cadMinor: cadFor(charge.usdMinor, rate),
      calculationSource: 'PROPOSAL',
      status: 'CALCULATED',
      includedInSellerTotal: true,
      payableTo: 'SUMMIT',
    });
  }

  // 2. The border. Human-entered in this version — there is no tariff calculator,
  //    because this database holds no classifications, origins or CUSMA
  //    certificates, and a duty computed from absent data is a number somebody
  //    would quote.
  const bordersApply = customs.status !== 'NOT_APPLICABLE';
  if (bordersApply) {
    if (customs.status === 'REQUIRES_CUSTOMS_REVIEW') issues.push('customs_requires_review');
    if (customs.importerOfRecord === 'TO_BE_DETERMINED') {
      issues.push('importer_of_record_undetermined');
    }

    const payableTo: PayableTo = customs.includedInSellerTotal ? 'SUMMIT' : 'CUSTOMS_OR_BROKER';

    for (const field of CUSTOMS_FIELDS) {
      const quoted = customs[field];
      const category = CUSTOMS_CATEGORIES[field];
      const label = CUSTOMS_LABELS[field];

      // Nothing entered. The line still appears — silence about a duty reads as
      // "no duty", and that is the misreading this whole design exists to stop.
      //
      // What a null MEANS depends on whether anyone has reviewed the entry:
      //
      //   CONFIRMED               a reviewer signed this off, so a blank field is
      //                           a charge that does not arise. NOT_APPLICABLE,
      //                           and it does not hold the proposal up — including
      //                           a blank broker fee, which is the ordinary state
      //                           when the customer arranges their own broker.
      //   REQUIRES_CUSTOMS_REVIEW nobody has looked. The duty is unknown, not nil.
      //   ESTIMATED               partially entered; the rest is still outstanding.
      if (quoted === null) {
        const reviewed = customs.status === 'CONFIRMED';
        const unquotedStatus: ChargeLineStatus = reviewed
          ? 'NOT_APPLICABLE'
          : customs.status === 'REQUIRES_CUSTOMS_REVIEW' && field !== 'brokerFeeMinor'
            ? 'REQUIRES_CUSTOMS_REVIEW'
            : 'TO_BE_CONFIRMED';
        if (field === 'brokerFeeMinor' && !reviewed) issues.push('broker_fee_unconfirmed');
        lines.push({
          ...base,
          category,
          label,
          sourceAmountMinor: null,
          sourceCurrency: customs.currency,
          usdMinor: null,
          cadMinor: null,
          calculationSource: 'MANUAL_ENTRY',
          status: unquotedStatus,
          includedInSellerTotal: false,
          payableTo,
        });
        continue;
      }

      const usdMinor = toUsdMinor(quoted, customs.currency, rate);
      lines.push({
        ...base,
        category,
        label,
        sourceAmountMinor: Math.round(quoted),
        sourceCurrency: customs.currency,
        usdMinor,
        cadMinor: cadFor(usdMinor, rate),
        calculationSource: customs.currency === 'USD' ? 'MANUAL_ENTRY' : 'FX_CONVERSION',
        status: customs.status === 'CONFIRMED' ? 'CONFIRMED' : 'ESTIMATED',
        includedInSellerTotal: customs.includedInSellerTotal,
        payableTo,
      });
    }
  }

  // 3. Seller-collected sales tax, on whatever the taxability rules count as SSG's
  //    consideration. Only lines already in the seller total can qualify: a duty
  //    the customer pays CBSA directly is not part of SSG's supply.
  const taxBasis: ChargeBasis[] = lines
    .filter((l) => l.includedInSellerTotal && l.usdMinor !== null)
    .map((l) => ({ category: l.category, usdMinor: BigInt(l.usdMinor as number) }));

  const tax = computeCanadianTax({
    province,
    asOf,
    responsibility: input.taxResponsibility,
    charges: taxBasis,
    rates: input.rates,
    taxability: input.taxability,
    registrations: input.registrations,
    exemptions: input.exemptions,
  });

  if (!tax.readyForCustomer) issues.push('tax_requires_review');

  for (const t of tax.lines) {
    const usdMinor = Number(t.taxUsdMinor);
    const charged = t.status === 'CHARGED';
    lines.push({
      category: 'SALES_TAX',
      label: t.label,
      sourceAmountMinor: charged ? usdMinor : null,
      sourceCurrency: 'USD',
      usdMinor: charged ? usdMinor : null,
      cadMinor: charged ? cadFor(usdMinor, rate) : null,
      exchangeRate: rate,
      exchangeRateDate: rateDate,
      taxableBasisUsdMinor: Number(t.taxableBasisUsdMinor),
      percent: t.ratePercent,
      calculationSource: 'RULE',
      status: taxLineStatus(t.status),
      effectiveRuleId: t.rateRuleId,
      manualOverride: false,
      // Tax SSG collects is payable to SSG. Import tax assessed at the border is a
      // separate line, produced above from the customs entry.
      includedInSellerTotal: charged,
      payableTo: 'SUMMIT',
    });
  }

  // 4. The three summaries. CAD totals are the SUM OF THE ROUNDED CAD LINES, not a
  //    conversion of the USD total: a customer checking the CAD column with a
  //    calculator has to find that it adds up. The two differ by at most a cent or
  //    two, and a column that does not sum is the more damaging error.
  const sum = (pick: (l: ChargeLine) => boolean): Totals => {
    let usdMinor = 0;
    let cadMinor = 0;
    for (const l of lines) {
      if (l.usdMinor === null || !pick(l)) continue;
      usdMinor += l.usdMinor;
      cadMinor += l.cadMinor ?? 0;
    }
    return { usdMinor, cadMinor };
  };

  const payableToSummit = sum((l) => l.includedInSellerTotal);
  const separatelyPayable = sum((l) => !l.includedInSellerTotal);

  return {
    lines,
    payableToSummit,
    separatelyPayable,
    estimatedLandedCost: {
      usdMinor: payableToSummit.usdMinor + separatelyPayable.usdMinor,
      cadMinor: payableToSummit.cadMinor + separatelyPayable.cadMinor,
    },
    tax,
    issues,
    readyForCustomer: issues.length === 0,
  };
}

function taxLineStatus(s: string): ChargeLineStatus {
  switch (s) {
    case 'CHARGED':
      return 'CALCULATED';
    case 'EXEMPT':
      return 'EXEMPT';
    case 'NOT_REGISTERED':
      return 'NOT_REGISTERED';
    case 'NO_RATE':
      return 'NOT_APPLICABLE';
    default:
      return 'REQUIRES_TAX_REVIEW';
  }
}

/** The tax types that produced a charged line, for the presentation layer. */
export function chargedTaxTypes(result: PipelineResult): CanadianTaxType[] {
  return result.tax.lines.filter((l) => l.status === 'CHARGED').map((l) => l.taxType);
}
