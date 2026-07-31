import { prisma } from '../lib/prisma.js';

/**
 * Ryan Capital financing options.
 *
 * Lessors quote from a PAYMENT FACTOR, not an interest rate: the monthly payment is
 * the financed amount multiplied by a published factor for that term. The factor is
 * therefore the editable unit (Administration → Financing) — deriving one from an
 * APR would introduce a compounding convention Ryan Capital has not agreed to, and
 * the number on the sheet would stop matching the number they quote.
 *
 * Everything here is derived from the accepted proposal total. There is no data
 * entry: the document exists the moment a proposal has a price.
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

export interface FinanceQuote {
  amountMinor: number;
  terms: FinanceTerm[];
  section179: Section179;
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
 * Terms come from the database so a factor change reaches the next document with no
 * deploy. An amount of zero returns no terms rather than a table of $0.00 rows — a
 * proposal with no price has nothing to finance, and printing zeros invites someone
 * to send it anyway.
 */
export async function quoteFinancing(
  amountMinor: number,
  settings?: Partial<FinanceSettings>,
): Promise<FinanceQuote> {
  const rows = await prisma.financeFactor.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { termMonths: 'asc' }],
  });

  const taxRatePct = settings?.taxRatePct ?? FINANCE_DEFAULTS.taxRatePct;
  const capMinor = settings?.section179CapMinor ?? FINANCE_DEFAULTS.section179CapMinor;

  const amount = Math.max(0, round(amountMinor));
  const terms: FinanceTerm[] = amount
    ? rows.map((r) => {
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
    })
    : [];

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
  };
}

/** The two settings keys, resolved from the admin store. */
export function financeSettingsFrom(get: (k: string) => number): FinanceSettings {
  return {
    taxRatePct: get('financeTaxRatePct'),
    // Stored in whole dollars for a legible admin field; the math works in minor units.
    section179CapMinor: Math.round(get('section179CapDollars') * 100),
  };
}
