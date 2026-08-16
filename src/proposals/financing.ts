import { prisma } from '../lib/prisma.js';
import { bandFor, currentRateCard, rateCardById, type RateCard } from './financeRates.js';

/**
 * Ryan Capital financing options.
 *
 * Lessors quote from a PAYMENT FACTOR, not an interest rate: the monthly payment is
 * the financed amount multiplied by a published factor. Deriving one from an APR
 * would introduce a compounding convention Ryan Capital has not agreed to, and the
 * number on the sheet would stop matching the number they quote.
 *
 * The factor is not one number per term. It depends on the amount, so it is read
 * from a rate card — an amount band by term grid, loaded from the lessor's sheet and
 * editable under Administration → Financing. See financeRates.ts.
 *
 * Everything here is derived from the proposal total. There is no data entry: the
 * document exists the moment a proposal has a price.
 */

export interface FinanceTerm {
  termMonths: number;
  /** Payment per $1 financed, e.g. 0.0327 for 36 months. */
  factor: number;
  monthlyPaymentMinor: number;
  totalOfPaymentsMinor: number;
  /** Total of payments less the amount financed — the cost of financing, not interest. */
  financeChargeMinor: number;
}

export interface Section179 {
  taxRatePct: number;
  capMinor: number;
  /** The portion of the purchase that can be expensed this year. */
  deductionMinor: number;
  estimatedSavingsMinor: number;
  /** Purchase price less the tax saving. */
  netCostMinor: number;
  /** True when the purchase exceeds the cap and is only partly deductible. */
  exceedsCap: boolean;
}

/** Which rate sheet and band produced these payments — printed as provenance. */
export interface QuoteBasis {
  cardId: string;
  cardName: string;
  effectiveOn: Date;
  bandLabel: string;
  bandMinMinor: number;
  bandMaxMinor: number | null;
  /** True when the amount fell outside every band and the nearest one was used. */
  approximate: boolean;
  direction: 'below' | 'above' | null;
  /** True when the card was pinned by an earlier send rather than being the current one. */
  pinned: boolean;
}

export interface FinanceQuote {
  amountMinor: number;
  terms: FinanceTerm[];
  section179: Section179;
  /** Null when no rate card is published — the sheet then says so instead of guessing. */
  basis: QuoteBasis | null;
}

/** The two business numbers behind the tax panel, both admin-editable. */
export interface FinanceSettings {
  taxRatePct: number;
  section179CapMinor: number;
}

export const FINANCE_DEFAULTS: FinanceSettings = {
  // The figure the example sheet was built on.
  taxRatePct: 21,
  // 2025 Section 179 limit. It changes most years, which is why it is editable.
  section179CapMinor: 1_000_000_00,
};

const round = (n: number): number => Math.round(n);

/**
 * Build every financing option for an amount.
 *
 * `rateCardId` pins the quote to a specific sheet. The financing send route passes
 * the card recorded on the version, so re-rendering a sheet that has already gone to
 * a customer reproduces the payments they were given rather than today's rates.
 *
 * An amount of zero returns no terms rather than a table of $0.00 rows — a proposal
 * with no price has nothing to finance, and printing zeros invites someone to send
 * it anyway.
 */
export async function quoteFinancing(
  amountMinor: number,
  settings?: Partial<FinanceSettings>,
  rateCardId?: string | null,
): Promise<FinanceQuote> {
  const taxRatePct = settings?.taxRatePct ?? FINANCE_DEFAULTS.taxRatePct;
  const capMinor = settings?.section179CapMinor ?? FINANCE_DEFAULTS.section179CapMinor;
  const amount = Math.max(0, round(amountMinor));

  let card: RateCard | null = null;
  let pinned = false;
  if (rateCardId) {
    card = await rateCardById(rateCardId);
    pinned = Boolean(card);
  }
  // A pinned card that has since been deleted falls back to the current one rather
  // than producing an empty sheet: an unquotable proposal is worse than a re-quote.
  if (!card) card = await currentRateCard();

  const match = card && amount ? bandFor(card, amount) : null;

  let terms: FinanceTerm[] = [];
  if (match) {
    terms = match.band.terms.map((t) => {
      const monthlyMinor = round(amount * t.factor);
      const totalOfPaymentsMinor = monthlyMinor * t.termMonths;
      return {
        termMonths: t.termMonths,
        factor: t.factor,
        monthlyPaymentMinor: monthlyMinor,
        totalOfPaymentsMinor,
        financeChargeMinor: totalOfPaymentsMinor - amount,
      };
    });
  } else if (amount && !card) {
    // No card published yet. Fall back to the flat per-term factors so a deployment
    // mid-migration still produces a sheet, rather than dropping financing entirely.
    terms = await legacyTerms(amount);
  }

  // Section 179 expenses the equipment cost in year one, up to the annual cap. Above
  // the cap only the cap is deductible, and the sheet says so rather than quietly
  // overstating the saving.
  const deductionMinor = Math.min(amount, capMinor);
  const estimatedSavingsMinor = round(deductionMinor * (taxRatePct / 100));

  return {
    amountMinor: amount,
    terms,
    section179: {
      taxRatePct,
      capMinor,
      deductionMinor,
      estimatedSavingsMinor,
      netCostMinor: amount - estimatedSavingsMinor,
      exceedsCap: amount > capMinor,
    },
    basis:
      card && match
        ? {
            cardId: card.id,
            cardName: card.name,
            effectiveOn: card.effectiveOn,
            bandLabel: match.band.label,
            bandMinMinor: match.band.minMinor,
            bandMaxMinor: match.band.maxMinor,
            approximate: match.approximate,
            direction: match.direction,
            pinned,
          }
        : null,
  };
}

/**
 * The pre-rate-card behaviour: one factor per term, applied at any amount.
 *
 * Kept only so a deployment that has run the migration but not yet loaded a sheet
 * still quotes. Delete once a card is published everywhere.
 */
async function legacyTerms(amount: number): Promise<FinanceTerm[]> {
  const rows = await prisma.financeFactor.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { termMonths: 'asc' }],
  });
  return rows.map((r) => {
    const factor = Number(r.factor);
    const monthlyMinor = round(amount * factor);
    const totalOfPaymentsMinor = monthlyMinor * r.termMonths;
    return {
      termMonths: r.termMonths,
      factor,
      monthlyPaymentMinor: monthlyMinor,
      totalOfPaymentsMinor,
      financeChargeMinor: totalOfPaymentsMinor - amount,
    };
  });
}

/** The two settings keys, resolved from the admin store. */
export function financeSettingsFrom(get: (k: string) => number): FinanceSettings {
  return {
    taxRatePct: get('financeTaxRatePct'),
    // Stored in whole dollars for a legible admin field; the math works in minor units.
    section179CapMinor: Math.round(get('section179CapDollars') * 100),
  };
}
