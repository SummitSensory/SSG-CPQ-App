import { convertUsdMinorToCad } from './fx.js';
import type {
  ChargeLine,
  PipelineResult,
  SellerCharge,
  ImporterOfRecordValue,
} from './chargeLines.js';

/**
 * Canadian charges from typed percentages.
 *
 * The full engine (chargeLines.ts) is the right long-term shape: registrations, dated
 * per-province rate rows, per-category taxability rulings, a broker fee schedule. It is
 * also why no Canadian proposal can be released today — those answers come from an
 * accountant and a customs broker, and they have a lead time nobody here controls.
 *
 * This is the interim path. An operator types three things:
 *
 *   the tax rate, and what it is called      HST 13%, GST + QST 14.975%
 *   the tariff rate                          applied to the goods
 *   the broker's fee                         a quoted amount, not a rate
 *
 * and the arithmetic follows from them. Freight is untouched — it comes from the
 * proposal exactly as it does on a domestic job.
 *
 * What this deliberately is NOT: a tariff calculator. There are no HS codes, no
 * country-of-origin records and no CUSMA determination behind these figures. The rate
 * came from a person. The proposal says so, in those words, and every clause about
 * final assessment resting with CBSA still prints.
 *
 * The output is shaped exactly like the full engine's, so the proposal document, the
 * PDF and the snapshot renderer need no branch for it.
 */

export interface SimpleCustomsInput {
  taxLabel: string | null;
  /** Thousandths of a percent: 13% is 13000, 9.975% is 9975. */
  taxPercentMilli: number | null;
  tariffPercentMilli: number | null;
  brokerFeeMinor: number | null;
  tariffOnFreight: boolean;
  taxOnDuty: boolean;
  importerOfRecord: ImporterOfRecordValue;
  /** Whether SSG is collecting these, or the customer pays them at the border. */
  includedInSellerTotal: boolean;
}

export interface SimpleInput {
  asOf: string;
  fx: { rate: string; observationDate: string };
  sellerCharges: SellerCharge[];
  customs: SimpleCustomsInput;
}

const cad = (usdMinor: number | null, rate: string): number | null =>
  usdMinor == null ? null : Number(convertUsdMinorToCad(BigInt(usdMinor), rate));

/** Thousandths of a percent as a display string: 9975 -> "9.975". */
export function milliToPercent(milli: number | null | undefined): string | null {
  if (milli == null) return null;
  const s = (milli / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** A percentage of an amount, in thousandths of a percent, rounded half up. */
function applyMilli(amountMinor: number, milli: number): number {
  const neg = amountMinor < 0;
  const abs = Math.abs(amountMinor) * milli;
  // milli is per 100,000 of the amount (percent x 1000).
  const rounded = Math.floor((abs * 2 + 100000) / 200000);
  return neg ? -rounded : rounded;
}

export function buildSimpleChargeLines(input: SimpleInput): PipelineResult {
  const { rate, observationDate } = input.fx;
  const lines: ChargeLine[] = [];

  const line = (
    category: ChargeLine['category'],
    label: string,
    usdMinor: number | null,
    opts: Partial<ChargeLine> = {},
  ): ChargeLine => ({
    category,
    label,
    sourceAmountMinor: usdMinor,
    sourceCurrency: 'USD',
    usdMinor,
    cadMinor: cad(usdMinor, rate),
    exchangeRate: rate,
    exchangeRateDate: observationDate,
    taxableBasisUsdMinor: null,
    percent: null,
    calculationSource: 'MANUAL_ENTRY',
    status: 'ESTIMATED',
    effectiveRuleId: null,
    manualOverride: true,
    includedInSellerTotal: true,
    payableTo: 'SUMMIT',
    ...opts,
  });

  const goodsMinor = input.sellerCharges
    .filter((c) => c.category !== 'FREIGHT')
    .reduce((a, c) => a + c.usdMinor, 0);
  const freightMinor = input.sellerCharges
    .filter((c) => c.category === 'FREIGHT')
    .reduce((a, c) => a + c.usdMinor, 0);

  const c = input.customs;
  const payableTo = c.includedInSellerTotal ? 'SUMMIT' : 'CUSTOMS_OR_BROKER';
  const border = {
    includedInSellerTotal: c.includedInSellerTotal,
    payableTo,
  } as Partial<ChargeLine>;

  // ---- tariff ----
  // Assessed on the customs value of the goods. Freight is excluded unless the operator
  // says otherwise, because duty is charged on what the goods are worth.
  const tariffBasis = goodsMinor + (c.tariffOnFreight ? freightMinor : 0);
  const tariffMinor =
    c.tariffPercentMilli == null ? null : applyMilli(tariffBasis, c.tariffPercentMilli);
  if (tariffMinor != null) {
    lines.push(
      line('TARIFF_SURTAX', 'Estimated Tariff', tariffMinor, {
        ...border,
        taxableBasisUsdMinor: tariffBasis,
        percent: milliToPercent(c.tariffPercentMilli),
        // MANUAL_ENTRY by default from line(): a person typed this rate. Not 'RULE' —
        // no effective-dated rule row produced it, and saying so in the audit trail
        // would misdescribe where the figure came from.
      }),
    );
  }

  // ---- brokerage ----
  // A quoted amount, never a rate: the broker quotes a fee, and inventing a percentage
  // for it would put a number on the document that nobody quoted.
  if (c.brokerFeeMinor != null) {
    lines.push(line('BROKERAGE', 'Customs Brokerage', c.brokerFeeMinor, border));
  }

  // ---- tax ----
  // On an import, GST/HST is assessed on the value of the goods plus duty. Freight and
  // brokerage are included in the base by default because that is how the invoice
  // usually reads; `taxOnDuty` turns the duty and brokerage part of it off.
  const taxBase =
    goodsMinor + freightMinor + (c.taxOnDuty ? (tariffMinor ?? 0) + (c.brokerFeeMinor ?? 0) : 0);
  const taxMinor = c.taxPercentMilli == null ? null : applyMilli(taxBase, c.taxPercentMilli);
  if (taxMinor != null) {
    lines.push(
      line('SALES_TAX', c.taxLabel?.trim() || 'Estimated Canadian sales tax', taxMinor, {
        taxableBasisUsdMinor: taxBase,
        percent: milliToPercent(c.taxPercentMilli),
        // MANUAL_ENTRY by default from line(): a person typed this rate. Not 'RULE' —
        // no effective-dated rule row produced it, and saying so in the audit trail
        // would misdescribe where the figure came from.
        // Tax follows the same hand as the border charges: if SSG is not collecting
        // the duty, it is not collecting the import tax either.
        ...border,
      }),
    );
  }

  const sellerLines = lines.filter((l) => l.includedInSellerTotal);
  const borderLines = lines.filter((l) => !l.includedInSellerTotal);
  const sum = (ls: ChargeLine[]) => ls.reduce((a, l) => a + (l.usdMinor ?? 0), 0);

  const goodsAndFreight = goodsMinor + freightMinor;
  const payableUsd = goodsAndFreight + sum(sellerLines);
  const separateUsd = sum(borderLines);

  // Nothing here is "requires review" in the way the full engine means it: an operator
  // typed these rates deliberately. What IS still true is that they are estimates, and
  // that is said on the document rather than encoded as a blocker.
  const issues: PipelineResult['issues'] = [];
  if (c.importerOfRecord === 'TO_BE_DETERMINED') issues.push('importer_of_record_undetermined');

  return {
    lines,
    payableToSummit: { usdMinor: payableUsd, cadMinor: cad(payableUsd, rate) ?? 0 },
    separatelyPayable: { usdMinor: separateUsd, cadMinor: cad(separateUsd, rate) ?? 0 },
    estimatedLandedCost: {
      usdMinor: payableUsd + separateUsd,
      cadMinor: cad(payableUsd + separateUsd, rate) ?? 0,
    },
    tax: {
      lines: [],
      totalTaxUsdMinor: BigInt(taxMinor ?? 0),
      issues: [],
      readyForCustomer: true,
    },
    issues,
    readyForCustomer: issues.length === 0,
  };
}
