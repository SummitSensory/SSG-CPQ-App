import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { qboEnvironment } from '../../config/env.js';
import { readById } from './client.js';
import { syncTransactionState } from './billing.js';
import type { QboEnvironment } from '@prisma/client';

/**
 * Accounts receivable: what every customer was originally billed, and what they
 * still owe.
 *
 * QuickBooks is authoritative for both figures (see source-of-truth.ts) and
 * billing.ts already mirrors the current balance per document. What was missing is
 * three things:
 *
 *   1. **The invoice as first issued.** `qboTotalMinor` tracks the CURRENT total
 *      and moves whenever accounting edits the document, so on an edited invoice
 *      there was no record of what the customer was originally asked for.
 *      `initialTotalMinor` is written once and never again.
 *   2. **A company-wide view.** billing.ts answers "this proposal", which is the
 *      right question when you are looking at an order and the wrong one when the
 *      question is "who owes us money".
 *   3. **The invoice date and payment link**, both of which the payment-request
 *      letter has to state and neither of which was being read back.
 *
 * Nothing here writes a money value into QuickBooks.
 */

/** QuickBooks money is a decimal string/number of major units. */
function toMinor(v: unknown): bigint {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n * 100));
}

/** QuickBooks dates are yyyy-mm-dd; timestamps are ISO with an offset. */
function toDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function daysPastDue(dueDate: Date | null, balanceMinor: bigint | null): number {
  if (!dueDate || !balanceMinor || balanceMinor <= 0n) return 0;
  return Math.max(0, Math.floor((Date.now() - dueDate.getTime()) / 86_400_000));
}

async function activeRealmId(environment: QboEnvironment): Promise<string> {
  const conn = await prisma.qboConnection.findFirst({ where: { environment, isActive: true } });
  if (!conn) throw new ConflictError(`No active QuickBooks connection for ${environment}`);
  return conn.realmId;
}

interface QboInvoiceExtras {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  InvoiceLink?: string;
}

/**
 * Refresh one invoice from QuickBooks.
 *
 * billing.ts's syncTransactionState does the balance, the payments and the derived
 * status, and stays the only place that logic lives. This adds the three fields it
 * does not read, and it reads them only when something is missing — a second
 * Intuit round trip on every refresh of every invoice would double the cost of the
 * nightly sweep to re-learn an invoice date that cannot change.
 *
 * `force` is for the manual refresh button, where somebody is waiting and wants
 * the payment link picked up the moment it is switched on in QuickBooks.
 */
export async function refreshInvoice(
  txnId: string,
  opts: { force?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
) {
  const before = await prisma.qboTransaction.findUnique({ where: { id: txnId } });
  if (!before) throw new NotFoundError('Invoice not found');
  if (before.status !== 'CREATED' || !before.qboId) {
    throw new ConflictError('This document has not been created in QuickBooks yet');
  }

  const { transaction } = await syncTransactionState(txnId, fetchImpl);

  const needsExtras =
    opts.force ||
    transaction.initialTotalMinor == null ||
    transaction.invoiceDate == null ||
    transaction.qboInvoiceLink == null;

  let txn = transaction;
  if (needsExtras && before.type !== 'ESTIMATE') {
    const realmId = await activeRealmId(before.environment);
    // `include=invoiceLink` is the only way to obtain Intuit's shareable payment
    // URL; it is absent from an ordinary read, and absent entirely on a company
    // without online payment enabled — which is why a missing link is normal and
    // never an error.
    const read = await readById<{ Invoice?: QboInvoiceExtras }>(
      realmId,
      'invoice',
      before.qboId,
      fetchImpl,
      'invoiceLink',
    );
    const inv = read.Invoice;
    if (inv) {
      txn = await prisma.qboTransaction.update({
        where: { id: txnId },
        data: {
          // Written once. On an invoice created before this existed the current
          // total was seeded by migration 0070, and an edit after that must not
          // rewrite the record of what was first billed.
          ...(transaction.initialTotalMinor == null
            ? { initialTotalMinor: toMinor(inv.TotalAmt ?? 0) }
            : {}),
          invoiceDate: toDate(inv.TxnDate) ?? transaction.invoiceDate,
          qboInvoiceLink: inv.InvoiceLink ?? transaction.qboInvoiceLink,
        },
      });
    }
  }

  // Whether the PO on the order still matches what the document carries. Checked
  // on every refresh so a PO entered by someone else, or a document edited in
  // QuickBooks, shows up as needing a push without anyone having to notice.
  const order = await prisma.acceptedOrder.findUnique({
    where: { proposalVersionId: txn.proposalVersionId },
    select: { customerApproval: { select: { poNumber: true } } },
  });
  const orderPo = (order?.customerApproval?.poNumber ?? '').trim() || null;
  const needsPush = Boolean(orderPo) && orderPo !== (txn.poPushedValue ?? null);
  if (needsPush !== txn.poNeedsPush) {
    txn = await prisma.qboTransaction.update({
      where: { id: txnId },
      data: { poNeedsPush: needsPush },
    });
  }

  return txn;
}

/**
 * Refresh every invoice that could still be owed. Used by the nightly cron and by
 * the screen's Refresh button.
 *
 * `balanceMinor: null` is included: an invoice created but never synced has no
 * balance yet, and skipping it would leave it invisible on a screen whose whole
 * purpose is listing what is outstanding. Failures are collected rather than
 * thrown — one unreachable document must not stop the sweep.
 */
export async function refreshOpenInvoices(
  limit = 200,
  fetchImpl: typeof fetch = fetch,
): Promise<{ checked: number; refreshed: number; errors: Array<{ id: string; error: string }> }> {
  const environment = qboEnvironment() as QboEnvironment;
  const rows = await prisma.qboTransaction.findMany({
    where: {
      environment,
      status: 'CREATED',
      type: { not: 'ESTIMATE' },
      qboId: { not: null },
      OR: [{ balanceMinor: null }, { balanceMinor: { gt: 0 } }],
    },
    orderBy: { qboLastSyncedAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  const errors: Array<{ id: string; error: string }> = [];
  let refreshed = 0;
  for (const row of rows) {
    try {
      await refreshInvoice(row.id, {}, fetchImpl);
      refreshed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ id: row.id, error: message });
      logger.warn({ err, txnId: row.id }, 'receivables: refresh failed');
    }
  }
  return { checked: rows.length, refreshed, errors };
}

export interface LedgerRow {
  transactionId: string;
  type: string;
  docNumber: string | null;
  qboId: string | null;
  invoiceLink: string | null;
  currency: string;
  /** What the customer was first billed. */
  initialTotalMinor: string | null;
  /** What the document says now, which differs only if it was edited. */
  currentTotalMinor: string | null;
  paidMinor: string | null;
  balanceMinor: string | null;
  status: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  daysPastDue: number;
  lastSyncedAt: string | null;
  organization: { id: string; name: string } | null;
  order: { id: string; number: string } | null;
  proposal: { id: string; number: string };
  poNumber: string | null;
  poPushedValue: string | null;
  poNeedsPush: boolean;
  poFileCount: number;
  lastRequest: { at: string; toEmail: string; by: string; status: string } | null;
}

export interface Ledger {
  environment: string;
  generatedAt: string;
  totals: {
    invoicedMinor: string;
    paidMinor: string;
    outstandingMinor: string;
    pastDueMinor: string;
  };
  rows: LedgerRow[];
}

/**
 * Every invoice in QuickBooks for this environment, with what is left on it.
 *
 * Served from the local mirror — the sweep keeps it current, and a screen that
 * cost one Intuit round trip per invoice would take a minute to open and be rate
 * limited by lunchtime. `openOnly` is the default view; the paid ones stay
 * reachable because "did they ever pay that" is the second question anybody asks.
 */
export async function ledger(opts: { openOnly?: boolean } = {}): Promise<Ledger> {
  const environment = qboEnvironment() as QboEnvironment;
  const txns = await prisma.qboTransaction.findMany({
    where: {
      environment,
      status: 'CREATED',
      type: { not: 'ESTIMATE' },
      ...(opts.openOnly === false
        ? {}
        : { OR: [{ balanceMinor: null }, { balanceMinor: { gt: 0 } }] }),
    },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    take: 500,
  });

  const proposalIds = [...new Set(txns.map((t) => t.proposalId))];
  const versionIds = [...new Set(txns.map((t) => t.proposalVersionId))];
  const txnIds = txns.map((t) => t.id);

  const [proposals, orders, requests, poFiles] = await Promise.all([
    prisma.proposal.findMany({
      where: { id: { in: proposalIds } },
      select: { id: true, number: true, organizationId: true },
    }),
    prisma.acceptedOrder.findMany({
      where: { proposalVersionId: { in: versionIds } },
      select: {
        id: true,
        number: true,
        proposalVersionId: true,
        customerApproval: { select: { poNumber: true } },
      },
    }),
    prisma.paymentRequestEmail.findMany({
      where: { qboTransactionId: { in: txnIds } },
      orderBy: { createdAt: 'desc' },
      select: {
        qboTransactionId: true,
        createdAt: true,
        toEmail: true,
        sentByName: true,
        status: true,
      },
    }),
    prisma.customerPurchaseOrderFile.groupBy({
      by: ['orderId'],
      _count: { _all: true },
    }),
  ]);

  const proposalById = new Map(proposals.map((p) => [p.id, p]));
  const orderByVersion = new Map(orders.map((o) => [o.proposalVersionId, o]));
  const poFileCountByOrder = new Map(poFiles.map((f) => [f.orderId, f._count._all]));

  // Proposal carries organizationId, not an `organization` relation, so the customer
  // names are a second lookup rather than a join. One query for the whole page.
  const orgIds = [...new Set(proposals.map((p) => p.organizationId).filter(Boolean))];
  const orgs = orgIds.length
    ? await prisma.organization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, name: true },
      })
    : [];
  const orgById = new Map(orgs.map((o) => [o.id, o]));

  /** First hit wins: the query is newest-first, so this is the most recent. */
  const lastRequestByTxn = new Map<string, (typeof requests)[number]>();
  for (const r of requests)
    if (!lastRequestByTxn.has(r.qboTransactionId)) lastRequestByTxn.set(r.qboTransactionId, r);

  let invoiced = 0n;
  let paid = 0n;
  let outstanding = 0n;
  let pastDue = 0n;

  const rows: LedgerRow[] = txns.map((t) => {
    const proposal = proposalById.get(t.proposalId);
    const order = orderByVersion.get(t.proposalVersionId);
    const balance = t.balanceMinor ?? null;
    const overdueDays = daysPastDue(t.dueDate, balance);
    const last = lastRequestByTxn.get(t.id);

    invoiced += t.initialTotalMinor ?? t.qboTotalMinor ?? t.amountMinor;
    paid += t.paidMinor ?? 0n;
    outstanding += balance ?? 0n;
    if (overdueDays > 0) pastDue += balance ?? 0n;

    return {
      transactionId: t.id,
      type: t.type,
      docNumber: t.qboDocNumber,
      qboId: t.qboId,
      invoiceLink: t.qboInvoiceLink,
      currency: t.currency,
      initialTotalMinor: (t.initialTotalMinor ?? t.qboTotalMinor ?? t.amountMinor).toString(),
      currentTotalMinor: (t.qboTotalMinor ?? t.amountMinor).toString(),
      paidMinor: (t.paidMinor ?? 0n).toString(),
      balanceMinor: balance == null ? null : balance.toString(),
      status: t.qboStatus,
      invoiceDate: t.invoiceDate?.toISOString().slice(0, 10) ?? null,
      dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
      daysPastDue: overdueDays,
      lastSyncedAt: t.qboLastSyncedAt?.toISOString() ?? null,
      organization: proposal ? (orgById.get(proposal.organizationId) ?? null) : null,
      order: order ? { id: order.id, number: order.number } : null,
      proposal: { id: t.proposalId, number: proposal?.number ?? '' },
      poNumber: order?.customerApproval?.poNumber ?? null,
      poPushedValue: t.poPushedValue,
      poNeedsPush: t.poNeedsPush,
      poFileCount: order ? (poFileCountByOrder.get(order.id) ?? 0) : 0,
      lastRequest: last
        ? {
            at: last.createdAt.toISOString(),
            toEmail: last.toEmail,
            by: last.sentByName,
            status: last.status,
          }
        : null,
    };
  });

  return {
    environment,
    generatedAt: new Date().toISOString(),
    totals: {
      invoicedMinor: invoiced.toString(),
      paidMinor: paid.toString(),
      outstandingMinor: outstanding.toString(),
      pastDueMinor: pastDue.toString(),
    },
    rows,
  };
}
