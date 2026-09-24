import { prisma } from '../../lib/prisma.js';
import { billableMinor } from '../../proposals/freightTrueUp.js';
import type { FreightEntry, Prisma } from '@prisma/client';

/**
 * Which applied freight figures the customer's invoice ALREADY carries.
 *
 * Applying freight (or the mats freight tax) re-freezes the version's price snapshot,
 * and a full-value INVOICE is built from whatever snapshot the version holds when it
 * is raised — its `totalsSnapshot.priceSnapshotId`. So a figure applied BEFORE the
 * invoice was raised is already on it, and offering it again as "not on the invoice"
 * bills the customer twice. (The same was true of freight before the mats freight tax
 * existed: this closes that for every bucket.)
 *
 * The comparison is by snapshot, not by clock: a figure is on the invoice when the
 * invoice's snapshot was frozen at or after the snapshot its own apply produced. An
 * invoice prepared a moment before an apply committed carries the older snapshot and
 * correctly counts as not including it.
 *
 * Only the full-value INVOICE counts. Deposit, progress and final portion invoices
 * and freight-only supplements do not bill the whole order, so they never include a
 * figure — the same documents `invoiceForProposal` ignores.
 */
/**
 * Full-value invoices QuickBooks actually created. Freight-only supplements are
 * removed with isFreightSupplement, in code — NOT in this where clause.
 *
 * The where clause used to carry
 *   NOT: { totalsSnapshot: { path: ['kind'], equals: 'FREIGHT_SUPPLEMENT' } }
 * and that matched NOTHING: an ordinary invoice has no 'kind' key, the JSON path reads
 * SQL NULL, "NULL = 'FREIGHT_SUPPLEMENT'" is NULL rather than false, and NOT NULL is
 * still NULL — so every real invoice was filtered out. In production (2026-09-24) it
 * found 0 of 34 invoices, which is why "Add it to the invoice" could never find one.
 */
export const INVOICE_CANDIDATE_WHERE = {
  type: 'INVOICE',
  status: 'CREATED',
  qboId: { not: null },
} satisfies Prisma.QboTransactionWhereInput;

/** A freight-only invoice raised by the freight push — not the job's main invoice. */
export function isFreightSupplement(totalsSnapshot: unknown): boolean {
  return (
    !!totalsSnapshot &&
    typeof totalsSnapshot === 'object' &&
    (totalsSnapshot as { kind?: unknown }).kind === 'FREIGHT_SUPPLEMENT'
  );
}

export async function entriesOnInvoice(
  entries: Array<Pick<FreightEntry, 'id' | 'proposalId' | 'status' | 'trueUpId'>>,
): Promise<Set<string>> {
  const applied = entries.filter((e) => e.status === 'APPLIED');
  const out = new Set<string>();
  if (!applied.length) return out;

  const proposalIds = [...new Set(applied.map((e) => e.proposalId))];
  const [invoices, trueUps] = await Promise.all([
    prisma.qboTransaction.findMany({
      where: { proposalId: { in: proposalIds }, ...INVOICE_CANDIDATE_WHERE },
      orderBy: { createdAt: 'desc' },
      select: { proposalId: true, totalsSnapshot: true },
    }),
    prisma.freightTrueUp.findMany({
      where: { id: { in: [...new Set(applied.map((e) => e.trueUpId))] } },
      select: { id: true, newSnapshotId: true },
    }),
  ]);

  // The newest full invoice per job — the document freight is billed onto.
  const invoiceSnapshot = new Map<string, string>();
  for (const i of invoices) {
    if (isFreightSupplement(i.totalsSnapshot)) continue;
    const id = (i.totalsSnapshot as { priceSnapshotId?: unknown } | null)?.priceSnapshotId;
    if (i.proposalId && typeof id === 'string' && !invoiceSnapshot.has(i.proposalId))
      invoiceSnapshot.set(i.proposalId, id);
  }
  if (!invoiceSnapshot.size) return out;

  const appliedSnapshot = new Map(trueUps.map((t) => [t.id, t.newSnapshotId]));
  const snapshotIds = [
    ...new Set(
      [...invoiceSnapshot.values(), ...trueUps.map((t) => t.newSnapshotId)].filter(
        (x): x is string => !!x,
      ),
    ),
  ];
  const frozenAt = new Map(
    (
      await prisma.priceSnapshot.findMany({
        where: { id: { in: snapshotIds } },
        select: { id: true, createdAt: true },
      })
    ).map((s) => [s.id, s.createdAt.getTime()]),
  );

  for (const e of applied) {
    const inv = frozenAt.get(invoiceSnapshot.get(e.proposalId) ?? '');
    const own = frozenAt.get(appliedSnapshot.get(e.trueUpId) ?? '');
    if (inv !== undefined && own !== undefined && inv >= own) out.add(e.id);
  }
  return out;
}

/**
 * Applied figures still to be billed: not already on the invoice, and adding
 * something to it (a mats freight tax that did not go up adds nothing).
 */
export async function stillToBill<
  T extends Pick<
    FreightEntry,
    'id' | 'proposalId' | 'status' | 'trueUpId' | 'bucket' | 'amountMinor' | 'priorAmountMinor'
  >,
>(entries: T[]): Promise<T[]> {
  const onInvoice = await entriesOnInvoice(entries);
  return entries.filter(
    (e) => e.status === 'APPLIED' && !onInvoice.has(e.id) && billableMinor(e) > 0,
  );
}
