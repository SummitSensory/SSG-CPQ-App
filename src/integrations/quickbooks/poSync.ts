import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { qboEnvironment } from '../../config/env.js';
import { readById, update } from './client.js';
import { customFieldId } from './customFields.js';
import type { QboEnvironment } from '@prisma/client';

/**
 * Writing the customer's purchase-order number onto an invoice that ALREADY
 * exists in QuickBooks.
 *
 * transactions.ts puts the PO on at creation time, which covers the case where
 * the customer raised it before the order was placed. It routinely is not: a PO
 * is issued days or weeks later, by which point the invoice exists and the
 * reference their accounts-payable team matches against is missing from it. That
 * is the single most common reason an invoice sits unpaid pending "which PO is
 * this?", and until now the only fix was to type it into QuickBooks by hand.
 *
 * Two places carry the value on the document and both are written here:
 *
 *   1. The legacy sales-form custom field, when the company has one. QuickBooks'
 *      v3 API can only write those three legacy slots — the newer Custom Fields
 *      feature (Settings → Custom fields) is not writable through the API at all.
 *   2. The Note to customer, always. On a company whose fields are on the newer
 *      feature that is the only place the reference can appear on the document the
 *      customer receives, so it is not a consolation prize.
 *
 * Nothing else about the invoice is touched. `sparse: true` and a re-read
 * SyncToken mean an accounting edit made in QuickBooks between the read and the
 * write is rejected (fault 5010) rather than silently overwritten.
 */

/** The label the memo block uses. Written and matched in exactly one place. */
const MEMO_PO_LABEL = 'Customer PO:';
const MEMO_PROJECT_LABEL = 'Project ID:';

interface QboCustomField {
  DefinitionId?: string;
  Name?: string;
  Type?: string;
  StringValue?: string;
}

interface QboInvoiceHead {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
  CustomField?: QboCustomField[];
  CustomerMemo?: { value?: string };
}

async function activeRealmId(environment: QboEnvironment): Promise<string> {
  const conn = await prisma.qboConnection.findFirst({ where: { environment, isActive: true } });
  if (!conn) throw new ConflictError(`No active QuickBooks connection for ${environment}`);
  return conn.realmId;
}

/**
 * Put the PO line into a Note to customer, in the position it belongs.
 *
 * The memo is a labelled block, one reference per line, in the order accounts
 * payable needs them: Project ID, then the PO, then the proposal it came from. So
 * an existing PO line is replaced in place, and a new one is inserted after the
 * Project ID rather than appended at the end where it would read as an
 * afterthought below the proposal reference.
 */
export function memoWithPoNumber(
  existingMemo: string | null | undefined,
  poNumber: string,
): string {
  const lines = String(existingMemo ?? '')
    .split('\n')
    .filter((l) => !l.trim().toLowerCase().startsWith(MEMO_PO_LABEL.toLowerCase()));
  const poLine = `${MEMO_PO_LABEL}  ${poNumber}`;

  const projectAt = lines.findIndex((l) =>
    l.trim().toLowerCase().startsWith(MEMO_PROJECT_LABEL.toLowerCase()),
  );
  if (projectAt >= 0) lines.splice(projectAt + 1, 0, poLine);
  else lines.unshift(poLine);

  return lines
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
}

/**
 * Merge the PO into the document's custom fields without disturbing the others.
 *
 * A sparse update replaces the whole CustomField array, so the fields already on
 * the invoice — Project ID in particular — have to be sent back with it. Omitting
 * them clears them, which turns filling in one reference into losing another.
 */
export function customFieldsWithPo(
  existing: QboCustomField[] | undefined,
  slot: string,
  poNumber: string,
): QboCustomField[] {
  const kept = (existing ?? []).filter((f) => String(f.DefinitionId ?? '') !== slot);
  const previous = (existing ?? []).find((f) => String(f.DefinitionId ?? '') === slot);
  return [
    ...kept,
    {
      DefinitionId: slot,
      Name: previous?.Name ?? 'Customer Purchase Order #',
      Type: 'StringType',
      StringValue: poNumber,
    },
  ];
}

export interface PoPushResult {
  pushed: boolean;
  poNumber: string;
  docNumber: string | null;
  /** 'custom field' when a legacy slot took it, 'memo only' otherwise. */
  wroteTo: 'custom field and memo' | 'memo only';
  slot: string | null;
}

/**
 * Push the order's current PO number onto its QuickBooks invoice.
 *
 * The value comes from the order, never from the caller. A route that accepted a
 * PO number in the request body would let the document say something the CRM does
 * not — and the CRM's copy is what the proposal, the BOM and the shop paperwork
 * all print.
 */
export async function pushPoToInvoice(
  txnId: string,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PoPushResult> {
  const txn = await prisma.qboTransaction.findUnique({ where: { id: txnId } });
  if (!txn) throw new NotFoundError('Invoice not found');
  if (txn.type === 'ESTIMATE') {
    throw new ValidationError('An estimate carries no purchase-order reference.');
  }
  if (txn.status !== 'CREATED' || !txn.qboId) {
    throw new ConflictError(
      'This invoice does not exist in QuickBooks yet, so there is nothing to update. The PO will be written on when it is created.',
    );
  }

  const order = await prisma.acceptedOrder.findUnique({
    where: { proposalVersionId: txn.proposalVersionId },
    select: { id: true, customerApproval: { select: { poNumber: true } } },
  });
  const poNumber = (order?.customerApproval?.poNumber ?? '').trim();
  if (!poNumber) {
    throw new ValidationError(
      'There is no purchase-order number on this order yet. Enter it first, then push it to QuickBooks.',
    );
  }

  const realmId = await activeRealmId(txn.environment);
  const read = await readById<{ Invoice?: QboInvoiceHead }>(
    realmId,
    'invoice',
    txn.qboId,
    fetchImpl,
  );
  const inv = read.Invoice;
  if (!inv) throw new NotFoundError(`QuickBooks returned no invoice for id ${txn.qboId}`);

  // Env override first, then the company's own preferences by field NAME. No
  // fallback to slot '1': a guessed slot on a company using the newer Custom
  // Fields feature is accepted, silently discarded, and the PO disappears from
  // the invoice AND from the memo. A guess that loses data is worse than none.
  const slot = await customFieldId(
    realmId,
    'Customer Purchase Order #',
    process.env.QBO_CUSTOM_FIELD_ID_PO,
    fetchImpl,
  );

  const body: Record<string, unknown> & { Id: string; SyncToken: string } = {
    Id: inv.Id,
    SyncToken: inv.SyncToken,
    CustomerMemo: { value: memoWithPoNumber(inv.CustomerMemo?.value, poNumber) },
    ...(slot ? { CustomField: customFieldsWithPo(inv.CustomField, slot, poNumber) } : {}),
  };

  const written = await update<{ Invoice?: { Id: string; SyncToken: string; DocNumber?: string } }>(
    realmId,
    'invoice',
    body,
    fetchImpl,
  );
  const after = written.Invoice;
  if (!after) throw new Error('QuickBooks accepted the update but returned no invoice.');

  await prisma.qboTransaction.update({
    where: { id: txnId },
    data: {
      qboSyncToken: after.SyncToken,
      poPushedValue: poNumber,
      poPushedAt: new Date(),
      poNeedsPush: false,
    },
  });
  await prisma.integrationSyncLog.create({
    data: {
      provider: 'quickbooks',
      direction: 'OUTBOUND',
      entity: 'INVOICE_PO',
      entityId: txnId,
      externalId: after.Id,
      status: 'ok',
    },
  });
  await recordAudit({
    actorId: userId,
    action: 'qbo.invoice.po_pushed',
    entity: 'QboTransaction',
    entityId: txnId,
    details: { poNumber, slot, docNumber: after.DocNumber ?? txn.qboDocNumber },
  });
  logger.info({ txnId, poNumber, slot }, 'quickbooks: purchase order written to invoice');

  return {
    pushed: true,
    poNumber,
    docNumber: after.DocNumber ?? txn.qboDocNumber,
    wroteTo: slot ? 'custom field and memo' : 'memo only',
    slot,
  };
}

/**
 * Record the order's PO number and flag every live invoice that no longer agrees
 * with it.
 *
 * Writing to CustomerApproval.poNumber rather than a new column is deliberate:
 * that is the field the QuickBooks push, the monday board reconciliation and the
 * order paperwork already read. A second copy would immediately disagree with it.
 *
 * The approval record is created when the order is, so a missing one means the
 * order was locked by an older code path; the update refuses rather than
 * inventing an acceptance nobody made.
 */
export async function setOrderPoNumber(
  orderId: string,
  poNumber: string | null,
  userId: string,
): Promise<{ poNumber: string | null; invoicesNeedingPush: number }> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      number: true,
      proposalVersionId: true,
      customerApproval: { select: { id: true, poNumber: true } },
    },
  });
  if (!order) throw new NotFoundError('Order not found');
  if (!order.customerApproval) {
    throw new ConflictError(
      'This order has no customer-approval record, so there is nowhere to file the purchase order. Record the acceptance first.',
    );
  }

  const clean = (poNumber ?? '').trim().slice(0, 80) || null;
  if (clean === (order.customerApproval.poNumber ?? null)) {
    return { poNumber: clean, invoicesNeedingPush: 0 };
  }

  await prisma.customerApproval.update({
    where: { id: order.customerApproval.id },
    data: { poNumber: clean },
  });

  // Every live invoice for this order is flagged, not just the full one. A deposit
  // invoice is the first document a customer's accounts-payable team sees, so it is
  // the one most likely to be held up for want of a PO reference.
  const environment = qboEnvironment() as QboEnvironment;
  const live = await prisma.qboTransaction.findMany({
    where: {
      proposalVersionId: order.proposalVersionId,
      environment,
      status: 'CREATED',
      type: { not: 'ESTIMATE' },
    },
    select: { id: true, poPushedValue: true },
  });
  const stale = live.filter((t) => (t.poPushedValue ?? null) !== clean);
  if (stale.length) {
    await prisma.qboTransaction.updateMany({
      where: { id: { in: stale.map((t) => t.id) } },
      data: { poNeedsPush: Boolean(clean) },
    });
  }

  await recordAudit({
    actorId: userId,
    action: 'order.poNumber.set',
    entity: 'AcceptedOrder',
    entityId: orderId,
    details: {
      from: order.customerApproval.poNumber,
      to: clean,
      orderNumber: order.number,
      invoicesFlagged: clean ? stale.length : 0,
    },
  });

  return { poNumber: clean, invoicesNeedingPush: clean ? stale.length : 0 };
}
