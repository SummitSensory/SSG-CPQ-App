import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../lib/errors.js';

/**
 * Ryan Capital financing options.
 *
 * Payments are quoted from a PAYMENT FACTOR per term, not an interest rate:
 *
 *     monthly payment = amount financed x factor
 *
 * That is how equipment lessors publish their pricing, and it is the number the
 * partner gives us — deriving it from an APR would mean guessing at their
 * compounding and fee structure and printing a payment they would not honour. The
 * factors are editable under Administration -> Financing.
 *
 * Everything on the sheet is computed from the proposal total. There is nothing
 * to fill in.
 */

/** Fallbacks matching the partner's published sheet, used if the table is empty. */
const FALLBACK_FACTORS: Array<{ termMonths: number; factor: number }> = [
  { termMonths: 12, factor: 0.0907 },
  { termMonths: 24, factor: 0.04708 },
  { termMonths: 36, factor: 0.0327 },
  { termMonths: 48, factor: 0.02553 },
  { termMonths: 60, factor: 0.02124 },
];

/**
 * Section 179 lets a business deduct qualifying equipment in the year it is
 * placed in service, up to a cap. Both numbers move — the cap is indexed
 * annually and the rate depends on the buyer — so both are settings.
 */
export const FINANCE_SETTINGS = [
  {
    key: 'section179Cap',
    label: 'Section 179 deduction cap',
    help: 'The maximum equipment cost a business can deduct in the first year. Indexed for inflation each year by the IRS — check it every January.',
    unit: 'dollars',
    default: 1_000_000,
    min: 0,
    max: 10_000_000,
    step: 1000,
  },
  {
    key: 'taxRate',
    label: 'Assumed tax rate',
    help: 'Used to estimate the cash value of the Section 179 deduction. 21% is the federal corporate rate; a pass-through buyer’s effective rate differs, so the sheet prints this as an estimate.',
    unit: 'percent',
    default: 21,
    min: 0,
    max: 60,
    step: 0.5,
  },
] as const;

export interface FinanceTerm {
  termMonths: number;
  factor: number;
  monthlyPaymentMinor: number;
  totalOfPaymentsMinor: number;
  costOfFinancingMinor: number;
}

export interface FinanceQuote {
  amountFinancedMinor: number;
  terms: FinanceTerm[];
  section179: {
    /** The deductible portion — the equipment cost, capped. */
    deductionMinor: number;
    capMinor: number;
    taxRatePct: number;
    /** Estimated cash value of the deduction. */
    estimatedSavingsMinor: number;
    netCostMinor: number;
    /** True when the purchase exceeds the cap, so the sheet can say so plainly. */
    exceedsCap: boolean;
  };
}

export async function loadFactors(): Promise<Array<{ termMonths: number; factor: number }>> {
  const rows = await prisma.financeFactor.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { termMonths: 'asc' }],
  });
  if (!rows.length) return FALLBACK_FACTORS;
  return rows.map((r) => ({ termMonths: r.termMonths, factor: Number(r.factor) }));
}

/**
 * Reuses the FormulaSetting table the proposal maths already uses, namespaced
 * under `finance.` — a second settings table would be the same shape with a
 * different name and one more thing to keep in step.
 */
async function loadSetting(key: string, fallback: number): Promise<number> {
  const row = await prisma.formulaSetting.findUnique({ where: { key: `finance.${key}` } }).catch(() => null);
  if (!row) return fallback;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build the whole quote from one number: the proposal total in minor units.
 *
 * Rounding is to the cent at each payment, then multiplied out — a lessor quotes
 * a real monthly payment, so the total of payments must be that payment times the
 * term, not an unrounded product.
 */
export async function quoteFinancing(amountFinancedMinor: number): Promise<FinanceQuote> {
  const [factors, capDollars, taxRatePct] = await Promise.all([
    loadFactors(),
    loadSetting('section179Cap', 1_000_000),
    loadSetting('taxRate', 21),
  ]);

  const terms: FinanceTerm[] = factors.map((f) => {
    const monthly = Math.round(amountFinancedMinor * f.factor);
    const total = monthly * f.termMonths;
    return {
      termMonths: f.termMonths,
      factor: f.factor,
      monthlyPaymentMinor: monthly,
      totalOfPaymentsMinor: total,
      costOfFinancingMinor: total - amountFinancedMinor,
    };
  });

  const capMinor = Math.round(capDollars * 100);
  const deductionMinor = Math.min(amountFinancedMinor, capMinor);
  const estimatedSavingsMinor = Math.round(deductionMinor * (taxRatePct / 100));

  return {
    amountFinancedMinor,
    terms,
    section179: {
      deductionMinor,
      capMinor,
      taxRatePct,
      estimatedSavingsMinor,
      netCostMinor: amountFinancedMinor - estimatedSavingsMinor,
      exceedsCap: amountFinancedMinor > capMinor,
    },
  };
}

/** The quote for a proposal, with the customer and total it was built from. */
export async function quoteForProposal(proposalId: string) {
  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  if (!proposal) throw new NotFoundError('Proposal not found');
  const version = proposal.versions[0];
  if (!version) throw new NotFoundError('That proposal has no versions yet');

  // The total lives on the price snapshot, not the version — a version's `items`
  // are the content, the snapshot is the priced result of them.
  const snap = version.priceSnapshotId
    ? await prisma.priceSnapshot.findUnique({ where: { id: version.priceSnapshotId }, select: { grandTotal: true } })
    : null;
  if (!snap) throw new NotFoundError('That proposal version has not been priced yet, so there is nothing to finance');

  // Proposal carries organizationId without a relation, so the customer name is a
  // second read rather than an include.
  const org = await prisma.organization.findUnique({
    where: { id: proposal.organizationId },
    select: { name: true },
  });

  const total = Number(snap.grandTotal);
  return {
    proposal: {
      id: proposal.id,
      number: proposal.number,
      title: proposal.title,
      version: version.version,
      customerName: org?.name ?? '',
      grandTotalMinor: total,
    },
    quote: await quoteFinancing(total),
  };
}
