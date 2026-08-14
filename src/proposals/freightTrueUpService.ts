import { prisma } from '../lib/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { versionTotals } from './analytics.js';
import { snapshotAcceptedContent } from '../handoff/service.js';
import {
  buildContentSnapshot,
  computeIntegrityHash,
  depositFromSnapshot,
} from '../handoff/lock.js';
import {
  applyFreightAmounts,
  assertFreightOnlyChange,
  describeChanges,
  freightGaps,
  thirdPartyTotal,
  ageInDays,
  urgencyFor,
  ESCALATION_DAYS,
  type FreightGaps,
  type TrueUpAmounts,
} from './freightTrueUp.js';
import type { FreightTrueUp, FreightTrueUpStatus, Prisma } from '@prisma/client';

/**
 * Freight true-up — the stateful half.
 *
 * Applying a true-up is the only write in this system that changes a frozen
 * proposal version, so it does the whole job rather than half of it:
 *
 *   1. the freight goes onto the version's content;
 *   2. the price snapshot is RE-FROZEN, because every downstream document is
 *      asserted against it (transactions.ts refuses to build an invoice whose
 *      lines and snapshot disagree — an amendment that skipped this step would
 *      silently break QuickBooks pushes for the rest of the job's life);
 *   3. the operational order's content snapshot and integrity hash are rebuilt,
 *      so `verifyIntegrity` keeps reading clean;
 *   4. the movement is written to PriceOverrideLog and the audit log with the
 *      vendor and quote reference that justified it.
 *
 * The version's status, number, signature and line items are untouched. What the
 * customer signed is still what the customer signed.
 */

const LIVE: FreightTrueUpStatus[] = ['OPEN', 'STAGED'];

type Lines = Array<{ ref: string; sku?: string; name?: string; amountMinor: number }>;

function stagedLines(row: FreightTrueUp): Lines {
  const raw = row.thirdPartyLines;
  return Array.isArray(raw) ? (raw as unknown as Lines) : [];
}

/** Part numbers whose vendor quotes freight separately (`Manufacturer.freightTbd`). */
async function freightTbdSkus(): Promise<Set<string>> {
  const vendors = await prisma.manufacturer.findMany({
    where: { OR: [{ freightTbd: true }, { rfqEnabled: true }] },
    select: { name: true },
  });
  if (!vendors.length) return new Set();
  const skus = await prisma.sku.findMany({
    where: { manufacturer: { in: vendors.map((v) => v.name) } },
    select: { part: true },
  });
  return new Set(skus.map((s) => s.part.trim().toUpperCase()));
}

async function loadVersion(versionId: string) {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    include: {
      proposal: {
        select: { id: true, number: true, title: true, organizationId: true, archivedAt: true },
      },
    },
  });
  if (!version) throw new NotFoundError('Proposal version not found');
  return version;
}

/**
 * Gaps on a version, with the vendor names filled in.
 *
 * A rep looking at "3 lines have no freight" needs to know whose freight it is —
 * that is who has to be chased.
 */
export async function gapsForVersion(versionId: string): Promise<FreightGaps> {
  const version = await loadVersion(versionId);
  const gaps = freightGaps(version.items, version.sections, {
    freightTbdSkus: await freightTbdSkus(),
  });
  if (gaps.thirdParty.length) {
    const rows = await prisma.sku.findMany({
      where: { part: { in: gaps.thirdParty.map((l) => l.sku) } },
      select: { part: true, manufacturer: true },
    });
    const byPart = new Map(rows.map((r) => [r.part.trim().toUpperCase(), r.manufacturer]));
    for (const l of gaps.thirdParty) l.vendor = byPart.get(l.sku.trim().toUpperCase()) ?? null;
  }
  return gaps;
}

/**
 * The live true-up for a version, created on demand.
 *
 * Opening one is not a commitment to anything — it is the record that somebody is
 * responsible for a freight figure on this job, which is precisely what tends to
 * exist nowhere.
 */
export async function openTrueUp(versionId: string, actorId: string): Promise<FreightTrueUp> {
  const version = await loadVersion(versionId);
  if (!version.frozen && version.status === 'DRAFT') {
    throw new ConflictError(
      'This version is still a draft — enter freight in the proposal builder. A true-up is for a proposal that has already gone out.',
    );
  }
  const existing = await prisma.freightTrueUp.findFirst({
    where: { versionId, status: { in: LIVE } },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing;

  const row = await prisma.freightTrueUp.create({
    data: { proposalId: version.proposalId, versionId, status: 'OPEN', createdById: actorId },
  });
  await recordAudit({
    actorId,
    action: 'freight.trueup.open',
    entity: 'FreightTrueUp',
    entityId: row.id,
    details: { proposalId: version.proposalId, versionId, number: version.proposal.number },
  });
  return row;
}

export interface StageInput extends TrueUpAmounts {
  thirdPartyLines?: Array<{ ref: string; sku?: string; name?: string; amountMinor: number }>;
  vendorName?: string | null;
  vendorQuoteRef?: string | null;
  quoteAttachmentId?: string | null;
  freightRfqId?: string | null;
  note?: string | null;
}

/**
 * Save entered amounts without applying them.
 *
 * Evidence is required as soon as there is money: a freight figure with no vendor
 * quote behind it is somebody's recollection, and it ends up being defended to a
 * customer months later. A reference number is enough — the quote PDF is better.
 */
export async function stageTrueUp(
  id: string,
  input: StageInput,
  actorId: string,
): Promise<FreightTrueUp> {
  const row = await prisma.freightTrueUp.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Freight entry not found');
  if (!LIVE.includes(row.status))
    throw new ConflictError(
      `This freight entry is ${row.status.toLowerCase()} and can no longer be edited`,
    );

  const lines = (input.thirdPartyLines ?? stagedLines(row)).filter((l) => l && l.ref);
  const tpTotal = thirdPartyTotal(lines);
  const structure = input.structureFreightMinor;
  const standard = input.stdFreightMinor;
  const money = tpTotal + (structure ?? 0) + (standard ?? 0);

  const ref = (input.vendorQuoteRef ?? row.vendorQuoteRef ?? '').trim();
  const attachment = input.quoteAttachmentId ?? row.quoteAttachmentId;
  if (money > 0 && !ref && !attachment) {
    throw new ValidationError(
      'Give the vendor quote reference, or attach the quote, before saving a freight amount.',
    );
  }

  const updated = await prisma.freightTrueUp.update({
    where: { id },
    data: {
      status: 'STAGED',
      thirdPartyLines: lines as unknown as Prisma.InputJsonValue,
      thirdPartyTotalMinor: tpTotal,
      ...(structure !== undefined ? { structureFreightMinor: structure } : {}),
      ...(standard !== undefined ? { stdFreightMinor: standard } : {}),
      ...(input.vendorName !== undefined ? { vendorName: input.vendorName } : {}),
      ...(input.vendorQuoteRef !== undefined ? { vendorQuoteRef: input.vendorQuoteRef } : {}),
      ...(input.quoteAttachmentId !== undefined
        ? { quoteAttachmentId: input.quoteAttachmentId }
        : {}),
      ...(input.freightRfqId !== undefined ? { freightRfqId: input.freightRfqId } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
  });
  await recordAudit({
    actorId,
    action: 'freight.trueup.stage',
    entity: 'FreightTrueUp',
    entityId: id,
    details: {
      thirdPartyTotalMinor: tpTotal,
      structureFreightMinor: structure ?? null,
      stdFreightMinor: standard ?? null,
      vendorQuoteRef: ref || null,
    },
  });
  return updated;
}

/**
 * Record that this job carries no third-party freight after all.
 *
 * A reason is required and the record is kept. "No freight applies" is the answer
 * that most resembles a forgotten job, so it has to be a deliberate, attributable
 * act rather than a gap that quietly stops being reported.
 */
export async function markNoFreight(
  id: string,
  reason: string,
  actorId: string,
): Promise<FreightTrueUp> {
  const row = await prisma.freightTrueUp.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Freight entry not found');
  if (!LIVE.includes(row.status))
    throw new ConflictError(`This freight entry is already ${row.status.toLowerCase()}`);
  const text = String(reason ?? '').trim();
  if (text.length < 5)
    throw new ValidationError('Say why no freight applies — one line is enough.');

  const updated = await prisma.freightTrueUp.update({
    where: { id },
    data: { status: 'VOID', noFreightReason: text },
  });
  await recordAudit({
    actorId,
    action: 'freight.trueup.no_freight',
    entity: 'FreightTrueUp',
    entityId: id,
    details: { proposalId: row.proposalId, versionId: row.versionId, reason: text },
  });
  return updated;
}

export interface ApplyResult {
  trueUp: FreightTrueUp;
  previousTotalMinor: number;
  newTotalMinor: number;
  deltaMinor: number;
  summary: string;
  orderUpdated: boolean;
  /** Invoices already in QuickBooks that no longer match the proposal. */
  invoicesToReconcile: Array<{
    txnId: string;
    docNumber: string | null;
    qboId: string | null;
    totalMinor: string;
  }>;
}

/**
 * Write the staged freight onto the frozen version.
 *
 * Deliberately not wrapped around the snapshot create: a PriceSnapshot is immutable
 * and additive, so creating one that is then not adopted costs a stray row and
 * nothing else, whereas a version pointing at a snapshot that failed to commit
 * would break every document build until someone noticed.
 */
export async function applyTrueUp(id: string, actorId: string): Promise<ApplyResult> {
  const row = await prisma.freightTrueUp.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Freight entry not found');
  if (row.status === 'APPLIED') throw new ConflictError('This freight has already been applied');
  if (row.status === 'VOID') throw new ConflictError('This freight entry was withdrawn');

  const version = await loadVersion(row.versionId);
  if (version.proposal.archivedAt)
    throw new ConflictError('This proposal is archived. Restore it before amending freight.');

  const amounts: TrueUpAmounts = {
    structureFreightMinor: row.structureFreightMinor,
    stdFreightMinor: row.stdFreightMinor,
    thirdPartyLines: stagedLines(row).map((l) => ({
      ref: l.ref,
      amountMinor: Number(l.amountMinor) || 0,
    })),
  };
  const applied = applyFreightAmounts(version.sections, version.items, amounts);
  assertFreightOnlyChange(applied.before, applied.after);
  if (!applied.changes.length) {
    throw new ValidationError(
      'Nothing to apply — the entered freight matches what is already on the proposal.',
    );
  }

  // Re-freeze. Same function the acceptance path uses, so the snapshot shape,
  // the deposit percentage and the balance are computed exactly one way.
  const snapshot = await snapshotAcceptedContent(
    version.id,
    applied.sections,
    applied.items,
    actorId,
  );

  const order = await prisma.acceptedOrder.findUnique({ where: { proposalVersionId: version.id } });
  const summary = describeChanges(applied.changes, applied.deltaMinor);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.proposalVersion.update({
      where: { id: version.id },
      data: {
        sections: applied.sections as object,
        items: applied.items as object,
        priceSnapshotId: snapshot.id,
      },
    });

    if (order) {
      const content = buildContentSnapshot(
        {
          id: version.id,
          version: version.version,
          proposalId: version.proposalId,
          sections: applied.sections,
          items: applied.items,
          priceSnapshotId: snapshot.id,
          status: version.status,
          frozen: version.frozen,
        },
        snapshot,
      );
      const deposit = depositFromSnapshot(snapshot);
      await tx.acceptedOrder.update({
        where: { id: order.id },
        data: {
          priceSnapshotId: snapshot.id,
          grandTotalMinor: snapshot.grandTotal,
          depositDueMinor: deposit,
          depositRequired: deposit > 0n,
          contentSnapshot: content as unknown as Prisma.InputJsonValue,
          integrityHash: computeIntegrityHash(content),
        },
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          action: 'freight.trueup.applied',
          actorId,
          detail: {
            summary,
            previousTotalMinor: applied.before.total,
            newTotalMinor: applied.after.total,
            vendorQuoteRef: row.vendorQuoteRef,
          } as object,
        },
      });
    }

    // A freight figure entered after release is an override of the accepted price,
    // and it belongs in the same log as every other one.
    await tx.priceOverrideLog.create({
      data: {
        subjectRef: `proposalVersion:${version.id}`,
        field: 'freight',
        previousValue: String(applied.before.total),
        newValue: String(applied.after.total),
        reason:
          `Freight true-up after release — ${summary}` +
          (row.vendorQuoteRef ? ` · vendor quote ${row.vendorQuoteRef}` : '') +
          (row.vendorName ? ` · ${row.vendorName}` : ''),
        authorizedById: actorId,
      },
    });

    return tx.freightTrueUp.update({
      where: { id },
      data: {
        status: 'APPLIED',
        appliedAt: new Date(),
        appliedById: actorId,
        previousTotalMinor: BigInt(applied.before.total),
        newTotalMinor: BigInt(applied.after.total),
        previousSnapshotId: version.priceSnapshotId,
        newSnapshotId: snapshot.id,
        // Cleared on purpose: the customer holds a document with the old total and
        // has not been told. Nothing is emailed automatically — the flag is what
        // makes the omission visible until a rep sends the revised PDF.
        customerNotifiedAt: null,
        customerNotifiedById: null,
      },
    });
  });

  // Documents already in QuickBooks now disagree with the proposal. Reported, not
  // repaired: what to do about a live invoice is a decision for whoever holds the
  // customer relationship, and the QuickBooks push is a separate, authorized step.
  const created = await prisma.qboTransaction.findMany({
    where: {
      proposalId: version.proposalId,
      status: 'CREATED',
      type: { in: ['INVOICE', 'ESTIMATE'] },
    },
    select: { id: true, qboDocNumber: true, qboId: true, amountMinor: true, type: true },
  });

  await recordAudit({
    actorId,
    action: 'freight.trueup.apply',
    entity: 'ProposalVersion',
    entityId: version.id,
    details: {
      trueUpId: id,
      number: version.proposal.number,
      summary,
      previousTotalMinor: applied.before.total,
      newTotalMinor: applied.after.total,
      previousSnapshotId: version.priceSnapshotId,
      newSnapshotId: snapshot.id,
      orderUpdated: !!order,
      openQboDocuments: created.length,
    },
  });
  logger.info(
    { versionId: version.id, trueUpId: id, deltaMinor: applied.deltaMinor },
    'freight true-up applied',
  );

  return {
    trueUp: updated,
    previousTotalMinor: applied.before.total,
    newTotalMinor: applied.after.total,
    deltaMinor: applied.deltaMinor,
    summary,
    orderUpdated: !!order,
    invoicesToReconcile: created
      .filter((t) => t.type === 'INVOICE')
      .map((t) => ({
        txnId: t.id,
        docNumber: t.qboDocNumber,
        qboId: t.qboId,
        totalMinor: t.amountMinor.toString(),
      })),
  };
}

/** Mark the revised total as sent to the customer, clearing the "not notified" flag. */
export async function markCustomerNotified(id: string, actorId: string): Promise<FreightTrueUp> {
  const row = await prisma.freightTrueUp.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Freight entry not found');
  if (row.status !== 'APPLIED')
    throw new ConflictError('Nothing has been applied yet, so there is no revised total to send');
  const updated = await prisma.freightTrueUp.update({
    where: { id },
    data: { customerNotifiedAt: new Date(), customerNotifiedById: actorId },
  });
  await recordAudit({
    actorId,
    action: 'freight.trueup.customer_notified',
    entity: 'FreightTrueUp',
    entityId: id,
    details: { proposalId: row.proposalId },
  });
  return updated;
}

export interface QueueRow {
  proposalId: string;
  versionId: string;
  number: string;
  title: string;
  customer: string;
  version: number;
  status: string;
  /** Released date — the clock the age is measured from. */
  since: string | null;
  ageDays: number;
  urgency: string;
  totalMinor: number;
  gapBuckets: string[];
  gapLineCount: number;
  vendors: string[];
  trueUpId: string | null;
  trueUpStatus: string | null;
  stagedMinor: number;
  vendorQuoteRef: string | null;
  /** An invoice exists in QuickBooks for this job. */
  hasInvoice: boolean;
  invoicePushed: boolean;
  customerNotified: boolean;
}

/**
 * The freight queue — every job whose freight is outstanding, oldest first.
 *
 * Scoped to the latest RELEASED or ACCEPTED version of each live proposal, which
 * is the set where an unquoted freight bill is real money. Drafts are excluded:
 * their freight is not late, it is unfinished.
 */
export async function freightQueue(
  opts: { limit?: number; includeSettled?: boolean; threshold?: number } = {},
): Promise<{ rows: QueueRow[]; escalated: number; threshold: number }> {
  const threshold = opts.threshold ?? ESCALATION_DAYS;
  const versions = await prisma.proposalVersion.findMany({
    where: { status: { in: ['RELEASED', 'ACCEPTED'] }, proposal: { archivedAt: null } },
    orderBy: [{ version: 'desc' }],
    take: 400,
    select: {
      id: true,
      version: true,
      status: true,
      releasedAt: true,
      createdAt: true,
      items: true,
      sections: true,
      proposalId: true,
      proposal: { select: { number: true, title: true, organizationId: true } },
    },
  });

  const latest = new Map<string, (typeof versions)[number]>();
  for (const v of versions) {
    const held = latest.get(v.proposalId);
    if (!held || v.version > held.version) latest.set(v.proposalId, v);
  }
  const rows = [...latest.values()];
  if (!rows.length) return { rows: [], escalated: 0, threshold };

  const [tbd, orgs, trueUps, invoices, skuRows] = await Promise.all([
    freightTbdSkus(),
    prisma.organization.findMany({
      where: { id: { in: [...new Set(rows.map((v) => v.proposal.organizationId))] } },
      select: { id: true, name: true },
    }),
    prisma.freightTrueUp.findMany({
      where: { versionId: { in: rows.map((v) => v.id) } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.qboTransaction.findMany({
      where: {
        proposalId: { in: rows.map((v) => v.proposalId) },
        type: 'INVOICE',
        status: 'CREATED',
      },
      select: { proposalId: true },
    }),
    prisma.sku.findMany({ select: { part: true, manufacturer: true } }),
  ]);

  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const vendorByPart = new Map(skuRows.map((r) => [r.part.trim().toUpperCase(), r.manufacturer]));
  const invoiced = new Set(invoices.map((i) => i.proposalId));
  const latestTrueUp = new Map<string, FreightTrueUp>();
  for (const t of trueUps) if (!latestTrueUp.has(t.versionId)) latestTrueUp.set(t.versionId, t);

  const now = new Date();
  const out: QueueRow[] = [];
  for (const v of rows) {
    const gaps = freightGaps(v.items, v.sections, { freightTbdSkus: tbd });
    const t = latestTrueUp.get(v.id) ?? null;
    const settled = t?.status === 'APPLIED' || t?.status === 'VOID';
    if (!gaps.any && !t) continue;
    if (settled && !opts.includeSettled) continue;

    const since = v.releasedAt ?? v.createdAt;
    const ageDays = ageInDays(since, now);
    out.push({
      proposalId: v.proposalId,
      versionId: v.id,
      number: v.proposal.number,
      title: v.proposal.title,
      customer: orgName.get(v.proposal.organizationId) ?? '—',
      version: v.version,
      status: v.status,
      since: since ? since.toISOString() : null,
      ageDays,
      urgency: settled ? 'NEW' : urgencyFor(ageDays, threshold),
      totalMinor: versionTotals(v.items, v.sections).total,
      gapBuckets: gaps.buckets,
      gapLineCount: gaps.thirdParty.length,
      vendors: [
        ...new Set(
          gaps.thirdParty
            .map((l) => vendorByPart.get(l.sku.trim().toUpperCase()) ?? '')
            .filter(Boolean) as string[],
        ),
      ],
      trueUpId: t?.id ?? null,
      trueUpStatus: t?.status ?? null,
      stagedMinor:
        (t?.thirdPartyTotalMinor ?? 0) +
        (t?.structureFreightMinor ?? 0) +
        (t?.stdFreightMinor ?? 0),
      vendorQuoteRef: t?.vendorQuoteRef ?? null,
      hasInvoice: invoiced.has(v.proposalId),
      invoicePushed: !!t?.qboPushedAt,
      customerNotified: !!t?.customerNotifiedAt,
    });
  }

  out.sort((a, b) => b.ageDays - a.ageDays || a.number.localeCompare(b.number));
  return {
    rows: out.slice(0, opts.limit ?? 100),
    escalated: out.filter((r) => r.urgency === 'ESCALATED').length,
    threshold,
  };
}

/** Everything the proposal screen needs about freight on one version. */
export async function freightStateForVersion(versionId: string) {
  const version = await loadVersion(versionId);
  const [gaps, history] = await Promise.all([
    gapsForVersion(versionId),
    prisma.freightTrueUp.findMany({ where: { versionId }, orderBy: { createdAt: 'desc' } }),
  ]);
  const live = history.find((h) => LIVE.includes(h.status)) ?? null;
  const totals = versionTotals(version.items, version.sections);
  return {
    proposalId: version.proposalId,
    versionId,
    number: version.proposal.number,
    title: version.proposal.title,
    version: version.version,
    status: version.status,
    frozen: version.frozen,
    releasedAt: version.releasedAt ? version.releasedAt.toISOString() : null,
    ageDays: ageInDays(version.releasedAt ?? version.createdAt),
    threshold: ESCALATION_DAYS,
    totals: {
      totalMinor: totals.total,
      tpFreightMinor: totals.tpFreight,
      structureFreightMinor: totals.structureFreight,
      stdFreightMinor: totals.stdFreight,
    },
    gaps,
    live,
    history,
  };
}

export interface FreightGate {
  settled: boolean;
  reason: string | null;
  proposalId: string;
  versionId: string | null;
  outstanding: string[];
}

/**
 * Is this job's freight settled?
 *
 * Used to stop an order being closed out and a Bill of Materials being confirmed
 * to a vendor while a freight bill is still unaccounted for. Deliberately NOT used
 * to block accepting the proposal, creating the order or raising the invoice —
 * those are the steps that get manufacturing moving, and the whole point of this
 * feature is that they must not wait on freight.
 */
export async function freightGateStatus(proposalId: string): Promise<FreightGate> {
  const version = await prisma.proposalVersion.findFirst({
    where: { proposalId, status: { in: ['RELEASED', 'ACCEPTED'] } },
    orderBy: { version: 'desc' },
    select: { id: true, items: true, sections: true },
  });
  if (!version)
    return { settled: true, reason: null, proposalId, versionId: null, outstanding: [] };

  const [gaps, resolved] = await Promise.all([
    freightGaps(version.items, version.sections, { freightTbdSkus: await freightTbdSkus() }),
    prisma.freightTrueUp.findFirst({
      where: { versionId: version.id, status: { in: ['APPLIED', 'VOID'] } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  if (!gaps.any || resolved)
    return { settled: true, reason: null, proposalId, versionId: version.id, outstanding: [] };

  const parts: string[] = [];
  if (gaps.thirdParty.length)
    parts.push(
      `${gaps.thirdParty.length} line${gaps.thirdParty.length === 1 ? '' : 's'} with no third-party freight`,
    );
  if (gaps.structureMissing) parts.push('no structure freight');
  if (gaps.standardMissing) parts.push('standard freight switched on but zero');

  return {
    settled: false,
    proposalId,
    versionId: version.id,
    outstanding: gaps.buckets,
    reason:
      `This job still has freight outstanding — ${parts.join(', ')}. Enter the vendor's figures ` +
      `(or record that no freight applies) on the proposal's freight panel first.`,
  };
}

export async function assertFreightSettled(proposalId: string, action: string): Promise<void> {
  const gate = await freightGateStatus(proposalId);
  if (!gate.settled) throw new ConflictError(`${action} ${gate.reason}`);
}
