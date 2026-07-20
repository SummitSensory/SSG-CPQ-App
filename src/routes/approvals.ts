import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../plugins/authz.js';
import { ValidationError } from '../lib/errors.js';
import { APPROVAL_TYPES } from '../approvals/policy.js';
import {
  createRequest, approve, reject, requestRevision, escalate, queueFor, createDelegation,
} from '../approvals/service.js';

const CreateSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  reason: z.string().min(1),
  requestedValue: z.string().min(1),
  originalValue: z.string().optional(),
  supportingInfo: z.record(z.unknown()).optional(),
  subjectRef: z.string().optional(),
  proposalId: z.string().optional(),
  proposalVersion: z.number().int().optional(),
  expiryHours: z.number().int().positive().max(720).optional(),
});

export function registerApprovalRoutes(app: FastifyInstance): void {
  // All approval endpoints require an authenticated principal; fine-grained
  // authority is enforced in the service (permission + delegation + SoD).
  const auth = { preHandler: requireAuth };

  app.post('/approvals', auth, async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const result = await createRequest(parsed.data, req.user!.sub);
    return reply.status(201).send(result);
  });

  // My requests (as requester).
  app.get('/approvals/mine', auth, async (req) =>
    prisma.approvalRequest.findMany({ where: { requesterId: req.user!.sub }, orderBy: { createdAt: 'desc' } }),
  );

  // Approval queue — only requests this user may act on.
  app.get('/approvals/queue', auth, async (req) => queueFor({ userId: req.user!.sub, role: req.user!.role }));

  app.get('/approvals/:id', auth, async (req) => {
    const { id } = req.params as { id: string };
    return prisma.approvalRequest.findUnique({ where: { id }, include: { events: { orderBy: { createdAt: 'asc' } } } });
  });

  const ctx = (req: { user?: { sub: string; role: string } }) => ({ userId: req.user!.sub, role: req.user!.role as never });
  const notes = (req: { body?: unknown }) => (req.body as { notes?: string })?.notes;

  app.post('/approvals/:id/approve', auth, async (req) => {
    await approve((req.params as { id: string }).id, ctx(req), notes(req));
    return { status: 'APPROVED' };
  });
  app.post('/approvals/:id/reject', auth, async (req) => {
    await reject((req.params as { id: string }).id, ctx(req), notes(req));
    return { status: 'REJECTED' };
  });
  app.post('/approvals/:id/request-revision', auth, async (req) => {
    const n = notes(req);
    if (!n) throw new ValidationError('notes are required');
    await requestRevision((req.params as { id: string }).id, ctx(req), n);
    return { status: 'REVISION_REQUESTED' };
  });
  app.post('/approvals/:id/escalate', auth, async (req) => {
    const body = req.body as { toUserId?: string; notes?: string };
    if (!body.toUserId) throw new ValidationError('toUserId is required');
    await escalate((req.params as { id: string }).id, ctx(req), body.toUserId, body.notes);
    return { status: 'ESCALATED' };
  });

  // Create a delegation (delegating your own authority to another user).
  app.post('/approvals/delegations', auth, async (req, reply) => {
    const body = req.body as { toUserId?: string; type?: string; endsAt?: string };
    if (!body.toUserId) throw new ValidationError('toUserId is required');
    const type = body.type && (APPROVAL_TYPES as readonly string[]).includes(body.type) ? (body.type as never) : null;
    const result = await createDelegation(req.user!.sub, body.toUserId, type, body.endsAt ? new Date(body.endsAt) : null, req.user!.sub);
    return reply.status(201).send(result);
  });
}
