import { prisma } from '../../lib/prisma.js';
import { env, qboEnvironment } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import { AppError, ConflictError, ForbiddenError, ValidationError } from '../../lib/errors.js';
import { create, readById } from './client.js';
import { findOrCreateCustomer } from './customers.js';
import { customFieldId } from './customFields.js';
import { resolveTermForProposal } from './terms.js';
import { syncTransactionState } from './billing.js';
import { formatMinor } from './mapping.js';
import {
  buildFreightInvoiceBody,
  buildInvoiceFreightAmendment,
  emptyFreightAmounts,
  freightTotal,
  supplementDocNumber,
  type FreightAmounts,
} from './freightInvoice.js';
import {
  BUCKETS,
  FREIGHT_BUCKETS,
  normalizeBucket,
  type FreightBucket,
} from '../../proposals/freightTrueUp.js';
import type { FreightEntry, QboEnvironment, QboTransaction } from '@prisma/client';

/**
 * Put applied freight onto the QuickBooks invoice that already exists.
 *
 * The awkward case this exists for: the customer signed without freight, the invoice
 * went out so manufacturing could start, and the vendor's freight quote turned up
 * afterwards. The freight is on the proposal by then (see freightTrueUpService.ts)
 * but QuickBooks — where the money actually lives — is still short by that amount.
 *
 * Which document gets it is decided by the invoice's own state, not by whoever is
 * clicking:
 *
 *   nothing paid  → the freight rows are appended to the invoice and its total rises.
 *                   One document per job, which is how SSG bills.
 *   part paid     → a separate freight-only invoice. An invoice with a payment applied
 *                   is a settled record in the ledger; raising its total makes the
 *                   customer's remittance stop matching anything.
 *
 * REPEATABLE, one batch at a time. Freight arrives from different vendors on
 * different clocks, so each batch is billed when it lands. Every entry reaches the
 * invoice exactly once: a pushed entry is refused, because correcting a figure a
 * customer has already been billed for is a credit and a rebill, not a second push
 * of the same row.
 *
 * Nothing here is automatic. `freightPushPreview` states the before and after totals
 * and the route requires them to be confirmed, because this is the one operation in
 * the application that changes what a customer owes after they have been told what
 * they owe.
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

/* ────────────────────────── the batch ────────────────────────── */

export interface FreightBatch {
  entries: FreightEntry[];
  amounts: FreightAmounts;
  references: Partial<Record<FreightBucket, string | null>>;
  descriptions: Partial<Record<FreightBucket, string | null>>;
  totalMinor: bigint;
}

/**
 * The freight waiting to be billed on a version.
 *
 * Applied but not pushed: the figure is on the proposal, so Summit has decided to
 * charge it, and it is not on the customer's invoice. That gap is the money this
 * whole feature exists to stop losing.
 */
export async function pushableEntries(versionId: string): Promise<FreightEntry[]> {
  return prisma.freightEntry.findMany({
    where: { versionId, status: 'APPLIED', amountMinor: { gt: 0 } },
    orderBy: { appliedAt: 'asc' },
  });
}

/**
 * Collapse the chosen entries into one row per bucket.
 *
 * Two therapeutic quotes in one batch become one therapeutic row carrying both quote
 * references — the customer's invoice should not grow a line per email Summit
 * received, and QuickBooks reporting reads the bucket, not the instalment.
 */
export async function buildBatch(
  versionId: string,
  entryIds?: string[] | null,
): Promise<FreightBatch> {
  const available = await pushableEntries(versionId);
  const wanted = entryIds && entryIds.length ? new Set(entryIds) : null;

  if (wanted) {
    const found = new Set(available.map((e) => e.id));
    const missing = [...wanted].filter((id) => !found.has(id));
    if (missing.length) {
      const rows = await prisma.freightEntry.findMany({ where: { id: { in: missing } } });
      const pushed = rows.find((r) => r.status === 'PUSHED');
      if (pushed) {
        throw new ConflictError(
          `${
            BUCKETS[normalizeBucket(pushed.bucket) ?? 'OTHER'].label
          } from ${pushed.qboPushedAt?.toISOString().slice(0, 10) ?? 'an earlier batch'} is already on invoice ${
            pushed.qboDocNumber ?? '—'
          }. To correct it, credit that invoice and bill the difference as a new amount — pushing it again would charge the customer twice.`,
        );
      }
      const staged = rows.find((r) => r.status === 'STAGED');
      if (staged) {
        throw new ConflictError(
          'That freight has not been applied to the proposal yet. Apply it first — the invoice must never say something the proposal does not.',
        );
      }
      throw new ValidationError('Some of the freight chosen is no longer available to bill.');
    }
  }

  const entries = wanted ? available.filter((e) => wanted.has(e.id)) : available;
  if (!entries.length) {
    throw new ValidationError(
      'There is no freight waiting to be billed on this job. Enter the vendor’s figures and apply them to the proposal first.',
    );
  }

  const amounts = emptyFreightAmounts();
  const references: Partial<Record<FreightBucket, string | null>> = {};
  const descriptions: Partial<Record<FreightBucket, string | null>> = {};
  for (const e of entries) {
    const bucket = normalizeBucket(e.bucket);
    if (!bucket) continue;
    amounts[bucket] += BigInt(e.amountMinor);
    const ref = (e.vendorQuoteRef ?? '').trim();
    if (ref) {
      const held = (references[bucket] ?? '').trim();
      references[bucket] = held ? `${held}, ${ref}` : ref;
    }
    const what = (e.description ?? '').trim();
    if (what) {
      const held = (descriptions[bucket] ?? '').trim();
      descriptions[bucket] = held ? `${held}; ${what}` : what;
    }
  }

  const totalMinor = freightTotal(amounts);
  if (totalMinor <= 0n)
    throw new ValidationError('There is no positive freight amount to add to the invoice');
  return { entries, amounts, references, descriptions, totalMinor };
}

/** The invoice this job's freight belongs on: the newest full invoice we created. */
async function invoiceForProposal(proposalId: string): Promise<QboTransaction> {
  const txn = await prisma.qboTransaction.findFirst({
    where: {
      proposalId,
      type: 'INVOICE',
      status: 'CREATED',
      qboId: { not: null },
      // A freight-only supplement is not the document the next batch of freight goes
      // on: appending to it would bury the second shipment inside the first
      // shipment's invoice.
      NOT: { totalsSnapshot: { path: ['kind'], equals: 'FREIGHT_SUPPLEMENT' } },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!txn) {
    throw new ValidationError(
      'There is no QuickBooks invoice for this job yet. The freight is already on the proposal, so raise the invoice as normal — it will include it.',
    );
  }
  return txn;
}

/* ────────────────────────── preview ────────────────────────── */

export interface FreightPushPreview {
  versionId: string;
  entryIds: string[];
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
  freight: Array<{
    bucket: FreightBucket;
    label: string;
    amountMinor: string;
    reference: string | null;
  }>;
  freightTotalMinor: string;
  /** What the customer will owe on the document being written. */
  newTotalMinor: string;
  supplementDocNumber: string | null;
  /** Freight-only invoices already raised on this job. */
  priorSupplements: number;
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
  versionId: string,
  entryIds: string[] | null,
  fetchImpl: typeof fetch = fetch,
): Promise<FreightPushPreview> {
  const batch = await buildBatch(versionId, entryIds);
  const version = await prisma.proposalVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { proposalId: true, version: true, proposal: { select: { number: true } } },
  });

  let txn = await invoiceForProposal(version.proposalId);
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
  const mode: 'AMEND' | 'SUPPLEMENT' = paid > 0n ? 'SUPPLEMENT' : 'AMEND';

  const priorSupplements = await prisma.qboTransaction.count({
    where: {
      proposalId: version.proposalId,
      type: 'INVOICE',
      status: 'CREATED',
      totalsSnapshot: { path: ['kind'], equals: 'FREIGHT_SUPPLEMENT' },
    },
  });

  if (mode === 'AMEND' && txn.sentAt) {
    warnings.push(
      `This invoice was already emailed to the customer on ${txn.sentAt
        .toISOString()
        .slice(0, 10)}. Amending it changes what they owe — re-send it afterwards.`,
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
  if (priorSupplements > 0) {
    warnings.push(
      `${priorSupplements} freight invoice${priorSupplements === 1 ? ' has' : 's have'} already been raised on this job. This is a further one — check the customer is not being billed twice for the same shipment.`,
    );
  }

  const freight = FREIGHT_BUCKETS.filter((b) => (batch.amounts[b] ?? 0n) > 0n).map((bucket) => ({
    bucket,
    label: BUCKETS[bucket].label,
    amountMinor: batch.amounts[bucket].toString(),
    reference: batch.references[bucket] ?? null,
  }));

  const next = mode === 'AMEND' ? current + batch.totalMinor : batch.totalMinor;
  return {
    versionId,
    entryIds: batch.entries.map((e) => e.id),
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
    freight,
    freightTotalMinor: batch.totalMinor.toString(),
    newTotalMinor: next.toString(),
    supplementDocNumber:
      mode === 'SUPPLEMENT'
        ? supplementDocNumber(version.proposal.number, priorSupplements + 1)
        : null,
    priorSupplements,
    warnings,
    currency: txn.currency,
    formatted: {
      current: formatMinor(current, txn.currency),
      freight: formatMinor(batch.totalMinor, txn.currency),
      next: formatMinor(next, txn.currency),
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

/* ────────────────────────── the push ────────────────────────── */

export interface FreightPushResult {
  mode: 'AMEND' | 'SUPPLEMENT';
  invoiceQboId: string;
  docNumber: string | null;
  previousTotalMinor: string;
  newTotalMinor: string;
  freightMinor: string;
  entryIds: string[];
  supplementTxnId: string | null;
  notifyError: string | null;
  /** Freight still applied to the proposal and not yet billed, after this push. */
  remainingUnbilledMinor: string;
}

/**
 * Do it. Requires the confirmed before/after totals from the preview: if the invoice
 * moved between the two calls — a payment landed, someone edited it in QuickBooks —
 * the numbers no longer match and nothing is sent.
 */
export async function pushFreightToQbo(
  versionId: string,
  entryIds: string[] | null,
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

  const preview = await freightPushPreview(versionId, entryIds, fetchImpl);
  if (
    preview.invoice.currentTotalMinor !== confirm.expectedCurrentTotalMinor ||
    preview.newTotalMinor !== confirm.expectedNewTotalMinor
  ) {
    throw new ConflictError(
      `The invoice changed while you were looking at it — it is now ${preview.formatted.current}, and adding this freight would make it ${preview.formatted.next}. Nothing has been sent. Review the new figures and confirm again.`,
    );
  }

  const batch = await buildBatch(versionId, preview.entryIds);
  const version = await prisma.proposalVersion.findUniqueOrThrow({
    where: { id: versionId },
    include: { proposal: true },
  });
  const txn = await prisma.qboTransaction.findUniqueOrThrow({
    where: { id: preview.invoice.txnId },
  });
  if (!txn.qboId) throw new ConflictError('That invoice has no QuickBooks id');

  const realmId = await activeRealmId(environment);
  // The batch's own idempotency key: a retry re-sends the same batch, a second batch
  // is a different document. Keyed on the entries so it cannot collide with the
  // first push on a job that has three.
  const batchKey = [...batch.entries.map((e) => e.id)].sort().join('.').slice(0, 120);
  const memoNote = `Freight added ${new Date().toISOString().slice(0, 10)}${
    Object.values(batch.references).filter(Boolean).length
      ? ` · vendor quote ${Object.values(batch.references).filter(Boolean).join(', ')}`
      : ''
  }`;
  const trueUpId = batch.entries[0]!.trueUpId;

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
        amounts: batch.amounts,
        references: batch.references,
        descriptions: batch.descriptions,
        expectedTotalMinor: BigInt(preview.newTotalMinor),
        currency: txn.currency,
        memoNote,
      });
      // QuickBooks updates are a POST to the same resource; the requestid keeps a
      // retry from appending the freight rows twice.
      const saved = await create<{
        Invoice: { Id: string; SyncToken: string; DocNumber?: string };
      }>(realmId, 'invoice', body, `qbo:freight:amend:${batchKey}`, fetchImpl);
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
      const docNo = preview.supplementDocNumber ?? supplementDocNumber(version.proposal.number, 1);
      const body = buildFreightInvoiceBody({
        customerQboId,
        currency: txn.currency,
        docNumber: docNo,
        billEmail,
        txnDate,
        dueDate: term.id ? null : txnDate,
        salesTermId: term.id,
        amounts: batch.amounts,
        references: batch.references,
        descriptions: batch.descriptions,
        memo: `Freight for accepted proposal ${version.proposal.number} v${version.version}, invoice ${
          txn.qboDocNumber ?? txn.qboId
        }`,
        projectId,
        projectFieldId,
      });
      const saved = await create<{
        Invoice: { Id: string; SyncToken: string; DocNumber?: string };
      }>(realmId, 'invoice', body, `qbo:freight:supplement:${batchKey}`, fetchImpl);
      const obj = saved.Invoice;
      invoiceQboId = obj.Id;
      docNumber = obj.DocNumber ?? docNo;

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
          proposalTotalMinor: batch.totalMinor,
          amountMinor: batch.totalMinor,
          totalsSnapshot: {
            kind: 'FREIGHT_SUPPLEMENT',
            trueUpId,
            entryIds: batch.entries.map((e) => e.id),
            followsTxnId: txn.id,
            followsDocNumber: txn.qboDocNumber,
            sequence: preview.priorSupplements + 1,
            buckets: FREIGHT_BUCKETS.filter((b) => batch.amounts[b] > 0n).map((b) => ({
              bucket: b,
              amountMinor: batch.amounts[b].toString(),
              reference: batch.references[b] ?? null,
            })),
          } as object,
          idempotencyKey: `qbo:${environment}:INVOICE:${version.id}:freight:${batchKey}`,
          customerQboId,
          qboId: obj.Id,
          qboSyncToken: obj.SyncToken,
          qboDocNumber: obj.DocNumber ?? docNo,
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

    const now = new Date();
    await prisma.freightEntry.updateMany({
      where: { id: { in: batch.entries.map((e) => e.id) } },
      data: {
        status: 'PUSHED',
        qboMode: preview.mode,
        qboTxnId: supplementTxnId ?? txn.id,
        qboDocNumber: docNumber,
        qboPushedAt: now,
        qboPushedById: userId,
      },
    });
    await prisma.freightTrueUp.update({
      where: { id: trueUpId },
      data: {
        qboMode: preview.mode,
        qboSourceTxnId: txn.id,
        qboSupplementTxnId: supplementTxnId,
        qboPreviousTotalMinor: BigInt(preview.invoice.currentTotalMinor),
        qboNewTotalMinor: BigInt(preview.newTotalMinor),
        qboPushedAt: now,
        qboPushedById: userId,
        qboError: null,
      },
    });

    const remaining = await pushableEntries(versionId);
    const remainingMinor = remaining.reduce((a, e) => a + BigInt(e.amountMinor), 0n);

    const notifyError = await notifyAccounting(
      `${version.proposal.number}: freight ${preview.formatted.freight} added — ${
        preview.mode === 'AMEND'
          ? `invoice now ${preview.formatted.next}`
          : `freight invoice ${docNumber ?? ''}`
      }`,
      [
        `Proposal ${version.proposal.number} v${version.version} — ${version.proposal.title}`,
        '',
        preview.mode === 'AMEND'
          ? `Invoice ${txn.qboDocNumber ?? invoiceQboId} was amended in QuickBooks.`
          : `Freight invoice ${docNumber ?? invoiceQboId} was raised (invoice ${
              txn.qboDocNumber ?? txn.qboId
            } had payments applied).`,
        `Was: ${preview.formatted.current}`,
        `Freight added: ${preview.formatted.freight}`,
        `Now: ${preview.formatted.next}`,
        '',
        ...preview.freight.map(
          (f) =>
            `  ${f.label}: ${formatMinor(BigInt(f.amountMinor), txn.currency)}${
              f.reference ? ` (vendor quote ${f.reference})` : ''
            }`,
        ),
        remainingMinor > 0n
          ? `\nStill to bill on this job: ${formatMinor(remainingMinor, txn.currency)} of applied freight.`
          : '',
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
        versionId,
        entryIds: batch.entries.map((e) => e.id),
        invoiceTxnId: txn.id,
        invoiceQboId,
        docNumber,
        supplementTxnId,
        sequence: preview.priorSupplements + 1,
        previousTotalMinor: preview.invoice.currentTotalMinor,
        newTotalMinor: preview.newTotalMinor,
        freightMinor: preview.freightTotalMinor,
        remainingUnbilledMinor: remainingMinor.toString(),
        notifyError,
      },
    });
    logger.info(
      {
        versionId,
        trueUpId,
        mode: preview.mode,
        invoiceQboId,
        freightMinor: preview.freightTotalMinor,
      },
      'freight pushed to QuickBooks',
    );

    return {
      mode: preview.mode,
      invoiceQboId,
      docNumber,
      previousTotalMinor: preview.invoice.currentTotalMinor,
      newTotalMinor: preview.newTotalMinor,
      freightMinor: preview.freightTotalMinor,
      entryIds: batch.entries.map((e) => e.id),
      supplementTxnId,
      notifyError,
      remainingUnbilledMinor: remainingMinor.toString(),
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
      details: { error: message, mode: preview.mode, versionId, entryIds: preview.entryIds },
    });
    logger.error({ err, versionId, trueUpId }, 'freight push to QuickBooks failed');
    if (err instanceof AppError) throw err;
    throw new AppError(
      'QuickBooks did not accept the freight update',
      502,
      'QBO_FREIGHT_PUSH_FAILED',
    );
  }
}
