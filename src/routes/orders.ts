import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import {
  createAcceptedOrder,
  getOrder,
  listOrders,
  handoffStatus,
  orderAudit,
  verifyIntegrity,
  addRequirement,
  updateRequirement,
  addTask,
  updateTask,
  upsertProcurementLine,
  recordIntegrationRef,
  unlockOrder,
  orderForVersion,
  patchProcurementLine,
  updateOrderBomHeader,
  applyPowderColorToOrder,
  deleteProcurementLine,
} from '../handoff/service.js';
import { buildBom } from '../handoff/bom.js';
import type {
  HandoffStatus,
  RequirementCategory,
  RequirementStatus,
  HandoffTaskStatus,
  Role,
} from '@prisma/client';

/** AcceptedOrder rows carry BigInt columns — serialize for JSON. */
function serializeOrder<T extends { grandTotalMinor: bigint; depositDueMinor: bigint }>(
  o: T,
): Record<string, unknown> {
  return {
    ...o,
    grandTotalMinor: o.grandTotalMinor.toString(),
    depositDueMinor: o.depositDueMinor.toString(),
  };
}

const ApprovalSchema = z.object({
  method: z.enum([
    'SIGNATURE',
    'COUNTERSIGNED_PROPOSAL',
    'PURCHASE_ORDER',
    'EMAIL',
    'VERBAL',
    'PORTAL',
  ]),
  approverName: z.string().min(1),
  approverTitle: z.string().optional(),
  approverEmail: z.string().email().optional(),
  poNumber: z.string().optional(),
  documentRef: z.string().optional(),
  ipAddress: z.string().optional(),
  approvedAt: z.coerce.date(),
  notes: z.string().optional(),
});

const BomHeader = z.object({
  jobName: z.string().trim().max(240).nullish(),
  bomShipTo: z.enum(['CUSTOMER', 'SUMMIT']).optional(),
  bomSubmittedOn: z.union([z.coerce.date(), z.null()]).optional(),
  deliveryType: z.string().trim().max(120).nullish(),
  powderCoatBrand: z.string().trim().max(120).nullish(),
  shipmentQuote: z.string().trim().max(120).nullish(),
  bomNotes: z.string().trim().max(4000).nullish(),
});

const BomLinePatch = z.object({
  powderColor: z.string().trim().max(80).nullish(),
  /** Brand from the managed list (Cardinal, Prismatic). Null clears the colour. */
  powderBrandId: z.string().trim().max(40).nullish(),
  /** Colour code as typed for this part. */
  powderColorCode: z.string().trim().max(60).nullish(),
  vendorNotes: z.string().trim().max(500).nullish(),
  poNumber: z.string().trim().max(80).nullish(),
  sourced: z.boolean().optional(),
  unitCostMinor: z.number().int().nonnegative().nullish(),
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

  app.get('/orders/:id', read, async (req) =>
    serializeOrder(await getOrder((req.params as { id: string }).id)),
  );
  app.get('/orders/:id/status', read, async (req) =>
    handoffStatus((req.params as { id: string }).id),
  );
  app.get('/orders/:id/audit', read, async (req) => orderAudit((req.params as { id: string }).id));
  app.get('/orders/:id/verify', read, async (req) =>
    verifyIntegrity((req.params as { id: string }).id),
  );

  /** Which order (if any) a proposal version is locked into — drives the unlock action. */
  app.get('/orders/by-version/:versionId', read, async (req) =>
    orderForVersion((req.params as { versionId: string }).versionId),
  );

  /**
   * Unlock: the customer wants a last-minute change. The order is cancelled (never
   * deleted, reason on its timeline) and a new DRAFT proposal version is cloned so
   * the change can be made and re-accepted.
   */
  app.post('/orders/:id/unlock', manage, async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body || {}) as { reason?: string; createRevision?: boolean };
    if (!b.reason || !b.reason.trim())
      throw new ValidationError('A reason is required to unlock an order');
    return unlockOrder(id, { reason: b.reason, createRevision: b.createRevision }, req.user!.sub);
  });

  // --- Handoff sub-records (operational data is mutable; the locked snapshot is not) ---
  app.post('/orders/:id/requirements', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as {
      category: RequirementCategory;
      title: string;
      detail?: Record<string, unknown>;
      targetDate?: string;
    };
    if (!b?.category || !b?.title) throw new ValidationError('category and title are required');
    return addRequirement(
      id,
      {
        category: b.category,
        title: b.title,
        detail: b.detail,
        targetDate: b.targetDate ? new Date(b.targetDate) : undefined,
      },
      req.user!.sub,
    );
  });

  app.patch('/orders/requirements/:id', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as {
      status?: RequirementStatus;
      targetDate?: string | null;
      detail?: Record<string, unknown>;
      isException?: boolean;
      exceptionReason?: string;
    };
    return updateRequirement(
      id,
      {
        status: b.status,
        targetDate:
          b.targetDate === null ? null : b.targetDate ? new Date(b.targetDate) : undefined,
        detail: b.detail,
        isException: b.isException,
        exceptionReason: b.exceptionReason,
      },
      req.user!.sub,
    );
  });

  app.post('/orders/:id/tasks', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as {
      title: string;
      description?: string;
      category?: RequirementCategory;
      assigneeId?: string;
      assigneeRole?: Role;
      dueDate?: string;
    };
    if (!b?.title) throw new ValidationError('title is required');
    return addTask(
      id,
      {
        title: b.title,
        description: b.description,
        category: b.category,
        assigneeId: b.assigneeId,
        assigneeRole: b.assigneeRole,
        dueDate: b.dueDate ? new Date(b.dueDate) : undefined,
      },
      req.user!.sub,
    );
  });

  app.patch('/orders/tasks/:id', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as {
      status?: HandoffTaskStatus;
      assigneeId?: string | null;
      assigneeRole?: Role | null;
      dueDate?: string | null;
      isException?: boolean;
      exceptionReason?: string;
    };
    return updateTask(
      id,
      {
        status: b.status,
        assigneeId: b.assigneeId,
        assigneeRole: b.assigneeRole,
        dueDate: b.dueDate === null ? null : b.dueDate ? new Date(b.dueDate) : undefined,
        isException: b.isException,
        exceptionReason: b.exceptionReason,
      },
      req.user!.sub,
    );
  });

  /**
   * Add (or update) a Bill of Materials line. Cost and weight are optional: left
   * out, the catalog fills them in — see upsertProcurementLine.
   */
  app.post('/orders/:id/procurement', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as {
      id?: string;
      productId?: string;
      sku?: string;
      name: string;
      quantity: number;
      vendor?: string;
      poNumber?: string;
      sourced?: boolean;
      targetDate?: string;
      notes?: string;
      isException?: boolean;
      exceptionReason?: string;
      unitCostMinor?: number | null;
      unitWeightLbs?: number | null;
    };
    if (!b?.name?.trim()) throw new ValidationError('An item name is required');
    const qty = Number(b?.quantity);
    if (!Number.isFinite(qty) || qty <= 0)
      throw new ValidationError('Quantity must be greater than zero');
    return upsertProcurementLine(
      id,
      {
        ...b,
        name: b.name.trim(),
        quantity: qty,
        targetDate: b.targetDate ? new Date(b.targetDate) : undefined,
      },
      req.user!.sub,
    );
  });

  /** Remove a Bill of Materials line. Refused while its vendor section is submitted. */
  app.delete('/orders/procurement/:lineId', handoff, async (req) => {
    const { lineId } = req.params as { lineId: string };
    return deleteProcurementLine(lineId, req.user!.sub);
  });

  app.post('/orders/:id/integrations', manage, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { qboEstimateTxnId?: string; mondayProjectId?: string };
    return serializeOrder(await recordIntegrationRef(id, b, req.user!.sub));
  });

  // --- Bill of Materials ---
  /**
   * The assembled BOM document: header, ship-from / ship-to blocks, lines and
   * totals. `vendor` scopes it to one vendor ('*' for all of them);
   * `includeZeroQty` adds the rest of that vendor's catalogue at quantity 0 so the
   * shop can hand-add a part without asking for a new sheet.
   */
  app.get('/orders/:id/bom', read, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { vendor?: string; includeZeroQty?: string };
    // Reading the order first backfills part numbers, vendors, cost and weight on
    // lines locked before those were resolved.
    await getOrder(id);
    return buildBom(id, { vendor: q.vendor, includeZeroQty: q.includeZeroQty === 'true' });
  });

  app.patch('/orders/:id/bom', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = BomHeader.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid BOM header');
    return serializeOrder(await updateOrderBomHeader(id, parsed.data, req.user!.sub));
  });

  app.patch('/orders/procurement/:lineId', handoff, async (req) => {
    const { lineId } = req.params as { lineId: string };
    const parsed = BomLinePatch.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid line');
    return patchProcurementLine(lineId, parsed.data, req.user!.sub);
  });

  /** Set one powder colour across every steel line on the order. */
  app.post('/orders/:id/bom/powder-color', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body || {}) as { color?: string; overwrite?: boolean };
    if (typeof b.color !== 'string') throw new ValidationError('color is required');
    return applyPowderColorToOrder(id, b.color.trim(), { overwrite: !!b.overwrite }, req.user!.sub);
  });
}
