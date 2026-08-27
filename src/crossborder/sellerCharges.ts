/**
 * The Canadian charges Summit collects, as money that belongs in an order.
 *
 * Tariff, brokerage and Canadian tax are quoted on the proposal and each carries a
 * flag for who collects it. Where SSG is collecting, the charge is part of what the
 * customer owes SSG — so it has to reach the accepted order and the QuickBooks
 * invoice, or an accepted Canadian proposal invoices short by exactly this amount.
 *
 * One rule governs everything here: the FROZEN snapshot wins.
 *
 * A snapshot is written at release and frozen at acceptance, and it is the figures
 * the customer signed. Recomputing at lock time would let a rate change between
 * signature and lock quietly move what is invoiced — the exact failure the snapshot
 * exists to prevent. So the frozen row is read first and only an unfrozen proposal
 * falls through to a live calculation.
 */
import { prisma } from '../lib/prisma.js';
import { crossBorderStateFor } from './snapshot.js';

export interface SellerChargeLine {
  /** Printed verbatim on the invoice line. */
  label: string;
  usdMinor: number;
  /** The rate it was worked out from, where there was one. Display only. */
  percent: string | null;
  category: string;
}

export interface SellerCharges {
  lines: SellerChargeLine[];
  /** What these add to the amount payable to Summit, in USD minor units. */
  totalMinor: number;
  /** Where the figures came from, for the audit trail. */
  source: 'SNAPSHOT' | 'LIVE' | 'NONE';
}

const EMPTY: SellerCharges = { lines: [], totalMinor: 0, source: 'NONE' };

/** A charge line shape, from either the JSON column or the live engine. */
interface LineLike {
  label?: unknown;
  usdMinor?: unknown;
  percent?: unknown;
  category?: unknown;
  status?: unknown;
  includedInSellerTotal?: unknown;
}

/**
 * Collected by Summit, has a figure, and is not explicitly not-applicable.
 *
 * A null amount is deliberately excluded rather than treated as zero: an unquoted
 * duty is unknown, and adding nothing for it is right, while adding a zero to a
 * customer's invoice would assert that no duty arises.
 */
function collected(lines: LineLike[]): SellerChargeLine[] {
  const out: SellerChargeLine[] = [];
  for (const l of lines) {
    if (!l.includedInSellerTotal) continue;
    if (l.status === 'NOT_APPLICABLE') continue;
    const amount = Number(l.usdMinor);
    if (!Number.isFinite(amount) || l.usdMinor == null) continue;
    out.push({
      label: String(l.label ?? 'Border charge'),
      usdMinor: Math.round(amount),
      percent: l.percent == null ? null : String(l.percent),
      category: String(l.category ?? 'OTHER'),
    });
  }
  return out;
}

const sum = (lines: SellerChargeLine[]): number => lines.reduce((a, l) => a + l.usdMinor, 0);

/** The charges for a proposal version, snapshot first. */
export async function sellerCollectedCharges(versionId: string): Promise<SellerCharges> {
  const snapshot = await prisma.proposalCrossBorderSnapshot.findFirst({
    where: { versionId },
    orderBy: [{ frozen: 'desc' }, { createdAt: 'desc' }],
    select: { chargeLines: true },
  });

  if (snapshot && Array.isArray(snapshot.chargeLines)) {
    const lines = collected(snapshot.chargeLines as LineLike[]);
    if (lines.length) return { lines, totalMinor: sum(lines), source: 'SNAPSHOT' };
    // A snapshot with no collected charge is a real answer, not a miss: a Canadian
    // job where the customer clears the goods themselves has none.
    return { ...EMPTY, source: 'SNAPSHOT' };
  }

  // No snapshot: a proposal accepted before the cross-border snapshot existed, or one
  // never released. Compute, and say so.
  const state = await crossBorderStateFor(versionId);
  if (!state.applicable || !state.result) return EMPTY;
  const lines = collected(state.result.lines as unknown as LineLike[]);
  return { lines, totalMinor: sum(lines), source: 'LIVE' };
}
