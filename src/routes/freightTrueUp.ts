import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import {
  applyTrueUp,
  freightQueue,
  freightStateForVersion,
  freightGateStatus,
  markCustomerNotified,
  markNoFreight,
  openTrueUp,
  stageTrueUp,
} from '../proposals/freightTrueUpService.js';
import { freightPushPreview, pushFreightToQbo } from '../integrations/quickbooks/freightPush.js';
import type { FreightTrueUp } from '@prisma/client';

/**
 * Freight true-up routes.
 *
 * Read is open to anyone who can read a proposal — a rep has to be able to see that
 * their own job is waiting on freight. Everything that writes a figure requires
 * FREIGHT_COST_WRITE; the QuickBooks push requires FREIGHT_INVOICE_PUSH on top,
 * because that one changes what a customer owes on a document they already hold.
 */

const Money = z.number().int().min(0).max(100_000_000);

const StageSchema = z.object({
  structureFreightMinor: Money.nullable().optional(),
  stdFreightMinor: Money.nullable().optional(),
  thirdPartyLines: z
    .array(
      z.object({
        ref: z.string().min(1),
        sku: z.string().optional(),
        name: z.string().optional(),
        amountMinor: Money,
      }),
    )
    .max(500)
    .optional(),
  vendorName: z.string().trim().max(200).nullable().optional(),
  vendorQuoteRef: z.string().trim().max(120).nullable().optional(),
  quoteAttachmentId: z.string().trim().max(60).nullable().optional(),
  freightRfqId: z.string().trim().max(60).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

const PushSchema = z.object({
  /** Both come straight back from the preview — see pushFreightToQbo. */
  expectedCurrentTotalMinor: z.string().regex(/^-?\d+$/),
  expectedNewTotalMinor: z.string().regex(/^-?\d+$/),
});

/** FreightTrueUp carries BigInt money columns; JSON needs them as strings. */
function serialize(t: FreightTrueUp | null) {
  if (!t) return null;
  const big = (v: bigint | null): string | null => (v == null ? null : v.toString());
  return {
    ...t,
    previousTotalMinor: big(t.previousTotalMinor),
    newTotalMinor: big(t.newTotalMinor),
    qboPreviousTotalMinor: big(t.qboPreviousTotalMinor),
    qboNewTotalMinor: big(t.qboNewTotalMinor),
  };
}

export function registerFreightTrueUpRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const write = { preHandler: requirePermission(Permission.FREIGHT_COST_WRITE) };
  const push = { preHandler: requirePermission(Permission.FREIGHT_INVOICE_PUSH) };

  /**
   * The freight queue: every live job with freight outstanding, oldest first.
   * `?settled=1` keeps the resolved ones in view, which is how the coordinator
   * checks her own work.
   */
  app.get('/freight/queue', read, async (req) => {
    const q = req.query as { settled?: string; limit?: string; threshold?: string };
    return freightQueue({
      includeSettled: q.settled === '1' || q.settled === 'true',
      limit: q.limit ? Math.min(300, Math.max(1, Number(q.limit) || 100)) : undefined,
      threshold: q.threshold ? Math.max(1, Number(q.threshold) || 5) : undefined,
    });
  });

  /** Everything the proposal screen needs: gaps, live entry, history, totals. */
  app.get('/proposals/versions/:versionId/freight-state', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const state = await freightStateForVersion(versionId);
    return {
      ...state,
      live: serialize(state.live),
      history: state.history.map((h) => serialize(h)),
    };
  });

  /** Is this job's freight settled? Used by the BOM/order gate and the UI. */
  app.get('/proposals/:id/freight-gate', read, async (req) => {
    const { id } = req.params as { id: string };
    return freightGateStatus(id);
  });

  /** Take responsibility for the freight on a released version. */
  app.post('/proposals/versions/:versionId/freight-true-up', write, async (req) => {
    const { versionId } = req.params as { versionId: string };
    return serialize(await openTrueUp(versionId, req.user!.sub));
  });

  /** Save entered amounts without touching the proposal. */
  app.patch('/freight-true-up/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    return serialize(await stageTrueUp(id, StageSchema.parse(req.body ?? {}), req.user!.sub));
  });

  /** Record that no freight applies, with a reason. Closes the gap. */
  app.post('/freight-true-up/:id/no-freight', write, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().min(5).max(500) }).parse(req.body ?? {});
    return serialize(await markNoFreight(id, body.reason, req.user!.sub));
  });

  /**
   * Write the staged freight onto the frozen version. The proposal's total moves
   * here; QuickBooks is a separate, separately-authorized step.
   */
  app.post('/freight-true-up/:id/apply', write, async (req) => {
    const { id } = req.params as { id: string };
    const result = await applyTrueUp(id, req.user!.sub);
    return { ...result, trueUp: serialize(result.trueUp) };
  });

  /** Before/after on the live invoice, and which document the freight would go on. */
  app.get('/freight-true-up/:id/qbo-preview', push, async (req) => {
    const { id } = req.params as { id: string };
    return freightPushPreview(id);
  });

  /** Amend the invoice, or raise the freight-only one. Confirmed totals required. */
  app.post('/freight-true-up/:id/qbo-push', push, async (req) => {
    const { id } = req.params as { id: string };
    return pushFreightToQbo(id, req.user!.sub, PushSchema.parse(req.body ?? {}));
  });

  /** The revised total has been sent to the customer. */
  app.post('/freight-true-up/:id/customer-notified', write, async (req) => {
    const { id } = req.params as { id: string };
    return serialize(await markCustomerNotified(id, req.user!.sub));
  });
}
