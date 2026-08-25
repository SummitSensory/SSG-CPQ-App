import { prisma } from '../lib/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { versionTotals } from './analytics.js';
import { snapshotAcceptedContent } from '../handoff/service.js';
import { resolveVendors } from '../handoff/vendorResolution.js';
import {
  buildContentSnapshot,
  computeIntegrityHash,
  depositFromSnapshot,
} from '../handoff/lock.js';
import { syncVersion } from '../integrations/monday/freightPull.js';
import {
  BUCKETS,
  FREIGHT_BUCKETS,
  alertIsQuiet,
  ageInDays,
  apportion,
  applyFreightEntries,
  assertEvidence,
  assertFreightOnlyChange,
  describeChanges,
  describeGaps,
  freightGaps,
  freightLines,
  normalizeBucket,
  urgencyFor,
  ESCALATION_DAYS,
  type FreightBucket,
  type FreightEntryInput,
  type FreightGaps,
  type FreightLine,
  type FreightScope,
  type LineContext,
} from './freightTrueUp.js';
import { Prisma as PrismaRuntime } from '@prisma/client';
import type { FreightEntry, FreightTrueUp, Prisma } from '@prisma/client';

/**
 * Freight true-up — the stateful half.
 *
 * Applying freight is the only write in this system that changes a frozen proposal
 * version, so it does the whole job rather than half of it:
 *
 *   1. the freight goes onto the version's content;
 *   2. the price snapshot is RE-FROZEN, because every downstream document is
 *      asserted against it (transactions.ts refuses to build an invoice whose lines
 *      and snapshot disagree — an amendment that skipped this step would silently
 *      break QuickBooks pushes for the rest of the job's life);
 *   3. the operational order's content snapshot and integrity hash are rebuilt, so
 *      `verifyIntegrity` keeps reading clean;
 *   4. the movement is written to PriceOverrideLog and the audit log with the source
 *      and evidence that justified it.
 *
 * The version's status, number, signature and line items are untouched. What the
 * customer signed is still what the customer signed.
 *
 * Freight arrives in instalments, so entries apply in batches: three of the four
 * buckets can be on the invoice while the fourth is still with a vendor. Each batch
 * is its own amendment, its own snapshot pair and its own trip to QuickBooks.
 */

const LIVE: Array<FreightTrueUp['status']> = ['OPEN', 'STAGED'];

/* ────────────────────────── loading context ────────────────────────── */

/**
 * Vendors and part numbers, for naming what is being shipped.
 *
 * `freightQuotedSkus` marks the lines EXPECTED to carry freight (their vendor quotes
 * shipping separately). It no longer filters what ops can see: the old screen showed
 * a bare amount box with no indication of which items it covered, which is the
 * complaint that prompted this rebuild. Every product line is offered; the marked
 * ones are the ones that will be chased.
 */
/**
 * Vendors and part numbers, for naming what is being shipped.
 *
 * The lookup is `resolveVendors`, the same resolver the Bill of Materials and the
 * freight requests use. This screen used to read `Sku.manufacturer` alone, so a part
 * whose maker is recorded against the catalog product — which is how the catalog
 * screens write it — was reported here as having no vendor on record. That is not what
 * the catalog says, and it made the vendor filters useless across most of a proposal.
 *
 * `freightQuotedSkus` marks the lines EXPECTED to carry freight (their vendor quotes
 * shipping separately). It does not filter what ops can see: every product line is
 * offered, and the marked ones are the ones that will be chased.
 */
async function lineContext(items?: unknown): Promise<LineContext> {
  const skuList = Array.isArray(items)
    ? (items as Array<{ sku?: unknown }>).map((l) => String(l?.sku ?? ''))
    : [];
  // The per-version callers pass their items, which keeps the resolver's work to one
  // proposal. The bulk callers cover many versions at once, so they fall back to
  // reading the whole catalog — the same two sources, just unscoped.
  const [vendors, resolved, allSkus, allSourcing] = await Promise.all([
    prisma.manufacturer.findMany({
      select: { name: true, freightTbd: true, rfqEnabled: true, bomFreightSource: true },
    }),
    skuList.length
      ? resolveVendors(skuList)
      : Promise.resolve({ vendorBySku: new Map<string, string>(), unresolved: [] }),
    skuList.length
      ? Promise.resolve([] as Array<{ part: string; manufacturer: string | null }>)
      : prisma.sku.findMany({ select: { part: true, manufacturer: true } }),
    skuList.length
      ? Promise.resolve([] as Array<{ product: { sku: string }; manufacturer: { name: string } }>)
      : prisma.productSourcing.findMany({
          where: { isPrimary: true },
          select: { product: { select: { sku: true } }, manufacturer: { select: { name: true } } },
        }),
  ]);

  const quoting = new Set(vendors.filter((v) => v.freightTbd || v.rfqEnabled).map((v) => v.name));

  /**
   * Vendors whose freight is already accounted for by a board-fed bucket.
   *
   * Goldberg's shipping is the Steel figure on the deal board and Resilite's is the
   * Mats figure. Allowing their parts to be picked in a hand-entered bucket invites the
   * same shipment being paid for twice — once from the board, once by hand — and
   * nothing downstream would catch it.
   */
  const bucketByVendor = new Map<string, 'STEEL' | 'MATS'>();
  for (const v of vendors) {
    if (v.bomFreightSource === 'STRUCTURE') bucketByVendor.set(v.name, 'STEEL');
    else if (v.bomFreightSource === 'MATS') bucketByVendor.set(v.name, 'MATS');
  }

  const vendorBySku = new Map<string, string>();
  const freightQuotedSkus = new Set<string>();
  const put = (part: string | null | undefined, vendor: string | null | undefined) => {
    const key = String(part ?? '')
      .trim()
      .toUpperCase();
    const name = String(vendor ?? '').trim();
    if (!key || !name || vendorBySku.has(key)) return;
    vendorBySku.set(key, name);
    if (quoting.has(name)) freightQuotedSkus.add(key);
  };
  for (const [key, name] of resolved.vendorBySku) put(key, name);
  // Sku first, then the catalog's sourcing relation — the same order of authority the
  // shared resolver applies.
  for (const row of allSkus) put(row.part, row.manufacturer);
  for (const row of allSourcing) put(row.product?.sku, row.manufacturer?.name);

  return { freightQuotedSkus, vendorBySku, bucketByVendor };
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

/** The live true-up folder for a version, created on demand. */
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

/* ────────────────────────── what is outstanding ────────────────────────── */

/**
 * Buckets still waiting on an answer, accounting for what has been entered.
 *
 * `freightGaps` reads the proposal's content, which is the truth about what the
 * customer's document says. It cannot know that a figure is entered but not yet
 * applied, or that a bucket has been closed out as not applicable — those live in
 * the entries. This narrows the content-level gaps by both.
 */
async function outstandingBuckets(
  versionId: string,
  gaps: FreightGaps,
): Promise<{
  buckets: FreightBucket[];
  answered: FreightBucket[];
  notApplicable: FreightBucket[];
}> {
  const entries = await prisma.freightEntry.findMany({
    where: { versionId },
    select: { bucket: true, status: true, amountMinor: true },
  });
  const answered = new Set<FreightBucket>();
  const notApplicable = new Set<FreightBucket>();
  for (const e of entries) {
    const bucket = normalizeBucket(e.bucket);
    if (!bucket) continue;
    if (e.status === 'VOID') notApplicable.add(bucket);
    else answered.add(bucket);
  }
  return {
    buckets: gaps.buckets.filter((b) => !answered.has(b) && !notApplicable.has(b)),
    answered: [...answered],
    notApplicable: [...notApplicable],
  };
}

/* ────────────────────────── entries ────────────────────────── */

export interface SaveEntryInput {
  versionId: string;
  bucket: string;
  scope: FreightScope;
  amountMinor: number;
  /** For a LINES entry: the product items this amount covers. */
  lineRefs?: string[];
  vendorName?: string | null;
  vendorQuoteRef?: string | null;
  quoteAttachmentId?: string | null;
  description?: string | null;
  overrideReason?: string | null;
  note?: string | null;
  /** Editing an existing staged entry rather than adding one. */
  entryId?: string;
}

/**
 * Save one freight figure.
 *
 * A LINES entry takes ONE amount and the items it covers, and the split across them
 * is computed here — ops asked for that shape because a vendor quotes "$1,840 to ship
 * the swing, the platform and the crash pad", not a figure per part. The split is
 * stored alongside the entry so the apportionment that reached the proposal is on the
 * record, not recomputed later from prices that may have moved.
 *
 * A STEEL or MATS figure typed by hand is an override of the board and needs a
 * reason. That is not bureaucracy: the board is what the freight desk maintains, and
 * a hand-typed figure that silently disagrees with it is the bug this whole feature
 * is trying to stop.
 */
export async function saveEntry(input: SaveEntryInput, actorId: string): Promise<FreightEntry> {
  const bucket = normalizeBucket(input.bucket);
  if (!bucket) throw new ValidationError(`"${input.bucket}" is not a freight bucket`);
  const spec = BUCKETS[bucket];
  if (!spec.scopes.includes(input.scope)) {
    throw new ValidationError(
      `${spec.label} is entered ${spec.scopes.includes('JOB') ? 'as one amount for the job' : 'against the items it covers'}.`,
    );
  }

  const version = await loadVersion(input.versionId);
  // Anything saved through this form is hand-entered by definition; a board-sourced
  // entry is created by the pull, never here. For STEEL and MATS that makes this an
  // override, which is why assertEvidence demands a reason for it.
  const source = 'MANUAL' as const;
  assertEvidence({
    bucket,
    scope: input.scope,
    amountMinor: input.amountMinor,
    source,
    vendorQuoteRef: input.vendorQuoteRef,
    quoteAttachmentId: input.quoteAttachmentId,
    description: input.description,
    overrideReason: input.overrideReason,
  });

  let allocations: Prisma.InputJsonValue | undefined;
  if (input.scope === 'LINES') {
    const refs = [...new Set((input.lineRefs ?? []).map((r) => String(r).trim()).filter(Boolean))];
    if (!refs.length) throw new ValidationError('Pick the items this freight is for.');
    const lines = freightLines(version.items, await lineContext(version.items));
    const byRef = new Map(lines.map((l) => [l.ref, l]));
    const chosen: FreightLine[] = [];
    for (const ref of refs) {
      const line = byRef.get(ref);
      if (!line) {
        throw new ValidationError(
          `Item ${ref} is no longer on this proposal. Re-open the freight panel to pick up the current items.`,
        );
      }
      chosen.push(line);
    }
    allocations = apportion(input.amountMinor, chosen).map((a) => {
      const line = byRef.get(a.ref)!;
      return { ref: a.ref, sku: line.sku, name: line.name, amountMinor: a.amountMinor };
    }) as unknown as Prisma.InputJsonValue;
  }

  const trueUp = await openTrueUp(input.versionId, actorId);

  if (input.entryId) {
    const held = await prisma.freightEntry.findUnique({ where: { id: input.entryId } });
    if (!held) throw new NotFoundError('That freight amount is not on file');
    if (held.status !== 'STAGED') {
      throw new ConflictError(
        held.status === 'PUSHED'
          ? 'This amount is already on the customer’s invoice. Correcting it means a credit and a rebill — raise a new amount for the difference instead of editing this one.'
          : `This amount is ${held.status.toLowerCase()} and can no longer be edited. Add a new amount for the difference.`,
      );
    }
  }

  const data = {
    trueUpId: trueUp.id,
    proposalId: version.proposalId,
    versionId: input.versionId,
    bucket,
    scope: input.scope,
    source,
    status: 'STAGED' as const,
    amountMinor: input.amountMinor,
    // A nullable Json column is cleared with DbNull, not with `null` — `null` in a
    // Prisma Json field means "the JSON value null", which is a different thing and
    // is not accepted here. A JOB entry has no per-item split to store.
    allocations: allocations ?? PrismaRuntime.DbNull,
    vendorName: input.vendorName ?? null,
    vendorQuoteRef: input.vendorQuoteRef ?? null,
    quoteAttachmentId: input.quoteAttachmentId ?? null,
    description: input.description ?? null,
    overrideReason: input.overrideReason ?? null,
    note: input.note ?? null,
  };

  const row = input.entryId
    ? await prisma.freightEntry.update({ where: { id: input.entryId }, data })
    : await prisma.freightEntry.create({ data: { ...data, createdById: actorId } });

  await prisma.freightTrueUp.update({ where: { id: trueUp.id }, data: { status: 'STAGED' } });
  await recordAudit({
    actorId,
    action: input.entryId ? 'freight.entry.update' : 'freight.entry.create',
    entity: 'FreightEntry',
    entityId: row.id,
    details: {
      versionId: input.versionId,
      bucket,
      scope: input.scope,
      amountMinor: input.amountMinor,
      vendorQuoteRef: input.vendorQuoteRef ?? null,
      overrideReason: input.overrideReason ?? null,
    },
  });
  return row;
}

/** Withdraw a staged amount that was entered in error. */
export async function deleteEntry(entryId: string, actorId: string): Promise<void> {
  const row = await prisma.freightEntry.findUnique({ where: { id: entryId } });
  if (!row) throw new NotFoundError('That freight amount is not on file');
  if (row.status !== 'STAGED') {
    throw new ConflictError(
      'Only an amount that has not been applied can be removed. This one is on the proposal — record a correction instead.',
    );
  }
  await prisma.freightEntry.delete({ where: { id: entryId } });
  await recordAudit({
    actorId,
    action: 'freight.entry.delete',
    entity: 'FreightEntry',
    entityId: entryId,
    details: { versionId: row.versionId, bucket: row.bucket, amountMinor: row.amountMinor },
  });
}

/**
 * Close a bucket out as not applicable, with a reason.
 *
 * "No freight applies" is the answer that most resembles a forgotten job, so it has
 * to be a deliberate, attributable act rather than a gap that quietly stops being
 * reported. Recorded per bucket, because "the mats ship freight-included" is a fact
 * about the mats and says nothing about the steel.
 */
export async function markBucketNotApplicable(
  versionId: string,
  bucketInput: string,
  reason: string,
  actorId: string,
): Promise<FreightEntry> {
  const bucket = normalizeBucket(bucketInput);
  if (!bucket) throw new ValidationError(`"${bucketInput}" is not a freight bucket`);
  const text = String(reason ?? '').trim();
  if (text.length < 5)
    throw new ValidationError('Say why no freight applies to this bucket — one line is enough.');

  const version = await loadVersion(versionId);
  const trueUp = await openTrueUp(versionId, actorId);
  const existing = await prisma.freightEntry.findFirst({
    where: { versionId, bucket, status: { in: ['APPLIED', 'PUSHED'] } },
  });
  if (existing) {
    throw new ConflictError(
      `${BUCKETS[bucket].label} has already been applied to this proposal, so it cannot be marked as not applicable.`,
    );
  }

  await prisma.freightEntry.deleteMany({ where: { versionId, bucket, status: 'STAGED' } });
  const row = await prisma.freightEntry.create({
    data: {
      trueUpId: trueUp.id,
      proposalId: version.proposalId,
      versionId,
      bucket,
      scope: BUCKETS[bucket].scopes[0]!,
      source: 'MANUAL',
      status: 'VOID',
      amountMinor: 0,
      voidReason: text,
      createdById: actorId,
    },
  });
  await recordAudit({
    actorId,
    action: 'freight.entry.not_applicable',
    entity: 'FreightEntry',
    entityId: row.id,
    details: { versionId, bucket, reason: text, number: version.proposal.number },
  });
  return row;
}

/* ────────────────────────── applying ────────────────────────── */

export interface ApplyResult {
  trueUp: FreightTrueUp;
  entryIds: string[];
  previousTotalMinor: number;
  newTotalMinor: number;
  deltaMinor: number;
  summary: string;
  orderUpdated: boolean;
  invoicesToReconcile: Array<{
    txnId: string;
    docNumber: string | null;
    qboId: string | null;
    totalMinor: string;
  }>;
}

/**
 * Write a batch of staged amounts onto the frozen version.
 *
 * Deliberately not wrapped around the snapshot create: a PriceSnapshot is immutable
 * and additive, so creating one that is then not adopted costs a stray row and
 * nothing else, whereas a version pointing at a snapshot that failed to commit would
 * break every document build until someone noticed.
 */
export async function applyEntries(
  versionId: string,
  entryIds: string[] | null,
  actorId: string,
): Promise<ApplyResult> {
  const version = await loadVersion(versionId);
  if (version.proposal.archivedAt)
    throw new ConflictError('This proposal is archived. Restore it before amending freight.');

  const staged = await prisma.freightEntry.findMany({
    where: {
      versionId,
      status: 'STAGED',
      ...(entryIds && entryIds.length ? { id: { in: entryIds } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!staged.length) {
    throw new ValidationError('There are no entered freight amounts waiting to be applied.');
  }
  const zeroOnly = staged.every((e) => e.amountMinor === 0);
  if (zeroOnly) throw new ValidationError('Every amount in this batch is zero — nothing to apply.');

  const inputs: FreightEntryInput[] = staged.map((e) => ({
    bucket: normalizeBucket(e.bucket)!,
    scope: e.scope as FreightScope,
    amountMinor: e.amountMinor,
    // A board-read amount is the board's CURRENT TOTAL for that bucket, so it replaces
    // whatever the proposal carries. Adding it doubled a figure that was already there
    // — the proposal had been pulled from the same column before it was accepted.
    // A hand-entered amount stays an instalment: a second shipment is a second amount.
    absolute: e.source === 'MONDAY',
    allocations: Array.isArray(e.allocations)
      ? (e.allocations as Array<{ ref: string; amountMinor: number }>).map((a) => ({
          ref: String(a.ref),
          amountMinor: Number(a.amountMinor) || 0,
        }))
      : undefined,
  }));

  const applied = applyFreightEntries(version.sections, version.items, inputs);
  assertFreightOnlyChange(applied.before, applied.after);
  if (!applied.changes.length) {
    throw new ValidationError(
      'Nothing to apply — the entered freight matches what is already on the proposal.',
    );
  }

  // Re-freeze. Same function the acceptance path uses, so the snapshot shape, the
  // deposit percentage and the balance are computed exactly one way.
  const snapshot = await snapshotAcceptedContent(
    version.id,
    applied.sections,
    applied.items,
    actorId,
  );
  const order = await prisma.acceptedOrder.findUnique({ where: { proposalVersionId: version.id } });
  const summary = describeChanges(applied.changes, applied.deltaMinor);
  const trueUpId = staged[0]!.trueUpId;
  const evidence = [...new Set(staged.map((e) => e.vendorQuoteRef).filter(Boolean))].join(', ');
  const now = new Date();

  const trueUp = await prisma.$transaction(async (tx) => {
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
            buckets: staged.map((e) => e.bucket),
            evidence: evidence || null,
          } as object,
        },
      });
    }

    // Freight entered after release is an override of the accepted price, and it
    // belongs in the same log as every other one.
    await tx.priceOverrideLog.create({
      data: {
        subjectRef: `proposalVersion:${version.id}`,
        field: 'freight',
        previousValue: String(applied.before.total),
        newValue: String(applied.after.total),
        reason: `Freight true-up after release — ${summary}${evidence ? ` · vendor quote ${evidence}` : ''}`,
        authorizedById: actorId,
      },
    });

    await tx.freightEntry.updateMany({
      where: { id: { in: staged.map((e) => e.id) } },
      data: { status: 'APPLIED', appliedAt: now, appliedById: actorId },
    });

    return tx.freightTrueUp.update({
      where: { id: trueUpId },
      data: {
        status: 'APPLIED',
        appliedAt: now,
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
        // A new amendment is new news; a banner dismissed yesterday should not
        // suppress it.
        alertAckAt: null,
        alertAckById: null,
      },
    });
  });

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
      trueUpId,
      entryIds: staged.map((e) => e.id),
      buckets: staged.map((e) => e.bucket),
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
    {
      versionId: version.id,
      trueUpId,
      deltaMinor: applied.deltaMinor,
      buckets: staged.map((e) => e.bucket),
    },
    'freight true-up applied',
  );

  return {
    trueUp,
    entryIds: staged.map((e) => e.id),
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

/* ────────────────────────── the screen ────────────────────────── */

/**
 * Everything the freight panel needs, in one call.
 *
 * The board is read as part of this — that is the "read live when the screen opens"
 * behaviour ops asked for — but a board failure never fails the call. `monday.error`
 * comes back and the panel offers the manual override path instead, which is the
 * only useful thing a screen can do when the source system is down.
 */
export async function freightStateForVersion(
  versionId: string,
  actorId: string,
  opts: { sync?: boolean } = {},
) {
  // The panel's own loader, so the resolver only looks up this proposal's parts.
  const scoped = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: { items: true },
  });
  const ctx = await lineContext(scoped?.items);
  let monday: Awaited<ReturnType<typeof syncVersion>> | null = null;
  if (opts.sync !== false) {
    try {
      monday = await syncVersion(versionId, actorId);
    } catch (err) {
      logger.warn({ err, versionId }, 'freight state: board sync failed');
      monday = null;
    }
  }

  const version = await loadVersion(versionId);
  const [entries, history] = await Promise.all([
    prisma.freightEntry.findMany({ where: { versionId }, orderBy: { createdAt: 'asc' } }),
    prisma.freightTrueUp.findMany({ where: { versionId }, orderBy: { createdAt: 'desc' } }),
  ]);

  const gaps = freightGaps(version.items, version.sections, ctx);
  const { buckets, notApplicable } = await outstandingBuckets(versionId, gaps);
  const totals = versionTotals(version.items, version.sections);
  const live = history.find((h) => LIVE.includes(h.status)) ?? history[0] ?? null;

  const byBucket = FREIGHT_BUCKETS.map((bucket) => {
    const spec = BUCKETS[bucket];
    const rows = entries.filter((e) => normalizeBucket(e.bucket) === bucket);
    const voided = rows.find((e) => e.status === 'VOID') ?? null;
    return {
      bucket,
      label: spec.label,
      short: spec.short,
      source: spec.source,
      scopes: spec.scopes,
      help: spec.help,
      onProposalMinor: totals[spec.totalsKey],
      outstanding: buckets.includes(bucket),
      notApplicable: !!voided,
      notApplicableReason: voided?.voidReason ?? null,
      stagedMinor: rows.filter((e) => e.status === 'STAGED').reduce((a, e) => a + e.amountMinor, 0),
      appliedMinor: rows
        .filter((e) => e.status === 'APPLIED' || e.status === 'PUSHED')
        .reduce((a, e) => a + e.amountMinor, 0),
      pushedMinor: rows.filter((e) => e.status === 'PUSHED').reduce((a, e) => a + e.amountMinor, 0),
      entries: rows.map(serializeEntry),
    };
  });

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
      steelMinor: totals.structureFreight,
      matsMinor: totals.matsFreight,
      therapeuticMinor: totals.tpFreight,
      otherMinor: totals.stdFreight,
    },
    /** Every product item, so ops can see what is being shipped. */
    lines: freightLines(version.items, ctx),
    buckets: byBucket,
    outstanding: buckets,
    notApplicable,
    gapLines: gaps.gapLines,
    monday,
    trueUpId: live?.id ?? null,
    live,
    history,
  };
}

/** FreightEntry for the browser: allocations typed, dates as ISO strings. */
export function serializeEntry(e: FreightEntry) {
  return {
    id: e.id,
    bucket: e.bucket,
    scope: e.scope,
    source: e.source,
    status: e.status,
    amountMinor: e.amountMinor,
    allocations: Array.isArray(e.allocations)
      ? (e.allocations as Array<{ ref: string; sku?: string; name?: string; amountMinor: number }>)
      : [],
    vendorName: e.vendorName,
    vendorQuoteRef: e.vendorQuoteRef,
    description: e.description,
    overrideReason: e.overrideReason,
    note: e.note,
    voidReason: e.voidReason,
    mondayItemId: e.mondayItemId,
    mondayColumnId: e.mondayColumnId,
    mondayReadAt: e.mondayReadAt ? e.mondayReadAt.toISOString() : null,
    appliedAt: e.appliedAt ? e.appliedAt.toISOString() : null,
    qboDocNumber: e.qboDocNumber,
    qboMode: e.qboMode,
    qboPushedAt: e.qboPushedAt ? e.qboPushedAt.toISOString() : null,
    createdAt: e.createdAt.toISOString(),
  };
}

/* ────────────────────────── the queue ────────────────────────── */

export interface QueueRow {
  proposalId: string;
  versionId: string;
  number: string;
  title: string;
  customer: string;
  version: number;
  status: string;
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
  appliedNotPushedMinor: number;
  vendorQuoteRef: string | null;
  hasInvoice: boolean;
  invoicePushed: boolean;
  customerNotified: boolean;
}

/**
 * The freight queue — every job whose freight is outstanding, oldest first.
 *
 * Scoped to the latest RELEASED or ACCEPTED version of each live proposal, which is
 * the set where an unquoted freight bill is real money. Drafts are excluded: their
 * freight is not late, it is unfinished.
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

  const [ctx, orgs, trueUps, entries, invoices] = await Promise.all([
    lineContext(),
    prisma.organization.findMany({
      where: { id: { in: [...new Set(rows.map((v) => v.proposal.organizationId))] } },
      select: { id: true, name: true },
    }),
    prisma.freightTrueUp.findMany({
      where: { versionId: { in: rows.map((v) => v.id) } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.freightEntry.findMany({ where: { versionId: { in: rows.map((v) => v.id) } } }),
    prisma.qboTransaction.findMany({
      where: {
        proposalId: { in: rows.map((v) => v.proposalId) },
        type: 'INVOICE',
        status: 'CREATED',
      },
      select: { proposalId: true },
    }),
  ]);

  const orgName = new Map<string, string>(orgs.map((o) => [o.id, o.name] as [string, string]));
  const invoiced = new Set(invoices.map((i) => i.proposalId));
  const latestTrueUp = new Map<string, FreightTrueUp>();
  for (const t of trueUps) if (!latestTrueUp.has(t.versionId)) latestTrueUp.set(t.versionId, t);
  const entriesByVersion = new Map<string, FreightEntry[]>();
  for (const e of entries) {
    const list = entriesByVersion.get(e.versionId) ?? [];
    list.push(e);
    entriesByVersion.set(e.versionId, list);
  }

  const now = new Date();
  const out: QueueRow[] = [];
  for (const v of rows) {
    const gaps = freightGaps(v.items, v.sections, ctx);
    const mine = entriesByVersion.get(v.id) ?? [];
    const answered = new Set(
      mine.filter((e) => e.status !== 'VOID').map((e) => normalizeBucket(e.bucket)),
    );
    const closed = new Set(
      mine.filter((e) => e.status === 'VOID').map((e) => normalizeBucket(e.bucket)),
    );
    const openBuckets = gaps.buckets.filter((b) => !answered.has(b) && !closed.has(b));
    const staged = mine.filter((e) => e.status === 'STAGED');
    const appliedNotPushed = mine.filter((e) => e.status === 'APPLIED');

    const t = latestTrueUp.get(v.id) ?? null;
    if (!openBuckets.length && !staged.length && !appliedNotPushed.length && !opts.includeSettled)
      continue;

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
      urgency: openBuckets.length ? urgencyFor(ageDays, threshold) : 'NEW',
      totalMinor: versionTotals(v.items, v.sections).total,
      gapBuckets: openBuckets,
      gapLineCount: gaps.gapLines.length,
      vendors: [...new Set(gaps.gapLines.map((l) => l.vendor).filter(Boolean) as string[])],
      trueUpId: t?.id ?? null,
      trueUpStatus: t?.status ?? null,
      stagedMinor: staged.reduce((a, e) => a + e.amountMinor, 0),
      appliedNotPushedMinor: appliedNotPushed.reduce((a, e) => a + e.amountMinor, 0),
      vendorQuoteRef: staged.find((e) => e.vendorQuoteRef)?.vendorQuoteRef ?? null,
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

/* ────────────────────────── the invoice alert ────────────────────────── */

export interface InvoiceAlert {
  severity: 'BILLED_SHORT' | 'WILL_BILL_SHORT';
  proposalId: string;
  versionId: string;
  trueUpId: string | null;
  number: string;
  title: string;
  customer: string;
  docNumber: string | null;
  invoiceTotalMinor: string;
  /** Freight on the proposal that is not on the invoice. */
  unbilledMinor: number;
  outstanding: string[];
  ageDays: number;
  headline: string;
  detail: string;
  acknowledgedAt: string | null;
}

/**
 * Invoices that are short of freight.
 *
 * Two different failures, and they are not equally bad:
 *
 *   BILLED_SHORT     — the freight is known, it is on the proposal, and the invoice
 *                      the customer holds does not include it. This is money Summit
 *                      has decided to charge and then not charged. It is the loud one.
 *   WILL_BILL_SHORT  — an invoice exists and a bucket is still unanswered, so
 *                      whatever the freight turns out to be, it is not on that
 *                      invoice either.
 *
 * The banner these feed can be dismissed for a day at a time and then returns, which
 * is the honest behaviour: the alert stops when the freight is billed or somebody
 * records that none applies, not when it is clicked away.
 */
export async function invoiceAlerts(
  opts: { includeAcknowledged?: boolean; limit?: number } = {},
): Promise<InvoiceAlert[]> {
  const invoices = await prisma.qboTransaction.findMany({
    where: { type: 'INVOICE', status: 'CREATED' },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: {
      proposalId: true,
      proposalVersionId: true,
      qboDocNumber: true,
      amountMinor: true,
      qboTotalMinor: true,
      createdAt: true,
    },
  });
  if (!invoices.length) return [];

  const proposalIds = [...new Set(invoices.map((i) => i.proposalId).filter(Boolean) as string[])];
  const [ctx, proposals, entries, trueUps] = await Promise.all([
    lineContext(),
    prisma.proposal.findMany({
      where: { id: { in: proposalIds }, archivedAt: null },
      select: {
        id: true,
        number: true,
        title: true,
        organizationId: true,
        versions: {
          where: { status: { in: ['RELEASED', 'ACCEPTED'] } },
          orderBy: { version: 'desc' },
          take: 1,
          select: { id: true, items: true, sections: true, releasedAt: true, createdAt: true },
        },
      },
    }),
    prisma.freightEntry.findMany({ where: { proposalId: { in: proposalIds } } }),
    prisma.freightTrueUp.findMany({
      where: { proposalId: { in: proposalIds } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  // Customer names in a second query rather than through a relation include: Proposal
  // holds organizationId, not an Organization relation.
  const orgs = await prisma.organization.findMany({
    where: { id: { in: [...new Set(proposals.map((p) => p.organizationId))] } },
    select: { id: true, name: true },
  });
  const orgName = new Map<string, string>(orgs.map((o) => [o.id, o.name] as [string, string]));

  const invoiceByProposal = new Map<string, (typeof invoices)[number]>();
  for (const i of invoices)
    if (i.proposalId && !invoiceByProposal.has(i.proposalId))
      invoiceByProposal.set(i.proposalId, i);
  const trueUpByVersion = new Map<string, FreightTrueUp>();
  for (const t of trueUps)
    if (!trueUpByVersion.has(t.versionId)) trueUpByVersion.set(t.versionId, t);

  const now = new Date();
  const out: InvoiceAlert[] = [];

  for (const p of proposals) {
    const version = p.versions[0];
    const invoice = invoiceByProposal.get(p.id);
    if (!version || !invoice) continue;

    const mine = entries.filter((e) => e.versionId === version.id);
    const unbilled = mine
      .filter((e) => e.status === 'APPLIED')
      .reduce((a, e) => a + e.amountMinor, 0);
    const gaps = freightGaps(version.items, version.sections, ctx);
    const answered = new Set(
      mine.filter((e) => e.status !== 'VOID').map((e) => normalizeBucket(e.bucket)),
    );
    const closed = new Set(
      mine.filter((e) => e.status === 'VOID').map((e) => normalizeBucket(e.bucket)),
    );
    const openBuckets = gaps.buckets.filter((b) => !answered.has(b) && !closed.has(b));
    if (!unbilled && !openBuckets.length) continue;

    const trueUp = trueUpByVersion.get(version.id) ?? null;
    const quiet = alertIsQuiet(trueUp?.alertAckAt ?? null, now);
    if (quiet && !opts.includeAcknowledged) continue;

    const severity: InvoiceAlert['severity'] = unbilled > 0 ? 'BILLED_SHORT' : 'WILL_BILL_SHORT';
    const dollars = `$${(unbilled / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    out.push({
      severity,
      proposalId: p.id,
      versionId: version.id,
      trueUpId: trueUp?.id ?? null,
      number: p.number,
      title: p.title,
      customer: orgName.get(p.organizationId) ?? '—',
      docNumber: invoice.qboDocNumber,
      invoiceTotalMinor: (invoice.qboTotalMinor ?? invoice.amountMinor).toString(),
      unbilledMinor: unbilled,
      outstanding: openBuckets,
      ageDays: ageInDays(version.releasedAt ?? version.createdAt, now),
      headline:
        severity === 'BILLED_SHORT'
          ? `${p.number}: ${dollars} of freight is on the proposal and not on invoice ${invoice.qboDocNumber ?? '—'}`
          : `${p.number}: invoice ${invoice.qboDocNumber ?? '—'} is out and freight is still outstanding`,
      detail:
        severity === 'BILLED_SHORT'
          ? `Add it to the invoice from the freight panel. ${
              openBuckets.length
                ? `Still waiting on ${describeGaps({ ...gaps, buckets: openBuckets })}.`
                : ''
            }`.trim()
          : `Waiting on ${describeGaps({ ...gaps, buckets: openBuckets })}. Whatever it comes to, it is not on that invoice.`,
      acknowledgedAt: trueUp?.alertAckAt ? trueUp.alertAckAt.toISOString() : null,
    });
  }

  out.sort(
    (a, b) =>
      Number(b.severity === 'BILLED_SHORT') - Number(a.severity === 'BILLED_SHORT') ||
      b.unbilledMinor - a.unbilledMinor ||
      b.ageDays - a.ageDays,
  );
  return out.slice(0, opts.limit ?? 50);
}

/**
 * Quiet one job's banner for a day.
 *
 * Recorded with the actor, because dismissing a notice that an invoice is short of
 * money is a decision somebody made.
 */
export async function acknowledgeAlert(
  versionId: string,
  actorId: string,
): Promise<{ quietUntil: string }> {
  const trueUp = await openTrueUp(versionId, actorId);
  const now = new Date();
  await prisma.freightTrueUp.update({
    where: { id: trueUp.id },
    data: { alertAckAt: now, alertAckById: actorId },
  });
  await recordAudit({
    actorId,
    action: 'freight.alert.acknowledge',
    entity: 'FreightTrueUp',
    entityId: trueUp.id,
    details: { versionId },
  });
  return { quietUntil: new Date(now.getTime() + 24 * 3_600_000).toISOString() };
}

/* ────────────────────────── the gate ────────────────────────── */

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
 * Used to stop an order being closed out and a Bill of Materials being confirmed to a
 * vendor while a freight bill is still unaccounted for. Deliberately NOT used to
 * block accepting the proposal, creating the order or raising the invoice — those are
 * the steps that get manufacturing moving, and the whole point of this feature is
 * that they must not wait on freight.
 */
export async function freightGateStatus(proposalId: string): Promise<FreightGate> {
  const version = await prisma.proposalVersion.findFirst({
    where: { proposalId, status: { in: ['RELEASED', 'ACCEPTED'] } },
    orderBy: { version: 'desc' },
    select: { id: true, items: true, sections: true },
  });
  if (!version)
    return { settled: true, reason: null, proposalId, versionId: null, outstanding: [] };

  const gaps = freightGaps(version.items, version.sections, await lineContext(version.items));
  const { buckets } = await outstandingBuckets(version.id, gaps);
  if (!buckets.length)
    return { settled: true, reason: null, proposalId, versionId: version.id, outstanding: [] };

  return {
    settled: false,
    proposalId,
    versionId: version.id,
    outstanding: buckets,
    reason:
      `This job still has freight outstanding — ${describeGaps({ ...gaps, buckets })}. Enter the vendor's ` +
      `figures (or record that none applies) on the proposal's freight panel first.`,
  };
}

export async function assertFreightSettled(proposalId: string, action: string): Promise<void> {
  const gate = await freightGateStatus(proposalId);
  if (!gate.settled) throw new ConflictError(`${action} ${gate.reason}`);
}
