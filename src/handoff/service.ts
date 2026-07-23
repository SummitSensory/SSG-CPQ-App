import { prisma } from '../lib/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import {
  buildContentSnapshot, computeIntegrityHash, depositFromSnapshot,
  defaultRequirements, defaultTasks, procurementFromItems,
  type AcceptedVersionLike, type PriceSnapshotLike,
} from './lock.js';
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
export async function createAcceptedOrder(versionId: string, approval: CustomerApprovalInput, userId: string) {
  if (!approval?.approverName?.trim()) throw new ValidationError('Customer approver name is required');

  const existing = await prisma.acceptedOrder.findUnique({ where: { proposalVersionId: versionId } });
  if (existing) return existing;

  const version = await prisma.proposalVersion.findUnique({ where: { id: versionId }, include: { proposal: true } });
  if (!version) throw new NotFoundError('Proposal version not found');
  if (version.status !== 'ACCEPTED') throw new ConflictError('Only an ACCEPTED proposal version can be locked into an order');
  if (!version.priceSnapshotId) throw new ConflictError('Accepted version has no price snapshot to lock');

  const snap = await prisma.priceSnapshot.findUnique({ where: { id: version.priceSnapshotId } });
  if (!snap) throw new NotFoundError('Price snapshot not found');

  const vLike: AcceptedVersionLike = { id: version.id, version: version.version, proposalId: version.proposalId, sections: version.sections, items: version.items, priceSnapshotId: version.priceSnapshotId, status: version.status, frozen: version.frozen };
  const sLike: PriceSnapshotLike = { id: snap.id, currency: snap.currency, grandTotal: snap.grandTotal, breakdown: snap.breakdown };
  const contentSnapshot = buildContentSnapshot(vLike, sLike);
  const integrityHash = computeIntegrityHash(contentSnapshot);
  const depositDue = depositFromSnapshot(sLike);
  const number = await nextOrderNumber();

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
        procurement: { create: procurementFromItems(version.items).map((p) => ({ productId: p.productId, name: p.name, quantity: p.quantity })) },
        tasks: { create: defaultTasks(depositDue > 0n).map((t) => ({ title: t.title, assigneeRole: (t.assigneeRole as Role) ?? null, category: (t.category as RequirementCategory) ?? null, createdById: userId })) },
        events: { create: { action: 'order.locked', actorId: userId, detail: { number, acceptedVersion: version.version, integrityHash } as object } },
      },
    });
    return o;
  });

  await recordAudit({ actorId: userId, action: 'order.lock', entity: 'AcceptedOrder', entityId: order.id, details: { number, proposalVersionId: version.id, integrityHash } });
  return order;
}

export async function getOrder(id: string) {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id },
    include: { customerApproval: true, requirements: true, procurement: true, tasks: true, events: { orderBy: { createdAt: 'asc' } } },
  });
  if (!order) throw new NotFoundError('Order not found');
  return order;
}

export async function listOrders(filter: { status?: HandoffStatus; organizationId?: string } = {}) {
  return prisma.acceptedOrder.findMany({
    where: { ...(filter.status ? { status: filter.status } : {}), ...(filter.organizationId ? { organizationId: filter.organizationId } : {}) },
    orderBy: { createdAt: 'desc' }, take: 200,
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
