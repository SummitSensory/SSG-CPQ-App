import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { qboEnvironment } from '../../config/env.js';
import { query, readById, sendDocument, fetchPdf } from './client.js';
import { QboApiError } from './http.js';
import type { QboEnvironment } from '@prisma/client';

/**
 * The billing half of the QuickBooks integration: what happened to a document
 * AFTER it was created.
 *
 * `transactions.ts` owns the write path (prepare → authorize → execute) and
 * stops the moment the document exists. Everything here is the read-back and
 * the delivery, which per `source-of-truth.ts` is QuickBooks-authoritative:
 * delivery time, balance, payment status and applied payments are read FROM
 * QuickBooks and mirrored locally for display. Nothing in this file writes a
 * money value into QuickBooks, and nothing writes a QuickBooks-owned value into
 * a CPQ financial field.
 *
 * The mirror exists so the CRM can answer "was this sent, when, and has it been
 * paid" without a round trip on every page view, and so those answers survive
 * in history even after the invoice is closed.
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

interface QboLinkedTxn {
  TxnId: string;
  TxnType: string;
}

interface QboInvoice {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  /**
   * Intuit stamps “Voided” into the private note when a document is voided. There is
   * no boolean and no status field to read — see isVoidedDoc().
   */
  PrivateNote?: string;
  /** NotSet | NeedToSend | EmailSent */
  EmailStatus?: string;
  BillEmail?: { Address?: string };
  DeliveryInfo?: { DeliveryType?: string; DeliveryTime?: string };
  LinkedTxn?: QboLinkedTxn[];
  CustomerRef?: { value: string; name?: string };
  CurrencyRef?: { value: string };
}

interface QboPaymentLine {
  Amount?: number;
  LinkedTxn?: QboLinkedTxn[];
}

interface QboPaymentObj {
  Id: string;
  TxnDate?: string;
  TotalAmt?: number;
  UnappliedAmt?: number;
  PaymentRefNum?: string;
  PaymentMethodRef?: { value: string; name?: string };
  DepositToAccountRef?: { value: string; name?: string };
  CustomerRef?: { value: string; name?: string };
  CurrencyRef?: { value: string };
  Line?: QboPaymentLine[];
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

/** Escape a QuickBooks query string literal. */
function esc(s: string): string {
  return s.replace(/'/g, "\\'");
}

async function activeRealmId(environment: QboEnvironment): Promise<string> {
  const conn = await prisma.qboConnection.findFirst({ where: { environment, isActive: true } });
  if (!conn) throw new ConflictError(`No active QuickBooks connection for ${environment}`);
  return conn.realmId;
}

async function loadCreated(txnId: string) {
  const txn = await prisma.qboTransaction.findUnique({ where: { id: txnId } });
  if (!txn) throw new NotFoundError('Transaction not found');
  // Two different situations used to share one message. A document never pushed and
  // a document voided in QuickBooks are both “not CREATED”, and telling somebody
  // their voided invoice “has not been created yet” sends them looking for a push
  // button that will not help.
  if (txn.status === 'VOIDED') {
    throw new ConflictError(
      'This document was voided in QuickBooks. Raise a new one rather than acting on the voided document.',
    );
  }
  if (txn.status !== 'CREATED' || !txn.qboId) {
    throw new ConflictError('This document has not been created in QuickBooks yet');
  }
  return txn;
}

/**
 * Whether QuickBooks is showing us a voided document.
 *
 * QuickBooks does not delete a voided invoice and does not expose a void flag. It
 * zeroes every line, sets total and balance to zero, and prepends “Voided” to the
 * private note — that stamp is the only positive signal there is.
 *
 * Both signals are required. The note alone would catch an invoice somebody typed
 * the word into; a zero total alone would catch a legitimately zero document. Calling
 * a live invoice void is much worse than missing one, because it releases an order
 * that QuickBooks still has money against.
 */
export function isVoidedDoc(doc: {
  TotalAmt?: number;
  Balance?: number;
  PrivateNote?: string;
}): boolean {
  const zero = Number(doc.TotalAmt ?? 0) === 0 && Number(doc.Balance ?? 0) === 0;
  return zero && /(^|\s)voided\b/i.test(String(doc.PrivateNote ?? ''));
}

/**
 * True when QuickBooks says the document is no longer there.
 *
 * A hard delete answers 404, and the v3 API also reports a read of a missing object
 * as HTTP 400 with fault code 610. Either way it is gone, which for our purposes is
 * the same as voided: there is nothing left in the books to disagree with.
 */
function isGoneFromQbo(err: unknown): boolean {
  if (!(err instanceof QboApiError)) return false;
  return err.status === 404 || err.faultCode === '610' || err.faultCode === '6240';
}

/**
 * Move the local mirror row to VOIDED.
 *
 * This is the only place a document is voided off the back of QuickBooks, and it is
 * what releases every gate keyed on `status: 'CREATED'` — the order unlock, the
 * manufacturing release, the freight true-up. Those heal on their own once this runs;
 * none of them needed changing.
 */
async function markVoided(txnId: string, why: string, actorId = 'system') {
  const updated = await prisma.qboTransaction.update({
    where: { id: txnId },
    data: {
      status: 'VOIDED',
      qboStatus: 'VOIDED',
      balanceMinor: 0n,
      qboLastSyncedAt: new Date(),
      error: null,
    },
  });
  // Payments cannot stand against a document that no longer carries a balance.
  // Leaving them would keep the customer credited for money the books have released.
  await prisma.qboPayment.deleteMany({ where: { qboTransactionId: txnId } });
  await recordAudit({
    actorId,
    action: 'qbo.txn.voided_in_quickbooks',
    entity: 'QboTransaction',
    entityId: txnId,
    details: { type: updated.type, docNumber: updated.qboDocNumber, reason: why },
  });
  logger.info({ txnId, docNumber: updated.qboDocNumber, why }, 'quickbooks: document voided');
  return updated;
}

function resourceFor(type: string): 'estimate' | 'invoice' {
  return type === 'ESTIMATE' ? 'estimate' : 'invoice';
}

/**
 * Derived, human-readable state. QuickBooks has no single "status" field on an
 * invoice — it is inferred from balance against total, which is why the same
 * inference has to live in exactly one place.
 */
export function deriveStatus(
  totalMinor: bigint,
  balanceMinor: bigint,
  dueDate: Date | null,
): string {
  if (balanceMinor <= 0n && totalMinor > 0n) return 'PAID';
  if (balanceMinor > 0n && balanceMinor < totalMinor) return 'PARTIALLY_PAID';
  if (dueDate && balanceMinor > 0n && dueDate.getTime() < Date.now()) return 'OVERDUE';
  return 'OPEN';
}

/**
 * Pull the live state of one created document and mirror it locally: delivery,
 * balance, and every payment applied to it.
 *
 * Delivery time comes from QuickBooks' own DeliveryInfo, not from our send
 * call. That matters: an invoice sent by hand from inside QuickBooks is just as
 * real as one sent from here, and reading Intuit's field means the CRM shows it
 * either way rather than claiming the invoice was never sent.
 *
 * It also detects a document voided or deleted in QuickBooks and retires the mirror
 * row. Without that the CRM believes a live invoice exists for ever: voiding is done
 * in QuickBooks, nothing pushes the fact back, and every gate keyed on a live
 * document stays shut with no way to open it from inside this system.
 */
export async function syncTransactionState(
  txnId: string,
  fetchImpl: typeof fetch = fetch,
  actorId = 'system',
) {
  const txn = await loadCreated(txnId);
  const realmId = await activeRealmId(txn.environment);
  const resource = resourceFor(txn.type);

  let wrapper: Record<string, QboInvoice>;
  try {
    wrapper = await readById<Record<string, QboInvoice>>(realmId, resource, txn.qboId!, fetchImpl);
  } catch (err) {
    // Deleted outright rather than voided. Retiring the row is the only honest
    // answer: the document this row mirrors does not exist any more.
    if (isGoneFromQbo(err)) {
      const updated = await markVoided(txnId, 'no longer present in QuickBooks', actorId);
      return { transaction: updated, payments: [] };
    }
    throw err;
  }
  const doc = wrapper[txn.type === 'ESTIMATE' ? 'Estimate' : 'Invoice'];
  if (!doc) throw new NotFoundError(`QuickBooks returned no ${resource} for id ${txn.qboId}`);

  if (isVoidedDoc(doc)) {
    const updated = await markVoided(txnId, 'voided in QuickBooks', actorId);
    return { transaction: updated, payments: [] };
  }

  const totalMinor = toMinor(doc.TotalAmt ?? 0);
  const balanceMinor = toMinor(doc.Balance ?? 0);
  const dueDate = toDate(doc.DueDate);
  const sentAt = toDate(doc.DeliveryInfo?.DeliveryTime);

  const updated = await prisma.qboTransaction.update({
    where: { id: txnId },
    data: {
      qboSyncToken: doc.SyncToken,
      qboDocNumber: doc.DocNumber ?? txn.qboDocNumber,
      emailStatus: doc.EmailStatus ?? null,
      // Only ever moves forward. A DeliveryInfo that comes back empty (Intuit
      // clears it on some edits) must not erase a delivery we recorded.
      sentAt: sentAt ?? txn.sentAt,
      sentToEmail: doc.BillEmail?.Address ?? txn.sentToEmail,
      dueDate,
      qboTotalMinor: totalMinor,
      balanceMinor,
      paidMinor: totalMinor - balanceMinor,
      qboStatus: deriveStatus(totalMinor, balanceMinor, dueDate),
      qboLastSyncedAt: new Date(),
    },
  });

  const payments =
    txn.type === 'ESTIMATE' ? [] : await syncPaymentsFor(txn.id, realmId, doc, fetchImpl);

  return { transaction: updated, payments };
}

/**
 * Mirror the payments applied to one invoice.
 *
 * Read by customer and filtered to this invoice's id rather than by a direct
 * lookup: QuickBooks models a payment as its own document with lines linking to
 * one or more invoices, so "the payments on invoice X" is only answerable from
 * the payment side. A single cheque covering three invoices therefore appears
 * on all three, each carrying the portion applied to it — `amountMinor` — while
 * `totalAmountMinor` keeps the whole cheque visible so the numbers make sense.
 */
async function syncPaymentsFor(
  txnId: string,
  realmId: string,
  doc: QboInvoice,
  fetchImpl: typeof fetch = fetch,
) {
  const customerId = doc.CustomerRef?.value;
  if (!customerId) return [];

  const res = await query<{ Payment?: QboPaymentObj[] }>(
    realmId,
    `select * from Payment where CustomerRef = '${esc(customerId)}' maxresults 200`,
    fetchImpl,
  );
  const environment = qboEnvironment() as QboEnvironment;
  const kept: string[] = [];

  for (const p of res.Payment ?? []) {
    let appliedMinor = 0n;
    for (const line of p.Line ?? []) {
      const hits = (line.LinkedTxn ?? []).some(
        (l) => l.TxnType === 'Invoice' && String(l.TxnId) === String(doc.Id),
      );
      if (hits) appliedMinor += toMinor(line.Amount ?? 0);
    }
    if (appliedMinor === 0n) continue;

    const data = {
      environment,
      qboPaymentId: p.Id,
      qboTransactionId: txnId,
      customerQboId: customerId,
      amountMinor: appliedMinor,
      totalAmountMinor: toMinor(p.TotalAmt ?? 0),
      unappliedMinor: toMinor(p.UnappliedAmt ?? 0),
      currency: p.CurrencyRef?.value ?? 'USD',
      method: p.PaymentMethodRef?.name ?? null,
      referenceNumber: p.PaymentRefNum ?? null,
      depositToAccount: p.DepositToAccountRef?.name ?? null,
      txnDate: toDate(p.TxnDate) ?? new Date(),
      qboCreatedAt: toDate(p.MetaData?.CreateTime),
      qboUpdatedAt: toDate(p.MetaData?.LastUpdatedTime),
    };

    await prisma.qboPayment.upsert({
      where: {
        environment_qboPaymentId_qboTransactionId: {
          environment,
          qboPaymentId: p.Id,
          qboTransactionId: txnId,
        },
      },
      create: data,
      update: data,
    });
    kept.push(p.Id);
  }

  // A payment deleted or unapplied in QuickBooks must disappear here too, or
  // the CRM keeps showing money the customer no longer has credited.
  await prisma.qboPayment.deleteMany({
    where: { qboTransactionId: txnId, qboPaymentId: { notIn: kept.length ? kept : ['__none__'] } },
  });

  return prisma.qboPayment.findMany({
    where: { qboTransactionId: txnId },
    orderBy: { txnDate: 'desc' },
  });
}

/**
 * Send the document to the customer through QuickBooks, then immediately
 * re-read it so the recorded delivery time is Intuit's, not our clock.
 *
 * Recorded whether it succeeds or fails. A failed send that leaves no trace is
 * how someone concludes the customer was invoiced when they were not.
 */
export async function sendTransaction(
  txnId: string,
  userId: string,
  toEmail: string | null,
  fetchImpl: typeof fetch = fetch,
) {
  const txn = await loadCreated(txnId);
  const realmId = await activeRealmId(txn.environment);
  const resource = resourceFor(txn.type);

  if (toEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) {
    throw new ValidationError(`"${toEmail}" is not a valid email address`);
  }

  try {
    await sendDocument(realmId, resource, txn.qboId!, toEmail, fetchImpl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.qboTransaction.update({
      where: { id: txnId },
      data: { sendError: message, lastSendAttemptAt: new Date() },
    });
    await prisma.integrationSyncLog.create({
      data: {
        provider: 'quickbooks',
        direction: 'OUTBOUND',
        entity: `${txn.type}_SEND`,
        entityId: txnId,
        externalId: txn.qboId,
        status: 'error',
        error: message,
      },
    });
    await recordAudit({
      actorId: userId,
      action: 'qbo.txn.send_failed',
      entity: 'QboTransaction',
      entityId: txnId,
      details: { to: toEmail, error: message },
    });
    logger.error({ err, txnId }, 'QuickBooks send failed');
    throw new ValidationError(`QuickBooks could not send the document: ${message}`);
  }

  await prisma.qboTransaction.update({
    where: { id: txnId },
    data: { sendError: null, sentById: userId, lastSendAttemptAt: new Date() },
  });
  await prisma.integrationSyncLog.create({
    data: {
      provider: 'quickbooks',
      direction: 'OUTBOUND',
      entity: `${txn.type}_SEND`,
      entityId: txnId,
      externalId: txn.qboId,
      status: 'ok',
    },
  });
  await recordAudit({
    actorId: userId,
    action: 'qbo.txn.send',
    entity: 'QboTransaction',
    entityId: txnId,
    details: { to: toEmail, type: txn.type, docNumber: txn.qboDocNumber },
  });

  return syncTransactionState(txnId, fetchImpl);
}

/** The document as the customer received it. Streamed through, never cached. */
export async function documentPdf(txnId: string, fetchImpl: typeof fetch = fetch) {
  const txn = await loadCreated(txnId);
  const realmId = await activeRealmId(txn.environment);
  const pdf = await fetchPdf(realmId, resourceFor(txn.type), txn.qboId!, fetchImpl);
  const label = (txn.qboDocNumber || txn.qboId || 'document').replace(/[^A-Za-z0-9._-]/g, '');
  return { pdf, filename: `${txn.type === 'ESTIMATE' ? 'Estimate' : 'Invoice'}-${label}.pdf` };
}

export interface VoidSweepResult {
  /** Documents re-read from QuickBooks this run. */
  checked: number;
  /** Of those, the ones QuickBooks had voided or deleted. */
  retired: Array<{ id: string; docNumber: string | null; proposalId: string }>;
  /** Reads that failed. The document stays live here; it is tried again tomorrow. */
  errors: Array<{ id: string; error: string }>;
  /** Hit the per-run cap — more documents are waiting. */
  truncated: boolean;
}

/**
 * Re-read live QuickBooks documents and retire the ones that have been voided.
 *
 * Voiding happens in QuickBooks and nothing pushes the fact back. Every other place
 * that notices — the billing panel's refresh, the order unlock — only looks when a
 * person asks it to, so until someone opens the right screen the CRM goes on showing
 * a live invoice that no longer exists and goes on blocking whatever that invoice
 * gates. This is the sweep that closes the gap without anybody having to look.
 *
 * Least-recently-synced first, and capped: each document is an API read plus a
 * payment query, and Intuit's rate limit is per-realm. A backlog drains over
 * successive nights rather than being pushed through in one run that times out
 * halfway with no record of where it stopped.
 *
 * Never throws. One unreadable document must not stop the rest of the sweep.
 */
export async function sweepVoidedDocuments(
  opts: { max?: number; staleHours?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<VoidSweepResult> {
  const max = Math.min(Math.max(opts.max ?? 40, 1), 200);
  const staleHours = opts.staleHours ?? 6;
  const cutoff = new Date(Date.now() - staleHours * 3_600_000);
  const environment = qboEnvironment() as QboEnvironment;
  const out: VoidSweepResult = { checked: 0, retired: [], errors: [], truncated: false };

  const candidates = await prisma.qboTransaction.findMany({
    where: {
      environment,
      status: 'CREATED',
      qboId: { not: null },
      OR: [{ qboLastSyncedAt: null }, { qboLastSyncedAt: { lt: cutoff } }],
    },
    orderBy: [{ qboLastSyncedAt: 'asc' }, { createdAt: 'asc' }],
    take: max + 1,
    select: { id: true, proposalId: true, qboDocNumber: true },
  });
  out.truncated = candidates.length > max;

  for (const c of candidates.slice(0, max)) {
    out.checked++;
    try {
      const { transaction } = await syncTransactionState(c.id, fetchImpl);
      if (transaction.status === 'VOIDED')
        out.retired.push({
          id: c.id,
          docNumber: transaction.qboDocNumber,
          proposalId: c.proposalId,
        });
    } catch (err) {
      out.errors.push({ id: c.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  logger.info(
    { checked: out.checked, retired: out.retired.length, errors: out.errors.length },
    'quickbooks: void sweep',
  );
  return out;
}

/**
 * The billing picture for one proposal: every created document with its
 * delivery and payment state, plus the payments themselves.
 *
 * Served from the local mirror. `refresh` re-reads QuickBooks first — used by
 * the panel's refresh button and before composing a reminder, so nobody chases
 * a customer for a balance that was settled this morning.
 */
export async function billingForProposal(
  proposalId: string,
  opts: { refresh?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
) {
  const environment = qboEnvironment() as QboEnvironment;
  let txns = await prisma.qboTransaction.findMany({
    where: { proposalId, environment },
    orderBy: { createdAt: 'desc' },
  });

  const errors: Array<{ id: string; error: string }> = [];
  if (opts.refresh) {
    for (const t of txns.filter((t) => t.status === 'CREATED' && t.qboId)) {
      try {
        await syncTransactionState(t.id, fetchImpl);
      } catch (err) {
        errors.push({ id: t.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    txns = await prisma.qboTransaction.findMany({
      where: { proposalId, environment },
      orderBy: { createdAt: 'desc' },
    });
  }

  const ids = txns.map((t) => t.id);
  const [payments, reminders] = await Promise.all([
    prisma.qboPayment.findMany({
      where: { qboTransactionId: { in: ids } },
      orderBy: { txnDate: 'desc' },
    }),
    prisma.paymentReminder.findMany({
      where: { qboTransactionId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  const actorIds = [
    ...new Set(
      [...txns.map((t) => t.sentById), ...reminders.map((r) => r.sentById)].filter(
        Boolean,
      ) as string[],
    ),
  ];
  const users = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  const money = (v: bigint | null) => (v == null ? null : v.toString());

  return {
    environment,
    refreshErrors: errors,
    documents: txns.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      qboId: t.qboId,
      qboDocNumber: t.qboDocNumber,
      currency: t.currency,
      amountMinor: money(t.amountMinor),
      qboTotalMinor: money(t.qboTotalMinor),
      balanceMinor: money(t.balanceMinor),
      paidMinor: money(t.paidMinor),
      qboStatus: t.qboStatus,
      emailStatus: t.emailStatus,
      sentAt: t.sentAt?.toISOString() ?? null,
      sentToEmail: t.sentToEmail,
      sentBy: t.sentById ? (nameById.get(t.sentById) ?? null) : null,
      lastSendAttemptAt: t.lastSendAttemptAt?.toISOString() ?? null,
      sendError: t.sendError,
      dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
      lastSyncedAt: t.qboLastSyncedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      error: t.error,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      transactionId: p.qboTransactionId,
      qboPaymentId: p.qboPaymentId,
      amountMinor: p.amountMinor.toString(),
      totalAmountMinor: p.totalAmountMinor.toString(),
      unappliedMinor: p.unappliedMinor.toString(),
      currency: p.currency,
      method: p.method,
      referenceNumber: p.referenceNumber,
      depositToAccount: p.depositToAccount,
      txnDate: p.txnDate.toISOString().slice(0, 10),
      recordedAt: p.qboCreatedAt?.toISOString() ?? null,
    })),
    reminders: reminders.map((r) => ({
      id: r.id,
      transactionId: r.qboTransactionId,
      toEmail: r.toEmail,
      ccEmail: r.ccEmail,
      subject: r.subject,
      balanceMinor: r.balanceMinor.toString(),
      status: r.status,
      error: r.error,
      sentBy: r.sentByName || (r.sentById ? (nameById.get(r.sentById) ?? null) : null),
      at: r.createdAt.toISOString(),
    })),
  };
}
