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
  /** The ask this whole thing exists for: a missing ship date on a job that still owes money. */
  needsAttention: boolean;
}

/** Every real (non-estimate, non-voided, created) invoice's outstanding balance, summed. */
async function outstandingBalance(
  proposalId: string,
): Promise<{ balanceMinor: bigint | null; invoiceCount: number }> {
  const txns = await prisma.qboTransaction.findMany({
    where: { proposalId, status: 'CREATED', type: { not: 'ESTIMATE' } },
    select: { balanceMinor: true, amountMinor: true },
  });
  if (!txns.length) return { balanceMinor: null, invoiceCount: 0 };
  const total = txns.reduce((sum, t) => sum + (t.balanceMinor ?? t.amountMinor), 0n);
  return { balanceMinor: total, invoiceCount: txns.length };
}

async function assemble(
  proposalId: string,
  proposalVersionId: string,
  currency: string,
): Promise<ShippingReadiness> {
  const [manufacturing, balance] = await Promise.all([
    manufacturingSnapshotForVersion(proposalVersionId),
    outstandingBalance(proposalId),
  ]);
  return {
    manufacturing,
    balanceMinor: balance.balanceMinor,
    currency,
    invoiceCount: balance.invoiceCount,
    needsAttention: !manufacturing.shipDate && (balance.balanceMinor ?? 0n) > 0n,
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
