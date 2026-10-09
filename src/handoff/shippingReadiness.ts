import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../lib/errors.js';
import {
  manufacturingSnapshotForVersion,
  type ManufacturingSnapshot,
} from '../integrations/monday/manufacturingSnapshot.js';

/**
 * "Is this order safe to ship" — Manufacturing Phase and Estimated Shipment
 * Date from monday, next to what the customer still owes.
 *
 * The two halves come from different systems and neither is allowed to hide
 * the other: a monday outage should not blank the balance, and an order not
 * yet invoiced should not read as "paid in full". See the UI note below on
 * `balanceMinor: null` vs `0n`.
 */

export interface ShippingReadiness {
  manufacturing: ManufacturingSnapshot;
  /**
   * The live outstanding balance across every real invoice on this job — the
   * same QboTransaction.balanceMinor the Accounts Receivable screen chases,
   * not AcceptedOrder.balanceDueMinor (a deposit-split figure frozen at
   * acceptance that never moves as payments come in, and so answers a
   * different question than "have they actually paid").
   *
   * null when nothing has been invoiced yet — deliberately distinct from 0n,
   * which means invoiced AND paid. Showing 0n here for an un-invoiced order
   * would read as "nothing owed" when the honest answer is "not billed yet".
   */
  balanceMinor: bigint | null;
  currency: string;
  invoiceCount: number;
  /**
   * Outstanding balances on invoices in any OTHER currency, one entry per currency.
   * Invoices are raised in the order's currency, so this is normally empty; when it
   * is not, those amounts are listed here rather than added to `balanceMinor` —
   * USD 3,300 plus CAD 5,700 is not "9,000 owed" in either currency.
   */
  otherCurrencyBalances: Array<{ currency: string; balanceMinor: bigint }>;
  /** The ask this whole thing exists for: a missing ship date on a job that still owes money. */
  needsAttention: boolean;
}

/**
 * Every real (non-estimate, non-voided, created) invoice's outstanding balance,
 * summed per currency: the order's currency into `balanceMinor`, any other
 * currency kept apart.
 */
async function outstandingBalance(
  proposalId: string,
  currency: string,
): Promise<{
  balanceMinor: bigint | null;
  invoiceCount: number;
  otherCurrencyBalances: Array<{ currency: string; balanceMinor: bigint }>;
}> {
  const txns = await prisma.qboTransaction.findMany({
    where: { proposalId, status: 'CREATED', type: { not: 'ESTIMATE' } },
    select: { balanceMinor: true, amountMinor: true, currency: true },
  });
  return splitBalances(txns, currency);
}

/** The pure half of outstandingBalance: sum the invoices per currency. */
export function splitBalances(
  txns: ReadonlyArray<{ balanceMinor: bigint | null; amountMinor: bigint; currency: string }>,
  currency: string,
): {
  balanceMinor: bigint | null;
  invoiceCount: number;
  otherCurrencyBalances: Array<{ currency: string; balanceMinor: bigint }>;
} {
  if (!txns.length) return { balanceMinor: null, invoiceCount: 0, otherCurrencyBalances: [] };
  const want = currency.toUpperCase();
  const byCurrency = new Map<string, bigint>();
  for (const t of txns) {
    const c = (t.currency || want).toUpperCase();
    byCurrency.set(c, (byCurrency.get(c) ?? 0n) + (t.balanceMinor ?? t.amountMinor));
  }
  const others = [...byCurrency.entries()]
    .filter(([c]) => c !== want)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, balanceMinor]) => ({ currency: c, balanceMinor }));
  return {
    // Invoices exist but none in the order's currency: nothing is owed in it.
    balanceMinor: byCurrency.get(want) ?? 0n,
    invoiceCount: txns.length,
    otherCurrencyBalances: others,
  };
}

async function assemble(
  proposalId: string,
  proposalVersionId: string,
  currency: string,
): Promise<ShippingReadiness> {
  const [manufacturing, balance] = await Promise.all([
    manufacturingSnapshotForVersion(proposalVersionId),
    outstandingBalance(proposalId, currency),
  ]);
  return {
    manufacturing,
    balanceMinor: balance.balanceMinor,
    currency,
    invoiceCount: balance.invoiceCount,
    otherCurrencyBalances: balance.otherCurrencyBalances,
    needsAttention:
      !manufacturing.shipDate &&
      ((balance.balanceMinor ?? 0n) > 0n ||
        balance.otherCurrencyBalances.some((b) => b.balanceMinor > 0n)),
  };
}

/** For the order detail page. */
export async function shippingReadinessForOrder(orderId: string): Promise<ShippingReadiness> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { proposalId: true, proposalVersionId: true, currency: true },
  });
  if (!order) throw new NotFoundError('Order not found');
  return assemble(order.proposalId, order.proposalVersionId, order.currency);
}
