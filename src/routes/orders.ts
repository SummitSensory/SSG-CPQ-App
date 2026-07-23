import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import {
  createAcceptedOrder, getOrder, listOrders, handoffStatus, orderAudit, verifyIntegrity,
  addRequirement, updateRequirement, addTask, updateTask, upsertProcurementLine, recordIntegrationRef,
} from '../handoff/service.js';
import type { HandoffStatus, RequirementCategory, RequirementStatus, HandoffTaskStatus, Role } from '@prisma/client';

/** AcceptedOrder rows carry BigInt columns — serialize for JSON. */
function serializeOrder<T extends { grandTotalMinor: bigint; depositDueMinor: bigint }>(o: T): Record<string, unknown> {
  return { ...o, grandTotalMinor: o.grandTotalMinor.toString(), depositDueMinor: o.depositDueMinor.toString() };
}

const ApprovalSchema = z.object({
  method: z.enum(['SIGNATURE', 'COUNTERSIGNED_PROPOSAL', 'PURCHASE_ORDER', 'EMAIL', 'VERBAL', 'PORTAL']),
  approverName: z.string().min(1),
  approverTitle: z.string().optional(),
  approverEmail: z.string().email().optional(),
  poNumber: z.string().optional(),
  documentRef: z.string().optional(),
  ipAddress: z.string().optional(),
  approvedAt: z.coerce.date(),
  notes: z.string().optional(),
});

export function registerOrderRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.ORDERS_READ) };
  const manage = { preHandler: requirePermission(Permission.ORDERS_MANAGE) };
  const handoff = { preHandler: requirePermission(Permission.HANDOFF_MANAGE) };

  // Lock an ACCEPTED version into an operational order + customer approval record.
  app.post('/orders/from-version/:versionId', manage, async (req, reply) => {
    const { versionId } = req.params as { versionId: string };
    const parsed = ApprovalSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const order = await createAcceptedOrder(versionId, parsed.data, req.user!.sub);
    return reply.status(201).send(serializeOrder(order));
  });

  app.get('/orders', read, async (req) => {
    const q = req.query as { status?: HandoffStatus; organizationId?: string };
    const rows = await listOrders({ status: q.status, organizationId: q.organizationId });
    return rows.map(serializeOrder);
  });

  app.get('/orders/:id', read, async (req) => serializeOrder(await getOrder((req.params as { id: string }).id)));
  app.get('/orders/:id/status', read, async (req) => handoffStatus((req.params as { id: string }).id));
  app.get('/orders/:id/audit', read, async (req) => orderAudit((req.params as { id: string }).id));
  app.get('/orders/:id/verify', read, async (req) => verifyIntegrity((req.params as { id: string }).id));

  // --- Handoff sub-records (operational data is mutable; the locked snapshot is not) ---
  app.post('/orders/:id/requirements', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { category: RequirementCategory; title: string; detail?: Record<string, unknown>; targetDate?: string };
    if (!b?.category || !b?.title) throw new ValidationError('category and title are required');
    return addRequirement(id, { category: b.category, title: b.title, detail: b.detail, targetDate: b.targetDate ? new Date(b.targetDate) : undefined }, req.user!.sub);
  });

  app.patch('/orders/requirements/:id', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { status?: RequirementStatus; targetDate?: string | null; detail?: Record<string, unknown>; isException?: boolean; exceptionReason?: string };
    return updateRequirement(id, { status: b.status, targetDate: b.targetDate === null ? null : b.targetDate ? new Date(b.targetDate) : undefined, detail: b.detail, isException: b.isException, exceptionReason: b.exceptionReason }, req.user!.sub);
  });

  app.post('/orders/:id/tasks', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { title: string; description?: string; category?: RequirementCategory; assigneeId?: string; assigneeRole?: Role; dueDate?: string };
    if (!b?.title) throw new ValidationError('title is required');
    return addTask(id, { title: b.title, description: b.description, category: b.category, assigneeId: b.assigneeId, assigneeRole: b.assigneeRole, dueDate: b.dueDate ? new Date(b.dueDate) : undefined }, req.user!.sub);
  });

  app.patch('/orders/tasks/:id', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { status?: HandoffTaskStatus; assigneeId?: string | null; assigneeRole?: Role | null; dueDate?: string | null; isException?: boolean; exceptionReason?: string };
    return updateTask(id, { status: b.status, assigneeId: b.assigneeId, assigneeRole: b.assigneeRole, dueDate: b.dueDate === null ? null : b.dueDate ? new Date(b.dueDate) : undefined, isException: b.isException, exceptionReason: b.exceptionReason }, req.user!.sub);
  });

  app.post('/orders/:id/procurement', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { id?: string; productId?: string; sku?: string; name: string; quantity: number; vendor?: string; poNumber?: string; sourced?: boolean; targetDate?: string; notes?: string; isException?: boolean; exceptionReason?: string };
    if (!b?.name || !b?.quantity) throw new ValidationError('name and quantity are required');
    return upsertProcurementLine(id, { ...b, targetDate: b.targetDate ? new Date(b.targetDate) : undefined }, req.user!.sub);
  });

  app.post('/orders/:id/integrations', manage, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { qboEstimateTxnId?: string; mondayProjectId?: string };
    return serializeOrder(await recordIntegrationRef(id, b, req.user!.sub));
  });
}
