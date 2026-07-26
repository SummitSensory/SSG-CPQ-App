import { prisma } from '../lib/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import {
  buildContentSnapshot, computeIntegrityHash, depositFromSnapshot,
  defaultRequirements, defaultTasks, procurementFromItems,
  type AcceptedVersionLike, type PriceSnapshotLike,
} from './lock.js';
import { versionTotals, metaOf } from '../proposals/analytics.js';
import { createNewVersion } from '../proposals/service.js';
import { loadFormulaSettings } from '../routes/formulas.js';
import type {
  RequirementCategory, RequirementStatus, HandoffTaskStatus, HandoffStatus,
  CustomerApprovalMethod, Role,
} from '@prisma/client';

/** Allocate the next sequential sales-order number for the current year. */
async function nextOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `SO-${year}-`;
  const last = await prisma.acceptedOrder.findFirst({ where: { number: { startsWith: prefix } }, orderBy: { number: 'desc' }, select: { number: true } });
  const seq = last ? parseInt(last.number.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(6, '0')}`;
}

export interface CustomerApprovalInput {
  method: CustomerApprovalMethod;
  approverName: string;
  approverTitle?: string;
  approverEmail?: string;
  poNumber?: string;
  documentRef?: string;
  ipAddress?: string;
  approvedAt: Date;
  notes?: string;
}

/**
 * Lock an ACCEPTED proposal version into an immutable operational order. The
 * order snapshots the exact accepted content + price snapshot and an integrity
 * hash, then seeds the handoff scaffold (requirements, procurement, tasks).
 * Idempotent: a version already locked returns its existing order.
 */
/**
 * Freeze the accepted proposal content into a PriceSnapshot. Uses the same math
 * as the builder and the reports (`versionTotals`), so the order's grand total can
 * never disagree with the proposal the customer signed.
 */
async function snapshotAcceptedContent(versionId: string, sections: unknown, items: unknown, userId: string) {
  const t = versionTotals(items, sections);
  const meta = metaOf(sections);
  // Deposit percentage is a business number (Administration → Formulas).
  const settings = await loadFormulaSettings();
  const depositPct = settings.depositPct;
  const deposit = Math.round((t.total * depositPct) / 100);
  return prisma.priceSnapshot.create({
    data: {
      subjectRef: `proposalVersion:${versionId}`,
      currency: 'USD',
      engineVersion: 'proposal-builder-1',
      input: { proposalVersionId: versionId, meta } as object,
      breakdown: {
        subtotalMinor: t.subtotal,
        discountMinor: t.discount,
        thirdPartyFreightMinor: t.tpFreight,
        taxMinor: t.tax,
        structureFreightMinor: t.structureFreight,
        matsFreightMinor: t.matsFreight,
        cogsMinor: t.cogs,
        marginMinor: t.margin,
        weightLbs: t.weight,
        payment: { deposit, depositPct, balanceDueMinor: t.total - deposit },
      } as object,
      grandTotal: BigInt(t.total),
      createdById: userId,
    },
  });
}

/**
 * Resolve the supplying vendor for procurement lines. Three keys, in order of
 * confidence: the line's productId, its part number, and — for generated frame /
 * adventure lines that carry neither — an exact match on the catalog name
 * (Product.name or Sku.description). The vendor itself comes from the product's
 * sourcing record (primary Manufacturer) or the SKU master's manufacturer column,
 * which is the same field the Catalog screen edits.
 */
export async function resolveVendors(
  lines: Array<{ productId?: string | null; sku?: string | null; name?: string | null }>,
): Promise<(string | null)[]> {
  const productIds = [...new Set(lines.map((l) => l.productId).filter((v): v is string => !!v))];
  const parts = [...new Set(lines.map((l) => l.sku).filter((v): v is string => !!v))];
  const names = [...new Set(lines.map((l) => (l.name || '').trim()).filter(Boolean))];
  if (!productIds.length && !parts.length && !names.length) return lines.map(() => null);

  const [products, skus] = await Promise.all([
    prisma.product.findMany({
      where: { OR: [{ id: { in: productIds } }, { sku: { in: parts } }, { name: { in: names } }] },
      select: { id: true, sku: true, name: true, sourcing: { select: { isPrimary: true, manufacturer: { select: { name: true } } } } },
    }),
    prisma.sku.findMany({
      where: { OR: [{ part: { in: parts } }, { description: { in: names } }] },
      select: { part: true, description: true, manufacturer: true },
    }),
  ]);

  const vendorOf = (p: (typeof products)[number]): string | null => {
    const s = p.sourcing.find((x) => x.isPrimary) ?? p.sourcing[0];
    return s?.manufacturer?.name ?? null;
  };
  const byId = new Map(products.map((p) => [p.id, vendorOf(p)]));
  const byPart = new Map<string, string | null>();
  const byName = new Map<string, string | null>();
  for (const p of products) {
    if (p.sku && !byPart.get(p.sku)) byPart.set(p.sku, vendorOf(p));
    if (p.name && !byName.get(p.name)) byName.set(p.name, vendorOf(p));
  }
  for (const s of skus) {
    if (s.manufacturer) {
      if (!byPart.get(s.part)) byPart.set(s.part, s.manufacturer);
      if (s.description && !byName.get(s.description)) byName.set(s.description, s.manufacturer);
    }
  }

  return lines.map(
    (l) =>
      (l.productId ? byId.get(l.productId) : null) ||
      (l.sku ? byPart.get(l.sku) : null) ||
      byName.get((l.name || '').trim()) ||
      null,
  );
}

/**
 * Fill in vendors on lines locked before vendor resolution existed (or before the
 * part was given a manufacturer in the catalog). Idempotent and only ever writes
 * a line whose vendor is still blank — an operator's manual override is never
 * overwritten.
 */
async function backfillVendors(orderId: string): Promise<void> {
  const blanks = await prisma.procurementLine.findMany({ where: { orderId, vendor: null }, select: { id: true, productId: true, sku: true, name: true } });
  if (!blanks.length) return;
  const vendors = await resolveVendors(blanks);
  await Promise.all(
    blanks.map((l, i) => (vendors[i] ? prisma.procurementLine.update({ where: { id: l.id }, data: { vendor: vendors[i] } }) : null)).filter(Boolean) as Promise<unknown>[],
  );
}

export async function createAcceptedOrder(versionId: string, approval: CustomerApprovalInput, userId: string) {
  if (!approval?.approverName?.trim()) throw new ValidationError('Customer approver name is required');

  const existing = await prisma.acceptedOrder.findUnique({ where: { proposalVersionId: versionId } });
  if (existing) return existing;

  const version = await prisma.proposalVersion.findUnique({ where: { id: versionId }, include: { proposal: true } });
  if (!version) throw new NotFoundError('Proposal version not found');
  if (version.status !== 'ACCEPTED') throw new ConflictError('Only an ACCEPTED proposal version can be locked into an order');

  // Proposals built in the builder carry their priced content on the version
  // itself rather than through the pricing engine, so an accepted version often
  // has no PriceSnapshot yet. Freeze one from the accepted content at lock time —
  // that snapshot is the price of record the order and its integrity hash use.
  const snap = version.priceSnapshotId
    ? await prisma.priceSnapshot.findUnique({ where: { id: version.priceSnapshotId } })
    : await snapshotAcceptedContent(version.id, version.sections, version.items, userId);
  if (!snap) throw new NotFoundError('Price snapshot not found');
  if (!version.priceSnapshotId) {
    await prisma.proposalVersion.update({ where: { id: version.id }, data: { priceSnapshotId: snap.id } });
  }

  const vLike: AcceptedVersionLike = { id: version.id, version: version.version, proposalId: version.proposalId, sections: version.sections, items: version.items, priceSnapshotId: snap.id, status: version.status, frozen: version.frozen };
  const sLike: PriceSnapshotLike = { id: snap.id, currency: snap.currency, grandTotal: snap.grandTotal, breakdown: snap.breakdown };
  const contentSnapshot = buildContentSnapshot(vLike, sLike);
  const integrityHash = computeIntegrityHash(contentSnapshot);
  const depositDue = depositFromSnapshot(sLike);
  const number = await nextOrderNumber();
  const procurement = procurementFromItems(version.items);
  const vendors = await resolveVendors(procurement);

  const order = await prisma.$transaction(async (tx) => {
    const o = await tx.acceptedOrder.create({
      data: {
        number,
        organizationId: version.proposal.organizationId,
        proposalId: version.proposalId,
        proposalVersionId: version.id,
        acceptedVersion: version.version,
        priceSnapshotId: snap.id,
        ruleSnapshotId: version.ruleSnapshotId,
        currency: snap.currency,
        grandTotalMinor: snap.grandTotal,
        depositRequired: depositDue > 0n,
        depositDueMinor: depositDue,
        contentSnapshot: contentSnapshot as object,
        integrityHash,
        acceptedById: userId,
        customerApproval: {
          create: {
            method: approval.method, approverName: approval.approverName,
            approverTitle: approval.approverTitle ?? null, approverEmail: approval.approverEmail ?? null,
            poNumber: approval.poNumber ?? null, documentRef: approval.documentRef ?? null,
            ipAddress: approval.ipAddress ?? null, approvedAt: approval.approvedAt, notes: approval.notes ?? null,
            recordedById: userId,
          },
        },
        requirements: { create: defaultRequirements().map((r) => ({ category: r.category as RequirementCategory, title: r.title, createdById: userId })) },
        procurement: { create: procurement.map((p, i) => ({ productId: p.productId, sku: p.sku, name: p.name, quantity: p.quantity, vendor: vendors[i] })) },
        tasks: { create: defaultTasks(depositDue > 0n).map((t) => ({ title: t.title, assigneeRole: (t.assigneeRole as Role) ?? null, category: (t.category as RequirementCategory) ?? null, createdById: userId })) },
        events: { create: { action: 'order.locked', actorId: userId, detail: { number, acceptedVersion: version.version, integrityHash } as object } },
      },
    });
    return o;
  });

  await recordAudit({ actorId: userId, action: 'order.lock', entity: 'AcceptedOrder', entityId: order.id, details: { number, proposalVersionId: version.id, integrityHash } });
  return order;
}

/** The order locked from a given proposal version, if there is one. */
export async function orderForVersion(versionId: string) {
  const o = await prisma.acceptedOrder.findUnique({
    where: { proposalVersionId: versionId },
    select: { id: true, number: true, status: true, acceptedVersion: true },
  });
  return o ?? null;
}

/**
 * Unlock an order so a last-minute customer change can be made. The locked order
 * is never deleted — it is CANCELLED, with the reason on the order's audit
 * timeline — and a fresh DRAFT proposal version is cloned from the accepted
 * content for the edit. The accepted version itself stays frozen as the record of
 * what was signed.
 */
export async function unlockOrder(
  orderId: string,
  opts: { reason: string; createRevision?: boolean },
  userId: string,
) {
  const reason = (opts.reason || '').trim();
  if (!reason) throw new ValidationError('A reason is required to unlock an order');

  const order = await prisma.acceptedOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError('Order not found');
  if (order.status === 'CANCELLED') throw new ConflictError('This order has already been unlocked');
  if (order.status === 'COMPLETE') throw new ConflictError('A completed order cannot be unlocked — raise a new proposal for the change');

  // A financial document already exists in QuickBooks: that has to be voided
  // there first, or the books and the order would disagree.
  const live = await prisma.qboTransaction.findFirst({
    where: { proposalId: order.proposalId, status: 'CREATED' },
    orderBy: { createdAt: 'desc' },
  });
  if (live) {
    const doc = live.qboDocNumber || live.qboId || 'created';
    throw new ConflictError(`A QuickBooks ${live.type.toLowerCase().replace(/_/g, ' ')} (${doc}) exists for this order. Void it in QuickBooks before unlocking.`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.acceptedOrder.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });
    await tx.orderEvent.create({
      data: { orderId, action: 'order.unlocked', actorId: userId, detail: { reason, previousStatus: order.status } as object },
    });
  });
  await recordAudit({
    actorId: userId, action: 'order.unlock', entity: 'AcceptedOrder', entityId: orderId,
    details: { number: order.number, reason, proposalVersionId: order.proposalVersionId },
  });

  // A new editable version is the point of unlocking; skip it only when the caller
  // just wants the order cancelled.
  const revision = opts.createRevision === false ? null : await createNewVersion(order.proposalId, userId);
  return { orderId, number: order.number, status: 'CANCELLED' as const, proposalId: order.proposalId, revision };
}

export async function getOrder(id: string) {
  await backfillVendors(id);
  const order = await prisma.acceptedOrder.findUnique({
    where: { id },
    include: { customerApproval: true, requirements: true, procurement: true, tasks: true, events: { orderBy: { createdAt: 'asc' } } },
  });
  if (!order) throw new NotFoundError('Order not found');
  return order;
}

/**
 * Orders list. Each row carries the fields the list view can show as columns —
 * customer and signed date lead, the rest are opt-in from the column picker — so
 * the client never has to fan out a request per order to label a row.
 */
export async function listOrders(filter: { status?: HandoffStatus; organizationId?: string } = {}) {
  const rows = await prisma.acceptedOrder.findMany({
    where: { ...(filter.status ? { status: filter.status } : {}), ...(filter.organizationId ? { organizationId: filter.organizationId } : {}) },
    orderBy: { createdAt: 'desc' }, take: 200,
    include: {
      customerApproval: true,
      tasks: { select: { status: true } },
      requirements: { select: { status: true } },
      procurement: { select: { sourced: true } },
    },
  });

  const orgIds = [...new Set(rows.map((r) => r.organizationId))];
  const proposalIds = [...new Set(rows.map((r) => r.proposalId))];
  const [orgs, proposals] = await Promise.all([
    prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }),
    prisma.proposal.findMany({ where: { id: { in: proposalIds } }, select: { id: true, number: true, title: true } }),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const prop = new Map(proposals.map((p) => [p.id, p]));

  return rows.map(({ customerApproval, tasks, requirements, procurement, ...o }) => {
    const p = prop.get(o.proposalId);
    return {
      ...o,
      customer: orgName.get(o.organizationId) ?? null,
      signedAt: customerApproval?.approvedAt ?? null,
      approvedBy: customerApproval?.approverName ?? null,
      approvalMethod: customerApproval?.method ?? null,
      poNumber: customerApproval?.poNumber ?? null,
      proposalNumber: p?.number ?? null,
      proposalTitle: p?.title ?? null,
      balanceDueMinor: (o.grandTotalMinor - o.depositDueMinor).toString(),
      openTasks: tasks.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED').length,
      taskCount: tasks.length,
      openRequirements: requirements.filter((r) => r.status !== 'COMPLETE' && r.status !== 'WAIVED').length,
      requirementCount: requirements.length,
      procurementCount: procurement.length,
      procurementSourced: procurement.filter((l) => l.sourced).length,
    };
  });
}

async function logEvent(orderId: string, action: string, actorId: string, detail?: Record<string, unknown>) {
  await prisma.orderEvent.create({ data: { orderId, action, actorId, detail: (detail ?? {}) as object } });
}

/**
 * Re-verify that the order still matches the accepted proposal version. Detects
 * (defense in depth) any drift between the frozen snapshot and the live version.
 * The order total NEVER changes — this proves it.
 */
export async function verifyIntegrity(orderId: string) {
  const order = await prisma.acceptedOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError('Order not found');
  const version = await prisma.proposalVersion.findUnique({ where: { id: order.proposalVersionId } });
  const snap = order.priceSnapshotId ? await prisma.priceSnapshot.findUnique({ where: { id: order.priceSnapshotId } }) : null;
  if (!version || !snap) return { ok: false, reason: 'referenced version or snapshot missing', storedHash: order.integrityHash };

  const rebuilt = computeIntegrityHash(buildContentSnapshot(
    { id: version.id, version: version.version, proposalId: version.proposalId, sections: version.sections, items: version.items, priceSnapshotId: version.priceSnapshotId, status: version.status, frozen: version.frozen },
    { id: snap.id, currency: snap.currency, grandTotal: snap.grandTotal, breakdown: snap.breakdown },
  ));
  const ok = rebuilt === order.integrityHash && snap.grandTotal === order.grandTotalMinor;
  return { ok, storedHash: order.integrityHash, currentHash: rebuilt, totalMatches: snap.grandTotal === order.grandTotalMinor };
}

// ---- Handoff sub-record management (operational data is mutable; the locked financial snapshot is not) ----

export async function addRequirement(orderId: string, input: { category: RequirementCategory; title: string; detail?: Record<string, unknown>; targetDate?: Date }, userId: string) {
  await getOrder(orderId);
  const r = await prisma.handoffRequirement.create({ data: { orderId, category: input.category, title: input.title, detail: (input.detail ?? {}) as object, targetDate: input.targetDate ?? null, createdById: userId } });
  await logEvent(orderId, 'requirement.add', userId, { requirementId: r.id, category: input.category });
  return r;
}

export async function updateRequirement(id: string, patch: { status?: RequirementStatus; targetDate?: Date | null; detail?: Record<string, unknown>; isException?: boolean; exceptionReason?: string }, userId: string) {
  const existing = await prisma.handoffRequirement.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Requirement not found');
  if (patch.isException && !patch.exceptionReason?.trim()) throw new ValidationError('An exception requires a reason');
  const r = await prisma.handoffRequirement.update({ where: { id }, data: {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.targetDate !== undefined ? { targetDate: patch.targetDate } : {}),
    ...(patch.detail ? { detail: patch.detail as object } : {}),
    ...(patch.isException !== undefined ? { isException: patch.isException, exceptionReason: patch.exceptionReason ?? null } : {}),
  } });
  await logEvent(existing.orderId, 'requirement.update', userId, { requirementId: id, ...patch });
  await recomputeStatus(existing.orderId, userId);
  return r;
}

export async function addTask(orderId: string, input: { title: string; description?: string; category?: RequirementCategory; assigneeId?: string; assigneeRole?: Role; dueDate?: Date }, userId: string) {
  await getOrder(orderId);
  const t = await prisma.handoffTask.create({ data: { orderId, title: input.title, description: input.description ?? null, category: input.category ?? null, assigneeId: input.assigneeId ?? null, assigneeRole: input.assigneeRole ?? null, dueDate: input.dueDate ?? null, createdById: userId } });
  await logEvent(orderId, 'task.add', userId, { taskId: t.id, title: input.title });
  return t;
}

export async function updateTask(id: string, patch: { status?: HandoffTaskStatus; assigneeId?: string | null; assigneeRole?: Role | null; dueDate?: Date | null; isException?: boolean; exceptionReason?: string }, userId: string) {
  const existing = await prisma.handoffTask.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Task not found');
  if (patch.isException && !patch.exceptionReason?.trim()) throw new ValidationError('An exception requires a reason');
  const t = await prisma.handoffTask.update({ where: { id }, data: {
    ...(patch.status ? { status: patch.status, ...(patch.status === 'DONE' ? { completedAt: new Date() } : {}) } : {}),
    ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
    ...(patch.assigneeRole !== undefined ? { assigneeRole: patch.assigneeRole } : {}),
    ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
    ...(patch.isException !== undefined ? { isException: patch.isException, exceptionReason: patch.exceptionReason ?? null } : {}),
  } });
  await logEvent(existing.orderId, 'task.update', userId, { taskId: id, ...patch });
  await recomputeStatus(existing.orderId, userId);
  return t;
}

export async function upsertProcurementLine(orderId: string, input: { id?: string; productId?: string; sku?: string; name: string; quantity: number; vendor?: string; poNumber?: string; sourced?: boolean; targetDate?: Date; notes?: string; isException?: boolean; exceptionReason?: string }, userId: string) {
  await getOrder(orderId);
  const data = { orderId, productId: input.productId ?? null, sku: input.sku ?? null, name: input.name, quantity: input.quantity, vendor: input.vendor ?? null, poNumber: input.poNumber ?? null, sourced: input.sourced ?? false, targetDate: input.targetDate ?? null, notes: input.notes ?? null, isException: input.isException ?? false, exceptionReason: input.exceptionReason ?? null };
  const line = input.id
    ? await prisma.procurementLine.update({ where: { id: input.id }, data })
    : await prisma.procurementLine.create({ data });
  await logEvent(orderId, input.id ? 'procurement.update' : 'procurement.add', userId, { lineId: line.id });
  return line;
}

/** Link integration outputs (QuickBooks estimate txn, monday project) to the order. */
export async function recordIntegrationRef(orderId: string, refs: { qboEstimateTxnId?: string; mondayProjectId?: string }, userId: string) {
  await getOrder(orderId);
  const order = await prisma.acceptedOrder.update({ where: { id: orderId }, data: { ...(refs.qboEstimateTxnId ? { qboEstimateTxnId: refs.qboEstimateTxnId } : {}), ...(refs.mondayProjectId ? { mondayProjectId: refs.mondayProjectId } : {}) } });
  await logEvent(orderId, 'integration.link', userId, refs);
  return order;
}

/** Derive the overall handoff status from tasks + requirements. */
async function recomputeStatus(orderId: string, userId: string): Promise<HandoffStatus> {
  const [tasks, reqs, order] = await Promise.all([
    prisma.handoffTask.findMany({ where: { orderId } }),
    prisma.handoffRequirement.findMany({ where: { orderId } }),
    prisma.acceptedOrder.findUnique({ where: { id: orderId } }),
  ]);
  if (order?.status === 'CANCELLED') return 'CANCELLED';

  const openTasks = tasks.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED');
  const openReqs = reqs.filter((r) => r.status !== 'COMPLETE' && r.status !== 'WAIVED');
  const anyBlocked = tasks.some((t) => t.status === 'BLOCKED') || reqs.some((r) => r.status === 'BLOCKED');
  const anyProgress = tasks.some((t) => t.status !== 'TODO') || reqs.some((r) => r.status !== 'OPEN');

  let next: HandoffStatus;
  if (openTasks.length === 0 && openReqs.length === 0) next = 'COMPLETE';
  else if (anyBlocked) next = 'BLOCKED';
  else if (anyProgress) next = 'IN_PROGRESS';
  else next = 'NEW';

  if (order && order.status !== next) {
    await prisma.acceptedOrder.update({ where: { id: orderId }, data: { status: next } });
    await logEvent(orderId, 'status.change', userId, { from: order.status, to: next });
  }
  return next;
}

/** Handoff-status report: rollups, open exceptions, deposit + integration + integrity. */
export async function handoffStatus(orderId: string) {
  const order = await getOrder(orderId);
  const byStatus = <T extends { status: string }>(rows: T[]) => rows.reduce<Record<string, number>>((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {});
  const integrity = await verifyIntegrity(orderId);

  const exceptions = [
    ...order.requirements.filter((r) => r.isException).map((r) => ({ kind: 'requirement', id: r.id, category: r.category, reason: r.exceptionReason })),
    ...order.tasks.filter((t) => t.isException).map((t) => ({ kind: 'task', id: t.id, title: t.title, reason: t.exceptionReason })),
    ...order.procurement.filter((p) => p.isException).map((p) => ({ kind: 'procurement', id: p.id, name: p.name, reason: p.exceptionReason })),
  ];

  return {
    orderId: order.id,
    number: order.number,
    status: order.status,
    locked: order.locked,
    acceptedVersion: order.acceptedVersion,
    proposalVersionId: order.proposalVersionId,
    priceSnapshotId: order.priceSnapshotId,
    grandTotalMinor: order.grandTotalMinor.toString(),
    deposit: { required: order.depositRequired, dueMinor: order.depositDueMinor.toString() },
    customerApproval: order.customerApproval ? { method: order.customerApproval.method, approverName: order.customerApproval.approverName, approvedAt: order.customerApproval.approvedAt.toISOString(), poNumber: order.customerApproval.poNumber } : null,
    tasks: { total: order.tasks.length, byStatus: byStatus(order.tasks) },
    requirements: { total: order.requirements.length, byStatus: byStatus(order.requirements) },
    procurement: { total: order.procurement.length, sourced: order.procurement.filter((p) => p.sourced).length },
    exceptions,
    exceptionCount: exceptions.length,
    integrations: { qboEstimateTxnId: order.qboEstimateTxnId, mondayProjectId: order.mondayProjectId },
    integrity,
  };
}

/** Full order audit timeline (order-scoped events, chronological). */
export async function orderAudit(orderId: string) {
  await getOrder(orderId);
  const events = await prisma.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
  return events.map((e) => ({ action: e.action, actorId: e.actorId, detail: e.detail, at: e.createdAt.toISOString() }));
}
