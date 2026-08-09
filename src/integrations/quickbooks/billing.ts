import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { qboEnvironment } from '../../config/env.js';
import { query, readById, sendDocument, fetchPdf } from './client.js';
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
  if (txn.status !== 'CREATED' || !txn.qboId) {
    throw new ConflictError('This document has not been created in QuickBooks yet');
  }
  return txn;
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
 */
export async function syncTransactionState(txnId: string, fetchImpl: typeof fetch = fetch) {
  const txn = await loadCreated(txnId);
  const realmId = await activeRealmId(txn.environment);
  const resource = resourceFor(txn.type);

  const wrapper = await readById<Record<string, QboInvoice>>(
    realmId,
    resource,
    txn.qboId!,
    fetchImpl,
  );
  const doc = wrapper[txn.type === 'ESTIMATE' ? 'Estimate' : 'Invoice'];
  if (!doc) throw new NotFoundError(`QuickBooks returned no ${resource} for id ${txn.qboId}`);

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
