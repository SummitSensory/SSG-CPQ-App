import { prisma } from '../../lib/prisma.js';
import { env, qboEnvironment } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../lib/errors.js';
import { create, readById } from './client.js';
import { findOrCreateCustomer } from './customers.js';
import { customFieldId } from './customFields.js';
import { resolveTermForProposal } from './terms.js';
import { syncTransactionState } from './billing.js';
import { formatMinor } from './mapping.js';
import {
  buildFreightInvoiceBody,
  buildInvoiceFreightAmendment,
  freightTotal,
  type FreightAmounts,
} from './freightInvoice.js';
import type { QboEnvironment, QboTransaction } from '@prisma/client';

/**
 * Push an applied freight true-up onto the QuickBooks invoice that already exists.
 *
 * The awkward case this exists for: the customer signed without freight, the
 * invoice went out so manufacturing could start, and the vendor's freight quote
 * turned up afterwards. The freight is on the proposal by then (see
 * proposals/freightTrueUpService.ts) but QuickBooks — where the money actually
 * lives — is still short by that amount.
 *
 * Which document gets it is decided by the invoice's own state, not by whoever is
 * clicking:
 *
 *   nothing paid  → the freight rows are appended to the invoice and its total
 *                   rises. One document per job, which is how SSG bills.
 *   part paid     → a separate freight-only invoice. An invoice with a payment
 *                   applied is a settled record in the ledger; raising its total
 *                   makes the customer's remittance stop matching anything.
 *
 * Nothing here is automatic. `freightPushPreview` states the before and after
 * totals and the route requires them to be confirmed, because this is the one
 * operation in the application that changes what a customer owes after they have
 * been told what they owe.
 */

const RESEND_URL = 'https://api.resend.com/emails';

async function activeRealmId(environment: QboEnvironment): Promise<string> {
  const conn = await prisma.qboConnection.findFirst({ where: { environment, isActive: true } });
  if (!conn) throw new ConflictError(`No active QuickBooks connection for ${environment}`);
  return conn.realmId;
}

function big(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.round(v));
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

/**
 * The freight that was actually added, per class, read from the two price
 * snapshots the true-up recorded.
 *
 * Diffed from the snapshots rather than taken from the entered figures: the
 * snapshot pair IS the record of what changed on the proposal, so the invoice can
 * never be given a different number from the document. A mismatch against the
 * true-up's own before/after totals aborts the push.
 */
export async function freightDelta(trueUpId: string): Promise<FreightAmounts> {
  const row = await prisma.freightTrueUp.findUnique({ where: { id: trueUpId } });
  if (!row) throw new NotFoundError('Freight entry not found');
  if (row.status !== 'APPLIED')
    throw new ConflictError('Apply the freight to the proposal before sending it to QuickBooks');

  const ids = [row.previousSnapshotId, row.newSnapshotId].filter(Boolean) as string[];
  const snaps = await prisma.priceSnapshot.findMany({
    where: { id: { in: ids } },
    select: { id: true, breakdown: true },
  });
  const byId = new Map(snaps.map((s) => [s.id, (s.breakdown ?? {}) as Record<string, unknown>]));
  const after = row.newSnapshotId ? byId.get(row.newSnapshotId) : undefined;
  if (!after)
    throw new ConflictError('The amended price snapshot is missing — nothing can be pushed');
  const before = row.previousSnapshotId ? (byId.get(row.previousSnapshotId) ?? {}) : {};

  const delta = (key: string): bigint => big(after[key] ?? 0) - big(before[key] ?? 0);
  const amounts: FreightAmounts = {
    thirdPartyMinor: delta('thirdPartyFreightMinor'),
    structureMinor: delta('structureFreightMinor'),
    standardMinor: delta('stdFreightMinor'),
  };

  const expected = big(row.newTotalMinor) - big(row.previousTotalMinor);
  if (freightTotal(amounts) !== expected) {
    throw new ConflictError(
      `The freight recorded on the proposal (${expected}) does not match the freight classes on its price snapshot (${freightTotal(
        amounts,
      )}). Nothing has been sent to QuickBooks.`,
    );
  }
  if (freightTotal(amounts) <= 0n)
    throw new ValidationError('There is no positive freight amount to add to the invoice');
  return amounts;
}

/** The invoice this job's freight belongs on: the newest full invoice we created. */
async function invoiceForProposal(proposalId: string): Promise<QboTransaction> {
  const txn = await prisma.qboTransaction.findFirst({
    where: { proposalId, type: 'INVOICE', status: 'CREATED', qboId: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  if (!txn) {
    throw new ValidationError(
      'There is no QuickBooks invoice for this job yet. The freight is already on the proposal, so raise the invoice as normal — it will include it.',
    );
  }
  return txn;
}

export interface FreightPushPreview {
  trueUpId: string;
  mode: 'AMEND' | 'SUPPLEMENT';
  reason: string;
  invoice: {
    txnId: string;
    qboId: string | null;
    docNumber: string | null;
    currentTotalMinor: string;
    paidMinor: string;
    balanceMinor: string;
    qboStatus: string | null;
    sentAt: string | null;
  };
  freight: {
    thirdPartyMinor: string;
    structureMinor: string;
    standardMinor: string;
    totalMinor: string;
  };
  /** What the customer will owe after the push. */
  newTotalMinor: string;
  supplementDocNumber: string | null;
  warnings: string[];
  currency: string;
  formatted: { current: string; freight: string; next: string };
}

/**
 * Before / after, read from QuickBooks rather than from our own record.
 *
 * The invoice is refreshed from QuickBooks first: whether it has been paid is the
 * fact the whole decision turns on, and our copy of it is only as fresh as the last
 * sync.
 */
export async function freightPushPreview(
  trueUpId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FreightPushPreview> {
  const row = await prisma.freightTrueUp.findUniqueOrThrow({ where: { id: trueUpId } });
  const amounts = await freightDelta(trueUpId);
  const proposal = await prisma.proposal.findUniqueOrThrow({
    where: { id: row.proposalId },
    select: { number: true },
  });

  let txn = await invoiceForProposal(row.proposalId);
  const warnings: string[] = [];
  try {
    await syncTransactionState(txn.id, fetchImpl);
    txn = await prisma.qboTransaction.findUniqueOrThrow({ where: { id: txn.id } });
  } catch (e) {
    warnings.push(
      `QuickBooks could not be read just now (${
        e instanceof Error ? e.message : 'unknown error'
      }), so payment state may be stale.`,
    );
  }

  const paid = big(txn.paidMinor ?? 0);
  const current = big(txn.qboTotalMinor ?? txn.amountMinor);
  const freight = freightTotal(amounts);
  const mode: 'AMEND' | 'SUPPLEMENT' = paid > 0n ? 'SUPPLEMENT' : 'AMEND';

  if (mode === 'AMEND' && txn.sentAt) {
    warnings.push(
      `This invoice was already emailed to the customer on ${txn.sentAt.toISOString().slice(0, 10)}. Amending it changes what they owe — re-send it afterwards.`,
    );
  }
  if (current !== big(txn.amountMinor)) {
    warnings.push(
      `QuickBooks holds this invoice at ${formatMinor(current, txn.currency)} but we recorded ${formatMinor(
        big(txn.amountMinor),
        txn.currency,
      )} — it has been edited in QuickBooks.`,
    );
  }
  if (row.qboPushedAt) warnings.push('This freight has already been pushed once.');

  return {
    trueUpId,
    mode,
    reason:
      mode === 'AMEND'
        ? 'No payment has been applied, so the freight goes onto the existing invoice.'
        : `${formatMinor(paid, txn.currency)} has been paid against this invoice, so the freight is raised as a separate freight-only invoice.`,
    invoice: {
      txnId: txn.id,
      qboId: txn.qboId,
      docNumber: txn.qboDocNumber,
      currentTotalMinor: current.toString(),
      paidMinor: paid.toString(),
      balanceMinor: big(txn.balanceMinor ?? 0).toString(),
      qboStatus: txn.qboStatus,
      sentAt: txn.sentAt ? txn.sentAt.toISOString() : null,
    },
    freight: {
      thirdPartyMinor: amounts.thirdPartyMinor.toString(),
      structureMinor: amounts.structureMinor.toString(),
      standardMinor: amounts.standardMinor.toString(),
      totalMinor: freight.toString(),
    },
    newTotalMinor: (mode === 'AMEND' ? current + freight : freight).toString(),
    supplementDocNumber: mode === 'SUPPLEMENT' ? `${proposal.number}-FRT` : null,
    warnings,
    currency: txn.currency,
    formatted: {
      current: formatMinor(current, txn.currency),
      freight: formatMinor(freight, txn.currency),
      next: formatMinor(mode === 'AMEND' ? current + freight : freight, txn.currency),
    },
  };
}

/**
 * Tell accounting the total moved.
 *
 * Never fatal: the invoice has already changed in QuickBooks by this point, and
 * failing the request because an email did not send would invite a retry against a
 * document that has already been amended. A failure is logged and audited instead.
 */
async function notifyAccounting(subject: string, body: string): Promise<string | null> {
  const to = (process.env.ACCOUNTING_NOTIFY_EMAIL ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  if (!to.length) return 'ACCOUNTING_NOTIFY_EMAIL is not set — nobody was emailed.';
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
        to,
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

export interface FreightPushResult {
  mode: 'AMEND' | 'SUPPLEMENT';
  invoiceQboId: string;
  docNumber: string | null;
  previousTotalMinor: string;
  newTotalMinor: string;
  freightMinor: string;
  supplementTxnId: string | null;
  notifyError: string | null;
}

/**
 * Do it. Requires the confirmed before/after totals from the preview: if the
 * invoice moved between the two calls — a payment landed, someone edited it in
 * QuickBooks — the numbers no longer match and nothing is sent.
 */
export async function pushFreightToQbo(
  trueUpId: string,
  userId: string,
  confirm: { expectedCurrentTotalMinor: string; expectedNewTotalMinor: string },
  fetchImpl: typeof fetch = fetch,
): Promise<FreightPushResult> {
  const environment = qboEnvironment() as QboEnvironment;
  if (environment === 'PRODUCTION' && !env.QBO_PRODUCTION_WRITE_ENABLED) {
    throw new ForbiddenError(
      'Production QuickBooks writes are disabled. Set QBO_PRODUCTION_WRITE_ENABLED=true once the production test plan is authorized.',
    );
  }

  const preview = await freightPushPreview(trueUpId, fetchImpl);
  if (
    preview.invoice.currentTotalMinor !== confirm.expectedCurrentTotalMinor ||
    preview.newTotalMinor !== confirm.expectedNewTotalMinor
  ) {
    throw new ConflictError(
      `The invoice changed while you were looking at it — it is now ${preview.formatted.current}, and adding freight would make it ${preview.formatted.next}. Nothing has been sent. Review the new figures and confirm again.`,
    );
  }

  const row = await prisma.freightTrueUp.findUniqueOrThrow({ where: { id: trueUpId } });
  const amounts = await freightDelta(trueUpId);
  const version = await prisma.proposalVersion.findUniqueOrThrow({
    where: { id: row.versionId },
    include: { proposal: true },
  });
  const txn = await prisma.qboTransaction.findUniqueOrThrow({
    where: { id: preview.invoice.txnId },
  });
  if (!txn.qboId) throw new ConflictError('That invoice has no QuickBooks id');

  const realmId = await activeRealmId(environment);
  const reference = row.vendorQuoteRef ?? null;
  const memoNote = `Freight added ${new Date().toISOString().slice(0, 10)}${
    reference ? ` · vendor quote ${reference}` : ''
  }`;

  try {
    let invoiceQboId: string;
    let docNumber: string | null;
    let supplementTxnId: string | null = null;

    if (preview.mode === 'AMEND') {
      const read = await readById<{
        Invoice: {
          Id: string;
          SyncToken: string;
          Line?: Array<Record<string, unknown>>;
          CustomerMemo?: { value?: string };
        };
      }>(realmId, 'invoice', txn.qboId, fetchImpl);
      const invoice = read.Invoice;
      if (!invoice) throw new AppError('QuickBooks returned no invoice', 502, 'QBO_READ_FAILED');

      const body = buildInvoiceFreightAmendment({
        invoice,
        amounts,
        reference,
        expectedTotalMinor: BigInt(preview.newTotalMinor),
        currency: txn.currency,
        memoNote,
      });
      // QuickBooks updates are a POST to the same resource; the requestid keeps a
      // retry from appending the freight rows twice.
      const saved = await create<{
        Invoice: { Id: string; SyncToken: string; DocNumber?: string };
      }>(realmId, 'invoice', body, `qbo:freight:amend:${trueUpId}`, fetchImpl);
      const obj = saved.Invoice;
      invoiceQboId = obj.Id;
      docNumber = obj.DocNumber ?? txn.qboDocNumber;
      await prisma.qboTransaction.update({
        where: { id: txn.id },
        data: {
          qboSyncToken: obj.SyncToken,
          qboTotalMinor: BigInt(preview.newTotalMinor),
          amountMinor: BigInt(preview.newTotalMinor),
          proposalTotalMinor: BigInt(preview.newTotalMinor),
        },
      });
    } else {
      const { qboId: customerQboId, email: billEmail } = await findOrCreateCustomer(
        version.proposal.organizationId,
        realmId,
        userId,
        fetchImpl,
      );
      const projectId = String(
        (Array.isArray(version.sections)
          ? (version.sections as Array<{ id?: string; data?: { projectId?: unknown } }>).find(
              (s) => s?.id === 'meta',
            )?.data?.projectId
          : '') ?? '',
      ).trim();
      const projectFieldId = projectId
        ? await customFieldId(
            realmId,
            'Project ID',
            process.env.QBO_CUSTOM_FIELD_ID_PROJECT,
            fetchImpl,
          )
        : null;
      const term = await resolveTermForProposal(version.proposalId);
      const txnDate = new Date().toISOString().slice(0, 10);
      const body = buildFreightInvoiceBody({
        customerQboId,
        currency: txn.currency,
        docNumber: `${version.proposal.number}-FRT`,
        billEmail,
        txnDate,
        dueDate: term.id ? null : txnDate,
        salesTermId: term.id,
        amounts,
        reference,
        memo: `Freight for accepted proposal ${version.proposal.number} v${version.version}, invoice ${
          txn.qboDocNumber ?? txn.qboId
        }`,
        projectId,
        projectFieldId,
      });
      const saved = await create<{
        Invoice: { Id: string; SyncToken: string; DocNumber?: string };
      }>(realmId, 'invoice', body, `qbo:freight:supplement:${trueUpId}`, fetchImpl);
      const obj = saved.Invoice;
      invoiceQboId = obj.Id;
      docNumber = obj.DocNumber ?? null;

      // Recorded as an ordinary invoice transaction so it appears in this job's
      // billing list, syncs its own payments, and can be emailed from here like any
      // other. Written directly rather than through prepare/execute: those build a
      // document from the accepted totals, and this one bills a slice of them.
      const supplement = await prisma.qboTransaction.create({
        data: {
          type: 'INVOICE',
          environment,
          status: 'CREATED',
          proposalId: version.proposalId,
          proposalVersionId: version.id,
          proposalVersion: version.version,
          currency: txn.currency,
          proposalTotalMinor: big(row.newTotalMinor),
          amountMinor: freightTotal(amounts),
          totalsSnapshot: {
            kind: 'FREIGHT_SUPPLEMENT',
            trueUpId,
            followsTxnId: txn.id,
            followsDocNumber: txn.qboDocNumber,
            thirdPartyMinor: amounts.thirdPartyMinor.toString(),
            structureMinor: amounts.structureMinor.toString(),
            standardMinor: amounts.standardMinor.toString(),
            vendorQuoteRef: reference,
          } as object,
          idempotencyKey: `qbo:${environment}:INVOICE:${version.id}:freight:${trueUpId}`,
          customerQboId,
          qboId: obj.Id,
          qboSyncToken: obj.SyncToken,
          qboDocNumber: obj.DocNumber ?? null,
          initiatedById: userId,
          authorizedById: userId,
          authorizedAt: new Date(),
        },
      });
      supplementTxnId = supplement.id;
      await prisma.integrationSyncLog.create({
        data: {
          provider: 'quickbooks',
          direction: 'OUTBOUND',
          entity: 'INVOICE',
          entityId: supplement.id,
          externalId: obj.Id,
          status: 'ok',
        },
      });
    }

    await prisma.freightTrueUp.update({
      where: { id: trueUpId },
      data: {
        qboMode: preview.mode,
        qboSourceTxnId: txn.id,
        qboSupplementTxnId: supplementTxnId,
        qboPreviousTotalMinor: BigInt(preview.invoice.currentTotalMinor),
        qboNewTotalMinor: BigInt(preview.newTotalMinor),
        qboPushedAt: new Date(),
        qboPushedById: userId,
        qboError: null,
      },
    });

    const notifyError = await notifyAccounting(
      `${version.proposal.number}: freight ${preview.formatted.freight} added — invoice now ${preview.formatted.next}`,
      [
        `Proposal ${version.proposal.number} v${version.version} — ${version.proposal.title}`,
        '',
        preview.mode === 'AMEND'
          ? `Invoice ${txn.qboDocNumber ?? invoiceQboId} was amended in QuickBooks.`
          : `A freight-only invoice ${docNumber ?? invoiceQboId} was raised (invoice ${
              txn.qboDocNumber ?? txn.qboId
            } had payments applied).`,
        `Was: ${preview.formatted.current}`,
        `Freight added: ${preview.formatted.freight}`,
        `Now: ${preview.formatted.next}`,
        reference ? `Vendor quote: ${reference}` : '',
        row.vendorName ? `Vendor: ${row.vendorName}` : '',
        '',
        `Pushed by user ${userId} from the CPQ application.`,
      ]
        .filter(Boolean)
        .join('\n'),
    );

    await recordAudit({
      actorId: userId,
      action: 'freight.trueup.qbo_push',
      entity: 'FreightTrueUp',
      entityId: trueUpId,
      details: {
        mode: preview.mode,
        environment,
        invoiceTxnId: txn.id,
        invoiceQboId,
        docNumber,
        supplementTxnId,
        previousTotalMinor: preview.invoice.currentTotalMinor,
        newTotalMinor: preview.newTotalMinor,
        freightMinor: preview.freight.totalMinor,
        vendorQuoteRef: reference,
        notifyError,
      },
    });
    logger.info(
      { trueUpId, mode: preview.mode, invoiceQboId, freightMinor: preview.freight.totalMinor },
      'freight pushed to QuickBooks',
    );

    return {
      mode: preview.mode,
      invoiceQboId,
      docNumber,
      previousTotalMinor: preview.invoice.currentTotalMinor,
      newTotalMinor: preview.newTotalMinor,
      freightMinor: preview.freight.totalMinor,
      supplementTxnId,
      notifyError,
    };
  } catch (err) {
    const message = err instanceof AppError ? err.message : String(err);
    await prisma.freightTrueUp.update({ where: { id: trueUpId }, data: { qboError: message } });
    await prisma.integrationSyncLog.create({
      data: {
        provider: 'quickbooks',
        direction: 'OUTBOUND',
        entity: 'INVOICE',
        entityId: trueUpId,
        status: 'error',
        error: message,
      },
    });
    await recordAudit({
      actorId: userId,
      action: 'freight.trueup.qbo_push_failed',
      entity: 'FreightTrueUp',
      entityId: trueUpId,
      details: { error: message, mode: preview.mode },
    });
    logger.error({ err, trueUpId }, 'freight push to QuickBooks failed');
    if (err instanceof AppError) throw err;
    throw new AppError(
      'QuickBooks did not accept the freight update',
      502,
      'QBO_FREIGHT_PUSH_FAILED',
    );
  }
}
