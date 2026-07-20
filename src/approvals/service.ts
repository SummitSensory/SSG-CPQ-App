import { prisma } from '../lib/prisma.js';
import { ConflictError, ForbiddenError, ValidationError, NotFoundError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { can } from '../authz/rbac.js';
import type { Role } from '../authz/permissions.js';
import { approverPermissionFor, canDecide, DEFAULT_EXPIRY_HOURS } from './policy.js';
import { notifier } from './notify.js';
import type { ApprovalType, ApprovalStatus } from '@prisma/client';

interface CreateInput {
  type: ApprovalType;
  reason: string;
  requestedValue: string;
  originalValue?: string;
  supportingInfo?: Record<string, unknown>;
  subjectRef?: string;
  proposalId?: string;
  proposalVersion?: number;
  expiryHours?: number;
}

export async function createRequest(input: CreateInput, requesterId: string): Promise<{ id: string }> {
  if (!input.reason?.trim()) throw new ValidationError('A reason is required');
  if (!input.requestedValue?.trim()) throw new ValidationError('A requested value is required');
  const expiresAt = new Date(Date.now() + (input.expiryHours ?? DEFAULT_EXPIRY_HOURS) * 3600 * 1000);

  const req = await prisma.approvalRequest.create({
    data: {
      type: input.type, status: 'PENDING',
      reason: input.reason, requestedValue: input.requestedValue,
      originalValue: input.originalValue ?? null,
      supportingInfo: (input.supportingInfo ?? {}) as object,
      subjectRef: input.subjectRef ?? null,
      proposalId: input.proposalId ?? null, proposalVersion: input.proposalVersion ?? null,
      requesterId, expiresAt,
    },
  });
  await prisma.approvalEvent.create({ data: { requestId: req.id, action: 'requested', actorId: requesterId } });
  await recordAudit({ actorId: requesterId, action: 'approval.request', entity: 'ApprovalRequest', entityId: req.id, details: { type: input.type } });
  await notifier.send({ event: 'requested', requestId: req.id, type: input.type, recipientIds: [], message: `New ${input.type} approval requested` });
  return { id: req.id };
}

/** Active delegate user ids for a given approval type (standing delegations). */
export async function activeDelegateIds(type: ApprovalType, at: Date = new Date()): Promise<string[]> {
  const dels = await prisma.approvalDelegation.findMany({
    where: {
      OR: [{ type }, { type: null }],
      startsAt: { lte: at },
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: at } }] }],
    },
    select: { toUserId: true },
  });
  return dels.map((d) => d.toUserId);
}

async function loadOpen(requestId: string) {
  const req = await prisma.approvalRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new NotFoundError('Approval request not found');
  if (req.status !== 'PENDING' && req.status !== 'ESCALATED' && req.status !== 'REVISION_REQUESTED') {
    throw new ConflictError(`Request is ${req.status}; no further decision allowed`);
  }
  if (req.expiresAt < new Date()) throw new ConflictError('Request has expired');
  return req;
}

interface DeciderCtx { userId: string; role: Role }

/** Shared guard: enforces permission, delegation, self-approval and separation of duties. */
async function assertCanDecide(req: { type: ApprovalType; requesterId: string }, ctx: DeciderCtx): Promise<void> {
  const perm = approverPermissionFor(req.type);
  const delegates = await activeDelegateIds(req.type);
  const guard = canDecide({
    type: req.type,
    requesterId: req.requesterId,
    deciderId: ctx.userId,
    deciderHasPermission: can(ctx.role, perm),
    delegatedApproverIds: delegates,
  });
  if (!guard.allowed) throw new ForbiddenError(guard.reason ?? 'not permitted to decide');
}

async function decide(requestId: string, decision: ApprovalStatus, ctx: DeciderCtx, notes?: string): Promise<void> {
  const req = await loadOpen(requestId);
  await assertCanDecide(req, ctx);
  await prisma.$transaction(async (tx) => {
    await tx.approvalRequest.update({
      where: { id: requestId },
      data: { status: decision, decision, decisionNotes: notes ?? null, approverId: ctx.userId, decidedAt: new Date() },
    });
    await tx.approvalEvent.create({ data: { requestId, action: decision.toLowerCase(), actorId: ctx.userId, notes: notes ?? null } });
  });
  await recordAudit({ actorId: ctx.userId, action: 'approval.decision', entity: 'ApprovalRequest', entityId: requestId, details: { decision } });
}

export async function approve(requestId: string, ctx: DeciderCtx, notes?: string): Promise<void> {
  await decide(requestId, 'APPROVED', ctx, notes);
  const req = await prisma.approvalRequest.findUnique({ where: { id: requestId } });
  await notifier.send({ event: 'approved', requestId, type: String(req?.type), recipientIds: req ? [req.requesterId] : [], message: 'Approval granted' });
}

export async function reject(requestId: string, ctx: DeciderCtx, notes?: string): Promise<void> {
  await decide(requestId, 'REJECTED', ctx, notes);
  const req = await prisma.approvalRequest.findUnique({ where: { id: requestId } });
  await notifier.send({ event: 'rejected', requestId, type: String(req?.type), recipientIds: req ? [req.requesterId] : [], message: 'Approval rejected' });
}

/** Request a revision — returns the request to the requester, still open. */
export async function requestRevision(requestId: string, ctx: DeciderCtx, notes: string): Promise<void> {
  const req = await loadOpen(requestId);
  await assertCanDecide(req, ctx);
  if (!notes?.trim()) throw new ValidationError('Revision request needs notes explaining what to change');
  await prisma.$transaction(async (tx) => {
    await tx.approvalRequest.update({ where: { id: requestId }, data: { status: 'REVISION_REQUESTED', decisionNotes: notes, approverId: ctx.userId } });
    await tx.approvalEvent.create({ data: { requestId, action: 'revision_requested', actorId: ctx.userId, notes } });
  });
  await recordAudit({ actorId: ctx.userId, action: 'approval.revision', entity: 'ApprovalRequest', entityId: requestId });
  await notifier.send({ event: 'revision_requested', requestId, type: String(req.type), recipientIds: [req.requesterId], message: 'Revision requested' });
}

/** Escalate to a higher approver. Anyone who can currently decide may escalate. */
export async function escalate(requestId: string, ctx: DeciderCtx, toUserId: string, notes?: string): Promise<void> {
  const req = await loadOpen(requestId);
  await assertCanDecide(req, ctx);
  await prisma.$transaction(async (tx) => {
    await tx.approvalRequest.update({ where: { id: requestId }, data: { status: 'ESCALATED', escalatedToId: toUserId } });
    await tx.approvalEvent.create({ data: { requestId, action: 'escalated', actorId: ctx.userId, notes: notes ?? null } });
  });
  await recordAudit({ actorId: ctx.userId, action: 'approval.escalate', entity: 'ApprovalRequest', entityId: requestId, details: { toUserId } });
  await notifier.send({ event: 'escalated', requestId, type: String(req.type), recipientIds: [toUserId], message: 'Approval escalated to you' });
}

/** Sweep expired open requests (call from a scheduled job). */
export async function expireOverdue(now: Date = new Date()): Promise<number> {
  const overdue = await prisma.approvalRequest.findMany({
    where: { status: { in: ['PENDING', 'ESCALATED', 'REVISION_REQUESTED'] }, expiresAt: { lt: now } },
    select: { id: true, requesterId: true, type: true },
  });
  for (const r of overdue) {
    await prisma.approvalRequest.update({ where: { id: r.id }, data: { status: 'EXPIRED' } });
    await prisma.approvalEvent.create({ data: { requestId: r.id, action: 'expired', actorId: 'system' } });
    await notifier.send({ event: 'expired', requestId: r.id, type: String(r.type), recipientIds: [r.requesterId], message: 'Approval request expired' });
  }
  return overdue.length;
}

/** Queue: open requests the given user is allowed to act on (by permission or delegation). */
export async function queueFor(ctx: DeciderCtx): Promise<unknown[]> {
  const open = await prisma.approvalRequest.findMany({
    where: { status: { in: ['PENDING', 'ESCALATED', 'REVISION_REQUESTED'] } },
    orderBy: { createdAt: 'asc' },
  });
  const result: unknown[] = [];
  for (const req of open) {
    const guard = canDecide({
      type: req.type, requesterId: req.requesterId, deciderId: ctx.userId,
      deciderHasPermission: can(ctx.role, approverPermissionFor(req.type)),
      delegatedApproverIds: await activeDelegateIds(req.type),
    });
    if (guard.allowed) result.push(req);
  }
  return result;
}

export async function createDelegation(fromUserId: string, toUserId: string, type: ApprovalType | null, endsAt: Date | null, createdById: string): Promise<{ id: string }> {
  if (fromUserId === toUserId) throw new ValidationError('Cannot delegate to yourself');
  const d = await prisma.approvalDelegation.create({ data: { fromUserId, toUserId, type, endsAt, createdById } });
  await recordAudit({ actorId: createdById, action: 'approval.delegate', entity: 'ApprovalDelegation', entityId: d.id, details: { fromUserId, toUserId, type } });
  return { id: d.id };
}
