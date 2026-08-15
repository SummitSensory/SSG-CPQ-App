import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';

/**
 * Releasing an order to manufacturing.
 *
 * Marking a proposal signed now CREATES the operational order — that is the
 * moment the customer committed, and the approval details are captured there.
 * Sending the job to the shop is a separate, later act, and this module owns it.
 *
 * Why they are separate: the order has to exist before anyone can raise a
 * QuickBooks invoice against it, and the invoice has to exist before the shop
 * starts cutting steel. Collapsing both into one button meant the only way to get
 * an order record was to commit to production at the same time.
 *
 * ---------------------------------------------------------------------------
 * The gate
 *
 * An order cannot be released until a QuickBooks INVOICE has been created for its
 * proposal — all three QuickBooks steps complete, not merely prepared or
 * authorized. `QboTxnStatus.CREATED` is precisely "the document exists in
 * QuickBooks", so that is the test.
 *
 * A DEPOSIT_INVOICE does NOT satisfy the gate. That is a deliberate reading of the
 * requirement rather than an oversight: a deposit invoice was offered as an
 * alternative and was not chosen. Because that distinction is easy to trip over,
 * the refusal message names every QuickBooks document that DOES exist for the
 * order, so the reason is visible rather than mysterious.
 *
 * The gate can be waived, by anyone who can release, with a typed reason. The
 * waiver emails Accounting — an order going to the shop with no invoice behind it
 * is their problem before it is anyone else's, and they should not have to
 * discover it by reconciling later.
 * ---------------------------------------------------------------------------
 */

const RESEND_URL = 'https://api.resend.com/emails';

/** Where invoice-waiver notices go. Falls back to the freight-notice list. */
const ACCOUNTING_NOTIFY = (
  process.env.ACCOUNTING_NOTIFY_EMAIL ??
  process.env.SALES_NOTIFY_EMAIL ??
  ''
)
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);

/** The QuickBooks transaction type that satisfies the release gate. */
const GATE_TYPE = 'INVOICE' as const;

export interface QboGateState {
  /** True when a QuickBooks invoice exists, or the requirement has been waived. */
  satisfied: boolean;
  /** True on the strength of a real invoice rather than a waiver. */
  invoiceCreated: boolean;
  invoiceCreatedAt: string | null;
  invoiceDocNumber: string | null;
  waived: boolean;
  waivedAt: string | null;
  waivedReason: string | null;
  /** Every QuickBooks document on this proposal, so a refusal can explain itself. */
  documents: { type: string; status: string; docNumber: string | null }[];
}

/**
 * Read the gate for one order without changing anything. Used by the order page
 * so the button can be disabled with a reason attached, rather than failing on
 * click.
 */
export async function qboGateState(orderId: string): Promise<QboGateState> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: {
      proposalId: true,
      qboInvoiceWaivedAt: true,
      qboInvoiceWaivedReason: true,
    },
  });
  if (!order) throw new NotFoundError('Order not found');

  const txns = await prisma.qboTransaction.findMany({
    where: { proposalId: order.proposalId },
    select: { id: true, type: true, status: true, qboDocNumber: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const invoice = txns.find((t) => t.type === GATE_TYPE && t.status === 'CREATED') ?? null;
  const waived = !!order.qboInvoiceWaivedAt;

  /**
   * When the invoice was actually generated in QuickBooks.
   *
   * NOT the transaction row's `updatedAt`: that column is `@updatedAt`, so every
   * later billing re-sync moves it, and the "generated" date would drift forwards
   * for the life of the invoice. The audit trail is append-only by contract
   * (lib/audit.ts never updates a row), so the `qbo.txn.create` entry for this
   * transaction is a fixed record of the moment it was written into QuickBooks.
   *
   * Rows created before that audit action existed fall back to the transaction's
   * own createdAt — which is when it was prepared, not created. That is a
   * knowingly imperfect answer for old records and an exact one for every new
   * invoice; the alternative was showing nothing at all.
   */
  let invoiceCreatedAt: string | null = null;
  if (invoice) {
    const created = await prisma.auditLog.findFirst({
      where: { action: 'qbo.txn.create', entity: 'QboTransaction', entityId: invoice.id },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    invoiceCreatedAt = (created?.createdAt ?? invoice.createdAt).toISOString();
  }

  return {
    satisfied: !!invoice || waived,
    invoiceCreated: !!invoice,
    invoiceCreatedAt,
    invoiceDocNumber: invoice?.qboDocNumber ?? null,
    waived,
    waivedAt: order.qboInvoiceWaivedAt ? order.qboInvoiceWaivedAt.toISOString() : null,
    waivedReason: order.qboInvoiceWaivedReason ?? null,
    documents: txns.map((t) => ({
      type: t.type,
      status: t.status,
      docNumber: t.qboDocNumber ?? null,
    })),
  };
}

/** Order-scoped event, same shape as the ones service.ts writes. */
async function logEvent(
  orderId: string,
  action: string,
  actorId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await prisma.orderEvent.create({
    data: { orderId, action, actorId, detail: detail as object },
  });
}

/**
 * Waive the QuickBooks-invoice requirement for one order.
 *
 * The reason is stored, put on the order timeline, and emailed to Accounting. A
 * mail failure does not roll the waiver back — the decision has been made and
 * recorded, and discarding it because an email bounced would be worse. The failure
 * is returned so the browser can say so.
 */
export async function waiveQboInvoice(
  orderId: string,
  reason: string,
  userId: string,
): Promise<{ waivedAt: string; notifyError: string | null }> {
  const trimmed = String(reason ?? '').trim();
  if (trimmed.length < 10)
    throw new ValidationError(
      'Give a reason for skipping the QuickBooks invoice — it goes on the order record and to Accounting.',
    );

  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { id: true, number: true, status: true, organizationId: true, grandTotalMinor: true },
  });
  if (!order) throw new NotFoundError('Order not found');
  if (order.status === 'CANCELLED')
    throw new ConflictError('That order is cancelled — nothing to waive.');

  const gate = await qboGateState(orderId);
  if (gate.invoiceCreated)
    throw new ValidationError(
      'A QuickBooks invoice already exists for this order, so there is nothing to skip.',
    );
  if (gate.waived) throw new ValidationError('The invoice requirement is already waived.');

  const at = new Date();
  await prisma.acceptedOrder.update({
    where: { id: orderId },
    data: {
      qboInvoiceWaivedAt: at,
      qboInvoiceWaivedById: userId,
      qboInvoiceWaivedReason: trimmed,
    },
  });
  await logEvent(orderId, 'order.qbo_invoice.waived', userId, { reason: trimmed });
  await recordAudit({
    actorId: userId,
    action: 'order.qbo_invoice.waive',
    entity: 'AcceptedOrder',
    entityId: orderId,
    details: { number: order.number, reason: trimmed },
  });

  const who = await actorName(userId);
  const org = await prisma.organization.findUnique({
    where: { id: order.organizationId },
    select: { name: true },
  });
  const notifyError = await notifyAccounting(
    `No QuickBooks invoice for ${order.number} — requirement waived`,
    [
      `${who} released ${order.number} to manufacturing without a QuickBooks invoice.`,
      '',
      `Order: ${order.number}`,
      `Customer: ${org?.name ?? 'unknown'}`,
      `Order total: ${money(order.grandTotalMinor)}`,
      `Waived by: ${who}`,
      `Waived at: ${at.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/New_York' })} (Eastern)`,
      '',
      'Reason given:',
      trimmed,
      '',
      'No invoice exists in QuickBooks for this job. If one is expected, it still needs raising.',
    ].join('\n'),
  );
  if (notifyError) {
    logger.warn({ orderId, notifyError }, 'invoice waiver: Accounting was not emailed');
  }

  return { waivedAt: at.toISOString(), notifyError };
}

/**
 * Release an order to manufacturing. Refused unless the QuickBooks gate is
 * satisfied, and refused a second time if it has already been released — the
 * release timestamp is the record of when the shop was told to start, and
 * overwriting it would lose that.
 */
export async function releaseToManufacturing(
  orderId: string,
  userId: string,
): Promise<{ releasedAt: string; viaWaiver: boolean }> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { id: true, number: true, status: true, manufacturingReleasedAt: true },
  });
  if (!order) throw new NotFoundError('Order not found');
  if (order.status === 'CANCELLED')
    throw new ConflictError('That order is cancelled and cannot go to manufacturing.');
  if (order.manufacturingReleasedAt)
    throw new ConflictError(
      `${order.number} was already released to manufacturing on ${order.manufacturingReleasedAt.toISOString().slice(0, 10)}.`,
    );

  const gate = await qboGateState(orderId);
  if (!gate.satisfied) {
    // Name what DOES exist. "Complete the QuickBooks steps" on its own sends people
    // looking at a screen where, as far as they can tell, they already did.
    const found = gate.documents.length
      ? gate.documents
          .map((d) => `${d.type.toLowerCase().replace(/_/g, ' ')} (${d.status.toLowerCase()})`)
          .join(', ')
      : 'nothing has been prepared yet';
    throw new ValidationError(
      'This order needs a QuickBooks invoice before it can go to manufacturing. ' +
        `Complete steps 1 to 3 so the invoice reaches Created — currently: ${found}. ` +
        'A deposit invoice does not satisfy this. To proceed without one, use the ' +
        'override and give a reason.',
    );
  }

  const at = new Date();
  await prisma.acceptedOrder.update({
    where: { id: orderId },
    data: { manufacturingReleasedAt: at, manufacturingReleasedById: userId },
  });
  await logEvent(orderId, 'order.manufacturing.released', userId, {
    viaWaiver: !gate.invoiceCreated,
    invoiceDocNumber: gate.invoiceDocNumber,
  });
  await recordAudit({
    actorId: userId,
    action: 'order.manufacturing.release',
    entity: 'AcceptedOrder',
    entityId: orderId,
    details: {
      number: order.number,
      viaWaiver: !gate.invoiceCreated,
      invoiceDocNumber: gate.invoiceDocNumber,
    },
  });

  return { releasedAt: at.toISOString(), viaWaiver: !gate.invoiceCreated };
}

const money = (minor: bigint | number) =>
  `USD ${(Number(minor) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

async function actorName(userId: string): Promise<string> {
  const u = await prisma.user
    .findUnique({ where: { id: userId }, select: { name: true, email: true } })
    .catch(() => null);
  return u?.name || u?.email || userId;
}

/** Returns null on success, or why the notice did not go out. Never throws. */
async function notifyAccounting(subject: string, body: string): Promise<string | null> {
  if (!ACCOUNTING_NOTIFY.length) return 'ACCOUNTING_NOTIFY_EMAIL is not set — nobody was emailed.';
  if (!env.RESEND_API_KEY) return 'RESEND_API_KEY is not set — nobody was emailed.';
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${env.BOM_FROM_NAME} <${env.BOM_FROM_EMAIL}>`,
        to: ACCOUNTING_NOTIFY,
        reply_to: env.BOM_REPLY_TO,
        subject,
        text: body,
      }),
    });
    if (!res.ok) return `Resend rejected the notification (${res.status})`;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'notification failed';
  }
}
