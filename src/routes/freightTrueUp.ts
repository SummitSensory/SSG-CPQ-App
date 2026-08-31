import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import {
  acknowledgeAlert,
  applyEntries,
  deleteEntry,
  freightGateStatus,
  freightQueue,
  freightStateForVersion,
  invoiceAlerts,
  markBucketNotApplicable,
  markCustomerNotified,
  openTrueUp,
  saveEntry,
  serializeEntry,
} from '../proposals/freightTrueUpService.js';
import {
  freightPushPreview,
  pushFreightToQbo,
  pushableEntries,
} from '../integrations/quickbooks/freightPush.js';
import {
  freightPullStatus,
  handleBoardChange,
  pullOutstanding,
  syncVersion,
} from '../integrations/monday/freightPull.js';
import { FREIGHT_BUCKETS } from '../proposals/freightTrueUp.js';
import {
  BANNER_DEFAULTS,
  BANNER_PRESETS,
  loadBannerTheme,
  resetBannerTheme,
  saveBannerTheme,
} from '../ui/bannerTheme.js';
import { env } from '../config/env.js';
import type { FreightTrueUp } from '@prisma/client';

/**
 * Freight routes.
 *
 * Read is open to anyone who can read a proposal — a rep has to be able to see that
 * their own job is waiting on freight, and the invoice-short alert has to reach
 * whoever is looking at the screen. Everything that writes a figure requires
 * FREIGHT_COST_WRITE; the QuickBooks push requires FREIGHT_INVOICE_PUSH on top,
 * because that one changes what a customer owes on a document they already hold.
 */

const Money = z.number().int().min(0).max(100_000_000);
const Bucket = z.enum([...FREIGHT_BUCKETS, 'STRUCTURE', 'STANDARD', 'THIRD_PARTY']);

const EntrySchema = z.object({
  bucket: Bucket,
  scope: z.enum(['JOB', 'LINES']),
  amountMinor: Money,
  lineRefs: z.array(z.string().min(1)).max(500).optional(),
  vendorName: z.string().trim().max(200).nullable().optional(),
  vendorQuoteRef: z.string().trim().max(120).nullable().optional(),
  quoteAttachmentId: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  overrideReason: z.string().trim().max(500).nullable().optional(),
  /** True when the amount is the bucket's whole figure rather than another instalment. */
  absolute: z.boolean().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

const PushSchema = z.object({
  /** Both come straight back from the preview — see pushFreightToQbo. */
  expectedCurrentTotalMinor: z.string().regex(/^-?\d+$/),
  expectedNewTotalMinor: z.string().regex(/^-?\d+$/),
  /** Which applied amounts to bill. Omitted bills everything outstanding. */
  entryIds: z.array(z.string().min(1)).max(100).optional(),
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
  // Changing what the whole company looks at all day is an administrator act, so it
  // rides on the same permission as the other integration and appearance settings.
  const manage = { preHandler: requirePermission(Permission.INTEGRATIONS_MANAGE) };

  /* ─────────────────────────── the queue and the alert ─────────────────────────── */

  /**
   * Every live job with freight outstanding, oldest first. `?settled=1` keeps the
   * resolved ones in view, which is how the coordinator checks her own work.
   */
  app.get('/freight/queue', read, async (req) => {
    const q = req.query as { settled?: string; limit?: string; threshold?: string };
    return freightQueue({
      includeSettled: q.settled === '1' || q.settled === 'true',
      limit: q.limit ? Math.min(300, Math.max(1, Number(q.limit) || 100)) : undefined,
      threshold: q.threshold ? Math.max(1, Number(q.threshold) || 5) : undefined,
    });
  });

  /**
   * Invoices that are short of freight. This is what the banner across the top of
   * every screen reads, so it is deliberately cheap and deliberately readable by
   * anyone: an invoice billed short is everybody's problem.
   */
  app.get('/freight/alerts', read, async (req) => {
    const q = req.query as { all?: string; limit?: string };
    const alerts = await invoiceAlerts({
      includeAcknowledged: q.all === '1' || q.all === 'true',
      limit: q.limit ? Math.min(200, Math.max(1, Number(q.limit) || 50)) : undefined,
    });
    return {
      alerts,
      billedShort: alerts.filter((a) => a.severity === 'BILLED_SHORT').length,
      unbilledMinor: alerts.reduce((sum, a) => sum + a.unbilledMinor, 0),
    };
  });

  /**
   * The banner’s colours.
   *
   * Read is open to anyone who can read a proposal, because everyone sees the
   * banner and it has to paint for all of them. Writing is an administrator act
   * — it changes what the whole company looks at all day.
   */
  app.get('/freight/banner-theme', read, async () => ({
    theme: await loadBannerTheme(),
    defaults: BANNER_DEFAULTS,
    presets: BANNER_PRESETS,
  }));

  app.patch('/freight/banner-theme', manage, async (req) => {
    const body = z
      .object({
        shortBg: z.string().trim().optional(),
        shortText: z.string().trim().optional(),
        pendingBg: z.string().trim().optional(),
        pendingText: z.string().trim().optional(),
      })
      .parse(req.body ?? {});
    return { theme: await saveBannerTheme(body, req.user!.sub) };
  });

  app.post('/freight/banner-theme/reset', manage, async (req) => ({
    theme: await resetBannerTheme(req.user!.sub),
  }));

  /** Quiet one job's banner for a day. It returns until the freight is billed. */
  app.post('/freight/alerts/:versionId/acknowledge', write, async (req) => {
    const { versionId } = req.params as { versionId: string };
    return acknowledgeAlert(versionId, req.user!.sub);
  });

  /* ─────────────────────────── the panel ─────────────────────────── */

  /**
   * Everything the freight panel needs: the four buckets, every product item, what
   * has been entered, and a live read of the deal board.
   *
   * `?sync=0` skips the board read — used by the dashboard, which wants the state of
   * a hundred jobs and must not make a hundred monday calls to get it.
   */
  app.get('/proposals/versions/:versionId/freight-state', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const q = req.query as { sync?: string };
    const state = await freightStateForVersion(versionId, req.user!.sub, {
      sync: !(q.sync === '0' || q.sync === 'false'),
    });
    return {
      ...state,
      live: serialize(state.live),
      history: state.history.map((h: FreightTrueUp) => serialize(h)),
    };
  });

  /** The Refresh button: read the deal board again, now. */
  app.post('/proposals/versions/:versionId/freight-refresh', write, async (req) => {
    const { versionId } = req.params as { versionId: string };
    return syncVersion(versionId, req.user!.sub);
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

  /* ─────────────────────────── entries ─────────────────────────── */

  /** Save one freight figure against a bucket. Nothing reaches the proposal yet. */
  app.post('/proposals/versions/:versionId/freight-entries', write, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const body = EntrySchema.parse(req.body ?? {});
    return serializeEntry(await saveEntry({ ...body, versionId }, req.user!.sub));
  });

  /** Correct a figure that has not been applied yet. */
  app.patch('/freight-entries/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    const body = EntrySchema.extend({ versionId: z.string().min(1) }).parse(req.body ?? {});
    return serializeEntry(await saveEntry({ ...body, entryId: id }, req.user!.sub));
  });

  /** Remove a figure entered in error. Only while it is still unapplied. */
  app.delete('/freight-entries/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    await deleteEntry(id, req.user!.sub);
    return { ok: true };
  });

  /** Record that a bucket carries no freight on this job, with a reason. */
  app.post('/proposals/versions/:versionId/freight-not-applicable', write, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const body = z
      .object({ bucket: Bucket, reason: z.string().min(5).max(500) })
      .parse(req.body ?? {});
    return serializeEntry(
      await markBucketNotApplicable(versionId, body.bucket, body.reason, req.user!.sub),
    );
  });

  /**
   * Write a batch of entered amounts onto the frozen version. The proposal's total
   * moves here; QuickBooks is a separate, separately-authorized step.
   */
  app.post('/proposals/versions/:versionId/freight-apply', write, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const body = z
      .object({ entryIds: z.array(z.string().min(1)).max(100).optional() })
      .parse(req.body ?? {});
    const result = await applyEntries(versionId, body.entryIds ?? null, req.user!.sub);
    return { ...result, trueUp: serialize(result.trueUp) };
  });

  /* ─────────────────────────── QuickBooks ─────────────────────────── */

  /** What is waiting to be billed on this job. */
  app.get('/proposals/versions/:versionId/freight-billable', push, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const rows = await pushableEntries(versionId);
    return {
      entries: rows.map(serializeEntry),
      totalMinor: rows.reduce((a, e) => a + e.amountMinor, 0),
    };
  });

  /** Before/after on the live invoice, and which document this batch would go on. */
  app.get('/proposals/versions/:versionId/freight-qbo-preview', push, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const q = req.query as { entryIds?: string };
    const ids = (q.entryIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return freightPushPreview(versionId, ids.length ? ids : null);
  });

  /** Amend the invoice, or raise the freight-only one. Confirmed totals required. */
  app.post('/proposals/versions/:versionId/freight-qbo-push', push, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const body = PushSchema.parse(req.body ?? {});
    return pushFreightToQbo(versionId, body.entryIds ?? null, req.user!.sub, {
      expectedCurrentTotalMinor: body.expectedCurrentTotalMinor,
      expectedNewTotalMinor: body.expectedNewTotalMinor,
    });
  });

  /** The revised total has been sent to the customer. */
  app.post('/freight-true-up/:id/customer-notified', write, async (req) => {
    const { id } = req.params as { id: string };
    return serialize(await markCustomerNotified(id, req.user!.sub));
  });

  /* ─────────────────────────── monday ─────────────────────────── */

  /** Which board columns this deployment reads, for the integration status page. */
  app.get('/freight/monday-status', read, async () => freightPullStatus());

  /**
   * The nightly sweep. Reads the board for every job still waiting on steel or mats
   * — the Friday-afternoon column fill that nobody saw over the weekend.
   *
   * Guarded by CRON_SECRET rather than by a session, and refuses outright when the
   * secret is unset: an open endpoint that hammers monday's API on request is a
   * denial-of-service against the whole integration.
   */
  // Vercel Cron always invokes with GET, never POST — GET stays registered
  // alongside POST so the manual `curl -X POST` trigger in ops docs keeps working.
  app.route({
    method: ['GET', 'POST'],
    url: '/cron/freight-pull',
    handler: async (req, reply) => {
      const secret = env.CRON_SECRET;
      if (!secret) return reply.status(503).send({ error: 'CRON_SECRET is not configured' });
      const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (given !== secret) return reply.status(401).send({ error: 'unauthorized' });
      const q = req.query as { limit?: string };
      return pullOutstanding('system:cron', {
        limit: q.limit ? Math.min(500, Math.max(1, Number(q.limit) || 200)) : undefined,
      });
    },
  });

  /**
   * A deal row changed on the board.
   *
   * Mounted here so the freight pull owns its own trigger, but it is NOT a public
   * endpoint: it takes the same CRON_SECRET, and the signed monday webhook calls
   * `handleBoardChange` directly (see the wiring note in
   * docs/freight-buckets.md). Verifying monday's JWT is the webhook plugin's job and
   * duplicating it here would mean two places to get it wrong.
   */
  app.post('/freight/board-changed', async (req, reply) => {
    const secret = env.CRON_SECRET;
    if (!secret) return reply.status(503).send({ error: 'CRON_SECRET is not configured' });
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (given !== secret) return reply.status(401).send({ error: 'unauthorized' });
    const body = z.object({ itemId: z.string().min(1) }).parse(req.body ?? {});
    return handleBoardChange(body.itemId, 'system:webhook');
  });
}
