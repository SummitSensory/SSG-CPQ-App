import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { env, qboEnvironment } from '../../config/env.js';
import { create } from './client.js';
import { findOrCreateCustomer } from './customers.js';
import { buildEstimateBody } from './estimates.js';
import { buildInvoiceBody } from './invoices.js';
import { TXN_LABEL, type AcceptedLine } from './mapping.js';
import { findLink } from './links.js';
import type { QboTxnType, QboTxnStatus, QboEnvironment, Prisma } from '@prisma/client';

/**
 * Financial-transaction safety core. Every live QuickBooks document is:
 *   1. PREPARED   — totals frozen from the ACCEPTED proposal + idempotency key.
 *   2. AUTHORIZED — an explicit, logged user sign-off (no auto-posting).
 *   3. EXECUTED   — created in QuickBooks with the idempotency key as the QBO
 *                   requestid, so a retry can never double-create.
 * Accepted totals are re-verified at execute time and never silently altered.
 */

/** Accept number | string | bigint from JSON snapshots without float drift. */
function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.round(v));
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  throw new ValidationError(`Cannot read integer minor-unit value from ${JSON.stringify(v)}`);
}

interface AcceptedTotals {
  currency: string;
  grandTotalMinor: bigint;
  deposit: bigint;
  progress: bigint;
  final: bigint;
  priceSnapshotId: string;
  engineVersion: string;
  lines: AcceptedLine[];
  fees: Array<{ label: string; amountMinor: bigint }>;
  orderDiscountMinor: bigint;
  taxMinor: bigint;
}

/** Read + freeze the accepted proposal totals. Throws unless the version is ACCEPTED. */
async function loadAcceptedTotals(proposalVersionId: string): Promise<AcceptedTotals> {
  const version = await prisma.proposalVersion.findUnique({ where: { id: proposalVersionId } });
  if (!version) throw new NotFoundError('Proposal version not found');
  if (version.status !== 'ACCEPTED') throw new ConflictError('Only an ACCEPTED proposal version may be sent to QuickBooks');
  if (!version.priceSnapshotId) throw new ConflictError('Accepted version has no price snapshot');

  const snap = await prisma.priceSnapshot.findUnique({ where: { id: version.priceSnapshotId } });
  if (!snap) throw new NotFoundError('Price snapshot not found');
  const b = snap.breakdown as Record<string, unknown>;
  const payment = (b.payment ?? {}) as Record<string, unknown>;

  const items = (version.items as unknown as Array<{ ref: string; productId: string; name: string; quantity: number }>) ?? [];
  const byRef = new Map(items.map((i) => [i.ref, i]));
  const breakdownLines = (b.lines as Array<{ ref: string; net: unknown }>) ?? [];

  const lines: AcceptedLine[] = [];
  for (const bl of breakdownLines) {
    if (bl.net == null) continue;
    const item = byRef.get(bl.ref);
    const link = item ? await findLink({ entity: 'Item', entityId: item.productId }) : null;
    lines.push({
      description: item?.name ?? bl.ref,
      qboItemId: link?.qboId ?? null,
      quantity: item?.quantity ?? 1,
      amountMinor: toBig(bl.net),
    });
  }

  const fees: Array<{ label: string; amountMinor: bigint }> = [];
  for (const [key, val] of Object.entries((b.fees ?? {}) as Record<string, { amount: unknown }>)) {
    fees.push({ label: key, amountMinor: toBig(val.amount) });
  }

  return {
    currency: snap.currency,
    grandTotalMinor: snap.grandTotal,
    deposit: toBig(payment.deposit ?? 0),
    progress: toBig(payment.progress ?? 0),
    final: toBig(payment.final ?? snap.grandTotal),
    priceSnapshotId: snap.id,
    engineVersion: snap.engineVersion,
    lines,
    fees,
    orderDiscountMinor: toBig(b.orderDiscount ?? 0),
    taxMinor: toBig(b.tax ?? 0),
  };
}

function amountForType(type: QboTxnType, t: AcceptedTotals): bigint {
  switch (type) {
    case 'ESTIMATE': return t.grandTotalMinor;
    case 'DEPOSIT_INVOICE': return t.deposit;
    case 'PROGRESS_INVOICE': return t.progress;
    case 'FINAL_INVOICE': return t.final;
  }
}

function idempotencyKey(environment: QboEnvironment, type: QboTxnType, proposalVersionId: string, seq: number): string {
  return `qbo:${environment}:${type}:${proposalVersionId}:${seq}`;
}

/** Stable hash of the frozen totals — lets execute detect any drift. */
function totalsHash(t: AcceptedTotals): string {
  return createHash('sha256')
    .update(JSON.stringify({ g: t.grandTotalMinor.toString(), d: t.deposit.toString(), p: t.progress.toString(), f: t.final.toString(), c: t.currency, s: t.priceSnapshotId }))
    .digest('hex');
}

export interface PrepareInput {
  proposalVersionId: string;
  type: QboTxnType;
  sequence?: number;
}

/**
 * Step 1 — prepare. Idempotent: the unique idempotency key means calling this
 * twice for the same (version, type, sequence) returns the SAME row rather than
 * creating a duplicate. Totals are frozen into the row here.
 */
export async function prepareTransaction(input: PrepareInput, userId: string) {
  const environment = qboEnvironment() as QboEnvironment;
  const seq = input.sequence ?? 1;
  const key = idempotencyKey(environment, input.type, input.proposalVersionId, seq);

  const existing = await prisma.qboTransaction.findUnique({ where: { idempotencyKey: key } });
  if (existing) return existing;

  const totals = await loadAcceptedTotals(input.proposalVersionId);
  const amount = amountForType(input.type, totals);
  if (amount <= 0n && input.type !== 'ESTIMATE') {
    throw new ValidationError(`${TXN_LABEL[input.type]} amount is zero in the accepted payment schedule`);
  }
  const version = await prisma.proposalVersion.findUniqueOrThrow({ where: { id: input.proposalVersionId } });

  const txn = await prisma.qboTransaction.create({
    data: {
      type: input.type,
      environment,
      status: 'PENDING_AUTHORIZATION',
      proposalId: version.proposalId,
      proposalVersionId: version.id,
      proposalVersion: version.version,
      currency: totals.currency,
      proposalTotalMinor: totals.grandTotalMinor,
      amountMinor: amount,
      totalsSnapshot: {
        hash: totalsHash(totals),
        currency: totals.currency,
        grandTotalMinor: totals.grandTotalMinor.toString(),
        deposit: totals.deposit.toString(),
        progress: totals.progress.toString(),
        final: totals.final.toString(),
        priceSnapshotId: totals.priceSnapshotId,
        engineVersion: totals.engineVersion,
      } as Prisma.InputJsonValue,
      idempotencyKey: key,
      initiatedById: userId,
    },
  });
  await recordAudit({ actorId: userId, action: 'qbo.txn.prepare', entity: 'QboTransaction', entityId: txn.id, details: { type: input.type, environment, amountMinor: amount.toString() } });
  return txn;
}

/** Step 2 — explicit user authorization. Required before any live create. */
export async function authorizeTransaction(txnId: string, userId: string) {
  const txn = await prisma.qboTransaction.findUnique({ where: { id: txnId } });
  if (!txn) throw new NotFoundError('Transaction not found');
  if (txn.status !== 'PENDING_AUTHORIZATION') throw new ConflictError(`Cannot authorize a ${txn.status} transaction`);
  const updated = await prisma.qboTransaction.update({
    where: { id: txnId },
    data: { status: 'AUTHORIZED', authorizedById: userId, authorizedAt: new Date() },
  });
  await recordAudit({ actorId: userId, action: 'qbo.txn.authorize', entity: 'QboTransaction', entityId: txnId, details: { type: txn.type, environment: txn.environment } });
  return updated;
}

async function activeRealmId(environment: QboEnvironment): Promise<string> {
  const conn = await prisma.qboConnection.findFirst({ where: { environment, isActive: true } });
  if (!conn) throw new ConflictError(`No active QuickBooks connection for ${environment}`);
  return conn.realmId;
}

/**
 * Step 3 — execute. Requires AUTHORIZED. Re-verifies the accepted totals have
 * not changed, enforces the production write gate, then creates the document in
 * QuickBooks using the idempotency key as the QBO requestid. Already-CREATED
 * transactions short-circuit (never double-create).
 */
export async function executeTransaction(txnId: string, userId: string, fetchImpl: typeof fetch = fetch) {
  const txn = await prisma.qboTransaction.findUnique({ where: { id: txnId } });
  if (!txn) throw new NotFoundError('Transaction not found');
  if (txn.status === 'CREATED') return txn; // idempotent: already exists in QuickBooks
  if (txn.status !== 'AUTHORIZED') throw new ForbiddenError('Transaction must be explicitly AUTHORIZED before it is created in QuickBooks');

  // Hard production safety gate.
  if (txn.environment === 'PRODUCTION' && !env.QBO_PRODUCTION_WRITE_ENABLED) {
    throw new ForbiddenError('Production QuickBooks writes are disabled. Complete and authorize the production test plan, then set QBO_PRODUCTION_WRITE_ENABLED=true.');
  }

  // Re-verify accepted totals are unchanged since prepare — never silently alter.
  const totals = await loadAcceptedTotals(txn.proposalVersionId);
  const frozen = txn.totalsSnapshot as { hash: string };
  if (totalsHash(totals) !== frozen.hash || amountForType(txn.type, totals) !== txn.amountMinor) {
    throw new ConflictError('Accepted proposal totals changed since this transaction was prepared — refusing to create. Re-prepare from the current accepted version.');
  }

  const realmId = await activeRealmId(txn.environment);

  try {
    // Ensure the customer exists (find-or-create is itself duplicate-safe).
    const version = await prisma.proposalVersion.findUniqueOrThrow({ where: { id: txn.proposalVersionId }, include: { proposal: true } });
    const { qboId: customerQboId } = await findOrCreateCustomer(version.proposal.organizationId, realmId, userId, fetchImpl);

    const memo = `Per accepted proposal ${version.proposal.number} v${txn.proposalVersion}`;
    let resource: string;
    let body: Record<string, unknown>;
    if (txn.type === 'ESTIMATE') {
      resource = 'estimate';
      body = buildEstimateBody({
        customerQboId, currency: totals.currency, memo,
        lines: totals.lines, fees: totals.fees,
        orderDiscountMinor: totals.orderDiscountMinor, taxMinor: totals.taxMinor,
        expectedTotalMinor: totals.grandTotalMinor,
      });
    } else {
      resource = 'invoice';
      body = buildInvoiceBody({
        customerQboId, currency: totals.currency, amountMinor: txn.amountMinor,
        description: `${TXN_LABEL[txn.type]} — ${memo}`, memo,
      });
    }

    // requestid = idempotencyKey: QuickBooks returns the original on any retry.
    const created = await create<Record<string, { Id: string; SyncToken: string; DocNumber?: string }>>(
      realmId, resource, body, txn.idempotencyKey, fetchImpl,
    );
    const obj = created[txn.type === 'ESTIMATE' ? 'Estimate' : 'Invoice'];

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.qboTransaction.update({
        where: { id: txnId },
        data: { status: 'CREATED', qboId: obj.Id, qboSyncToken: obj.SyncToken, qboDocNumber: obj.DocNumber ?? null, customerQboId, error: null },
      });
      await tx.integrationSyncLog.create({
        data: { provider: 'quickbooks', direction: 'OUTBOUND', entity: txn.type, entityId: txnId, externalId: obj.Id, status: 'ok' },
      });
      return u;
    });
    await recordAudit({ actorId: userId, action: 'qbo.txn.create', entity: 'QboTransaction', entityId: txnId, details: { type: txn.type, environment: txn.environment, qboId: obj.Id, docNumber: obj.DocNumber } });
    logger.info({ txnId, qboId: obj.Id, type: txn.type }, 'QuickBooks transaction created');
    return updated;
  } catch (err) {
    const message = err instanceof AppError ? err.message : String(err);
    await prisma.qboTransaction.update({ where: { id: txnId }, data: { status: 'FAILED', error: message } });
    await prisma.integrationSyncLog.create({
      data: { provider: 'quickbooks', direction: 'OUTBOUND', entity: txn.type, entityId: txnId, status: 'error', error: message },
    });
    logger.error({ err, txnId }, 'QuickBooks transaction failed');
    if (err instanceof AppError) throw err;
    throw new AppError('QuickBooks transaction failed', 502, 'QBO_CREATE_FAILED');
  }
}

/**
 * Manual retry of a FAILED transaction. Re-runs execute with the SAME
 * idempotency key, so if QuickBooks actually created the document on the failed
 * attempt it is returned (not duplicated).
 */
export async function retryTransaction(txnId: string, userId: string, fetchImpl: typeof fetch = fetch) {
  const txn = await prisma.qboTransaction.findUnique({ where: { id: txnId } });
  if (!txn) throw new NotFoundError('Transaction not found');
  if (txn.status !== 'FAILED') throw new ConflictError(`Only FAILED transactions can be retried (status is ${txn.status})`);
  // Return to AUTHORIZED so execute's guard passes; authorization already granted.
  await prisma.qboTransaction.update({ where: { id: txnId }, data: { status: 'AUTHORIZED' } });
  await recordAudit({ actorId: userId, action: 'qbo.txn.retry', entity: 'QboTransaction', entityId: txnId });
  return executeTransaction(txnId, userId, fetchImpl);
}

export interface TxnFilter {
  status?: QboTxnStatus;
  proposalId?: string;
}

export async function listTransactions(filter: TxnFilter = {}) {
  return prisma.qboTransaction.findMany({
    where: { ...(filter.status ? { status: filter.status } : {}), ...(filter.proposalId ? { proposalId: filter.proposalId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}
