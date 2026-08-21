import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import {
  isMondayConfigured,
  isMondayPushConfigured,
  isMondayWebhookConfigured,
  env,
} from '../config/env.js';
import { verifyMondayWebhook } from '../integrations/monday/webhook.js';
import { handleBoardChange } from '../integrations/monday/freightPull.js';
import { applyInboundChange, retrySync } from '../integrations/monday/sync.js';
import { reconcile } from '../integrations/monday/reconcile.js';
import { listBoards, describeBoard } from '../integrations/monday/discovery.js';
import {
  importCrmFromMonday,
  importDealsMatching,
  importDealById,
} from '../integrations/monday/crmImport.js';
import { searchItemsByName, fetchItemById } from '../integrations/monday/discovery.js';
import { DEALS_BOARD_ID, DEAL_COL, clean, firstLabel } from '../integrations/monday/crmMapping.js';
import {
  deliveryBoardId,
  isPortalDeliveryConfigured,
  ingestDeliverySubmission,
  processSubmission,
  linkSubmission,
  retryPendingSubmissions,
  backfillFromBoard,
  purgeAddresslessIncomplete,
  listSubmissions,
} from '../integrations/monday/portalDelivery.js';
import {
  syncWebhooks,
  webhookStatus,
  deleteWebhook,
} from '../integrations/monday/webhookRegistration.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export function registerIntegrationRoutes(app: FastifyInstance): void {
  // Settings visibility is gated by integrations:manage (server-side).
  app.get(
    '/integrations/monday/status',
    { preHandler: requirePermission(Permission.INTEGRATIONS_MANAGE) },
    async () => ({
      provider: 'monday',
      configured: isMondayConfigured(),
      // Broken out so the settings page can say WHICH half is missing: a deployment
      // that only pushes deals needs the token and board id, and nothing else.
      pushConfigured: isMondayPushConfigured(),
      webhookConfigured: isMondayWebhookConfigured(),
      // The portal's delivery submissions ride the same webhook and the same token,
      // so this reports which board that half is listening to rather than a second
      // set of credentials.
      portalDelivery: {
        configured: isPortalDeliveryConfigured(),
        boardId: deliveryBoardId(),
      },
      missing: [
        env.MONDAY_API_TOKEN ? null : 'MONDAY_API_TOKEN',
        env.MONDAY_DEALS_BOARD_ID ? null : 'MONDAY_DEALS_BOARD_ID',
        env.MONDAY_SIGNING_SECRET ? null : 'MONDAY_SIGNING_SECRET',
      ].filter(Boolean),
      mode: 'two-way',
      entity: 'deal',
    }),
  );

  const manage = { preHandler: requirePermission(Permission.INTEGRATIONS_MANAGE) };

  // Per-entity link + recent sync-log state.
  app.get('/integrations/monday/links', manage, async () =>
    prisma.externalLink.findMany({
      where: { provider: 'monday' },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
  );
  app.get('/integrations/monday/logs', manage, async () =>
    prisma.integrationSyncLog.findMany({
      where: { provider: 'monday' },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  );

  // Reconciliation report — drift, errored links, recent failures.
  app.get('/integrations/monday/reconcile', manage, async () => reconcile());

  // ----- Board discovery (read-only) -----
  // monday column ids are per-board and opaque, so an import mapping has to be
  // written against the real board. These endpoints expose what is actually
  // there; nothing is written to either system.
  //
  // Gated on the API token ALONE, not isMondayConfigured(): discovery is how
  // you find the board id, so requiring MONDAY_DEALS_BOARD_ID here would be
  // circular.

  app.get('/integrations/monday/boards', manage, async (_req, reply) => {
    if (!env.MONDAY_API_TOKEN) return reply.status(400).send({ error: 'MONDAY_TOKEN_MISSING' });
    try {
      return await listBoards();
    } catch (err) {
      logger.error({ err }, 'monday board list failed');
      return reply.status(502).send({ error: 'MONDAY_QUERY_FAILED', detail: String(err) });
    }
  });

  app.get('/integrations/monday/boards/:boardId', manage, async (req, reply) => {
    if (!env.MONDAY_API_TOKEN) return reply.status(400).send({ error: 'MONDAY_TOKEN_MISSING' });
    const { boardId } = req.params as { boardId: string };
    const { sample } = req.query as { sample?: string };
    const size = Math.min(Math.max(Number(sample) || 3, 1), 10);
    try {
      return await describeBoard(boardId, size);
    } catch (err) {
      logger.error({ err, boardId }, 'monday board describe failed');
      return reply.status(502).send({ error: 'MONDAY_QUERY_FAILED', detail: String(err) });
    }
  });

  // Manual retry of a failed sync attempt.
  app.post('/integrations/monday/retry/:logId', manage, async (req, reply) => {
    const { logId } = req.params as { logId: string };
    const result = await retrySync(logId);
    if (result === 'notfound') return reply.status(404).send({ error: 'NOT_FOUND' });
    return { result };
  });

  // ----- CRM import (monday -> CPQ, inbound only) -----
  // Defaults to a dry run: pass ?apply=true to actually write. Idempotent —
  // re-running updates linked records rather than duplicating them.

  app.post('/integrations/monday/import/crm', manage, async (req, reply) => {
    if (!env.MONDAY_API_TOKEN) return reply.status(400).send({ error: 'MONDAY_TOKEN_MISSING' });
    const q = req.query as {
      apply?: string;
      limit?: string;
      offset?: string;
      budgetMs?: string;
      organizationsOnly?: string;
      source?: string;
    };
    const limit = q.limit ? Math.max(1, Number(q.limit) || 0) : undefined;
    const offset = q.offset ? Math.max(0, Number(q.offset) || 0) : 0;
    try {
      return await importCrmFromMonday({
        dryRun: q.apply !== 'true',
        ...(limit ? { limit } : {}),
        offset,
        ...(q.budgetMs ? { budgetMs: Math.max(5_000, Number(q.budgetMs) || 45_000) } : {}),
        organizationsOnly: q.organizationsOnly === 'true',
        source: q.source === 'orgs' ? 'orgs' : 'deals',
      });
    } catch (err) {
      logger.error({ err }, 'monday CRM import failed');
      return reply.status(502).send({ error: 'MONDAY_IMPORT_FAILED', detail: String(err) });
    }
  });

  // ----- On-demand customer lookup (the proposal-time path) -----
  // Search Deal Tracking by name; one query, no board walk.
  app.get('/integrations/monday/search', manage, async (req, reply) => {
    if (!env.MONDAY_API_TOKEN) return reply.status(400).send({ error: 'MONDAY_TOKEN_MISSING' });
    const { q } = req.query as { q?: string };
    if (!q || q.trim().length < 2) return reply.status(400).send({ error: 'QUERY_TOO_SHORT' });
    try {
      const items = await searchItemsByName(DEALS_BOARD_ID, q.trim(), 25);
      return items.map((it) => ({
        itemId: it.id,
        name: it.name,
        industry: firstLabel(it.text[DEAL_COL.industry]),
        contact: clean(it.text[DEAL_COL.contactName]),
        email: clean(it.text[DEAL_COL.contactEmail]),
        city: clean(it.text[DEAL_COL.cityText]) ?? clean(it.text[DEAL_COL.city]),
        state: clean(it.text[DEAL_COL.state]),
        projectId: clean(it.text[DEAL_COL.projectId]),
        stage: clean(it.text[DEAL_COL.stage]),
      }));
    } catch (err) {
      logger.error({ err }, 'monday search failed');
      return reply.status(502).send({ error: 'MONDAY_QUERY_FAILED', detail: String(err) });
    }
  });

  // Import every match for a search term (writes unless ?apply=false).
  app.post('/integrations/monday/import/search', manage, async (req, reply) => {
    if (!env.MONDAY_API_TOKEN) return reply.status(400).send({ error: 'MONDAY_TOKEN_MISSING' });
    const { q, apply } = req.query as { q?: string; apply?: string };
    if (!q || q.trim().length < 2) return reply.status(400).send({ error: 'QUERY_TOO_SHORT' });
    try {
      return await importDealsMatching(q.trim(), { dryRun: apply === 'false' });
    } catch (err) {
      logger.error({ err }, 'monday search import failed');
      return reply.status(502).send({ error: 'MONDAY_IMPORT_FAILED', detail: String(err) });
    }
  });

  // Import one deal row by monday item id.
  app.post('/integrations/monday/import/deal/:itemId', manage, async (req, reply) => {
    if (!env.MONDAY_API_TOKEN) return reply.status(400).send({ error: 'MONDAY_TOKEN_MISSING' });
    const { itemId } = req.params as { itemId: string };
    const { apply } = req.query as { apply?: string };
    try {
      return await importDealById(itemId, apply === 'false');
    } catch (err) {
      logger.error({ err, itemId }, 'monday deal import failed');
      return reply.status(502).send({ error: 'MONDAY_IMPORT_FAILED', detail: String(err) });
    }
  });

  // Every populated column on one item — for tracking down where a value lives.
  app.get('/integrations/monday/item/:itemId', manage, async (req, reply) => {
    if (!env.MONDAY_API_TOKEN) return reply.status(400).send({ error: 'MONDAY_TOKEN_MISSING' });
    const { itemId } = req.params as { itemId: string };
    const { all } = req.query as { all?: string };
    try {
      const item = await fetchItemById(itemId);
      if (!item) return reply.status(404).send({ error: 'NOT_FOUND' });
      const cols = Object.keys(item.text)
        .map((id) => ({ id, text: item.text[id] || null, value: item.raw[id] }))
        .filter((c) => (all === 'true' ? true : c.text || c.value));
      return { id: item.id, name: item.name, columns: cols };
    } catch (err) {
      logger.error({ err, itemId }, 'monday item fetch failed');
      return reply.status(502).send({ error: 'MONDAY_QUERY_FAILED', detail: String(err) });
    }
  });

  // ----- Portal delivery submissions -----
  // What the customer confirmed, what the CRM did with it, and what is stuck.
  // The list is the operational screen: a PARKED row is an address with nowhere
  // to go, and it carries the reason in words.

  app.get('/integrations/monday/portal-delivery', manage, async (req) => {
    const { limit } = req.query as { limit?: string };
    return listSubmissions(Number(limit) || 100);
  });

  /** Pull one submissions row by monday item id — the manual version of the webhook. */
  app.post('/integrations/monday/portal-delivery/import/:itemId', manage, async (req, reply) => {
    if (!isPortalDeliveryConfigured())
      return reply.status(400).send({ error: 'MONDAY_TOKEN_MISSING' });
    const { itemId } = req.params as { itemId: string };
    const result = await ingestDeliverySubmission(itemId);
    if (result === 'notfound') return reply.status(404).send({ error: 'NOT_FOUND' });
    return { result };
  });

  /** Re-run one stored submission (after the order was imported, say). */
  app.post('/integrations/monday/portal-delivery/:id/retry', manage, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await processSubmission(id);
    if (result === 'notfound') return reply.status(404).send({ error: 'NOT_FOUND' });
    return { result };
  });

  /**
   * Attach a parked submission to an order by hand. Also records the order's
   * portal item id, so nobody has to do this twice for the same job.
   */
  app.post('/integrations/monday/portal-delivery/:id/link', manage, async (req) => {
    const { id } = req.params as { id: string };
    const { orderId } = req.body as { orderId: string };
    return { result: await linkSubmission(id, orderId) };
  });

  /** Sweep everything that is waiting on something. Safe to run on a schedule. */
  app.post('/integrations/monday/portal-delivery/retry-pending', manage, async (req) => {
    const { limit } = req.query as { limit?: string };
    return retryPendingSubmissions(Number(limit) || 25);
  });

  /**
   * Read the submissions board itself and ingest every row that has an address.
   *
   * The retry sweep above only revisits submissions the CRM has already stored, so
   * it cannot see a row that never arrived — and a row created before the CRM
   * subscribed to the board never fired a webhook, because webhooks are not
   * retroactive. This is the one endpoint that closes that gap. Idempotent, so it is
   * safe to run whenever the board and the CRM look like they disagree.
   *
   * `?max=` bounds the run (default 100, cap 500) to stay inside the request
   * timeout; run it again to continue.
   */
  app.post('/integrations/monday/portal-delivery/backfill', manage, async (req, reply) => {
    if (!isPortalDeliveryConfigured())
      return reply.status(400).send({ error: 'MONDAY_TOKEN_MISSING' });
    const { max } = req.query as { max?: string };
    try {
      return await backfillFromBoard(Number(max) || 100);
    } catch (err) {
      logger.error({ err }, 'portal delivery backfill failed');
      return reply.status(502).send({ error: 'MONDAY_QUERY_FAILED', detail: String(err) });
    }
  });

  /**
   * Drop the stored rows that have no address at all — board rows nobody filled in.
   * Kept out of the sweep and behind a button: deleting records is a decision, and
   * anything that ever carried an address is never touched.
   */
  app.delete('/integrations/monday/portal-delivery/incomplete', manage, async () =>
    purgeAddresslessIncomplete(),
  );

  // ----- Webhook subscriptions (registering ourselves with monday) -----
  //
  // These were the missing half of the delivery integration: portalDelivery.ts knew
  // how to handle an inbound event and webhookRegistration.ts knew how to subscribe,
  // but nothing exposed the subscribe call, so the board was never told to post here
  // and no submission ever arrived. Registration is idempotent, so the sync endpoint
  // is safe to hit repeatedly and safe to call from the deploy cron.

  /** What monday is subscribed to right now, against what the CRM needs. */
  app.get('/integrations/monday/webhooks', manage, async (_req, reply) => {
    try {
      return await webhookStatus();
    } catch (err) {
      logger.error({ err }, 'monday webhook status failed');
      return reply.status(502).send({ error: 'MONDAY_QUERY_FAILED', detail: String(err) });
    }
  });

  /** Make monday's subscriptions match the declaration. `?dryRun=true` writes nothing. */
  app.post('/integrations/monday/webhooks/sync', manage, async (req, reply) => {
    if (!env.MONDAY_API_TOKEN) return reply.status(400).send({ error: 'MONDAY_TOKEN_MISSING' });
    const { dryRun } = req.query as { dryRun?: string };
    try {
      return await syncWebhooks(dryRun === 'true');
    } catch (err) {
      logger.error({ err }, 'monday webhook sync failed');
      return reply.status(502).send({ error: 'MONDAY_SYNC_FAILED', detail: String(err) });
    }
  });

  /**
   * Remove one subscription by monday webhook id. Deliberately explicit rather than
   * part of sync: a stale subscription pointing at an old preview URL is reported by
   * sync as `foreign` and removed only when somebody decides to remove it.
   */
  app.delete('/integrations/monday/webhooks/:id', manage, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await deleteWebhook(id);
      return { deleted: id };
    } catch (err) {
      logger.error({ err, id }, 'monday webhook delete failed');
      return reply.status(502).send({ error: 'MONDAY_QUERY_FAILED', detail: String(err) });
    }
  });

  // Inbound webhook. Public endpoint, but authenticated by monday's signed JWT.
  app.post('/integrations/monday/webhook', async (req, reply) => {
    const body = req.body as { challenge?: string; event?: Record<string, unknown> };

    // 1) monday handshake: echo the challenge on subscription.
    if (body?.challenge) return reply.send({ challenge: body.challenge });

    // 2) Verify signature on real events.
    const ok = await verifyMondayWebhook(req.headers.authorization);
    if (!ok) return reply.status(401).send({ error: 'INVALID_SIGNATURE' });

    const ev = body?.event ?? {};
    const boardId = String((ev as { boardId?: unknown }).boardId ?? '');
    const itemId = String((ev as { pulseId?: unknown }).pulseId ?? '');

    /**
     * 3) Route on the board.
     *
     * One endpoint, two boards. The deals board drives opportunity stage; the
     * portal's Delivery & Site Details Submissions board drives delivery
     * addresses. They are different subscriptions in monday pointing at the same
     * URL, which is why the board id — not the column — decides what happens.
     *
     * Every event for a submissions row is processed, not just the create: the
     * portal creates the row first and writes its ~30 columns afterwards, one
     * call each, so the create event carries no address. Re-processing is cheap
     * and idempotent (see portalDelivery.ts).
     */
    if (boardId && boardId === deliveryBoardId()) {
      if (!itemId) return reply.send({ ok: true, result: 'ignored' });
      const result = await ingestDeliverySubmission(itemId);
      logger.info({ itemId, result }, 'portal delivery webhook processed');
      return reply.send({ ok: true, result });
    }

    const result = await applyInboundChange({
      eventId: String(
        (ev as { triggerUuid?: string }).triggerUuid ??
          `${ev.pulseId}-${ev.columnId}-${Date.now()}`,
      ),
      itemId,
      columnId: (ev as { columnId?: string }).columnId,
      newStatusLabel:
        (ev as { value?: { label?: { text?: string } } }).value?.label?.text ?? undefined,
    });
    /**
     * A deal-row column change may be the steel or mats freight figure landing.
     *
     * Best effort, and deliberately AFTER the stage sync: a freight read must never
     * fail this webhook, because monday retries on failure and the retry would
     * re-run the stage change that already succeeded. A failure here costs nothing
     * — the freight panel reads the board when it opens, and the nightly sweep
     * reads it again.
     */
    if (itemId && (!boardId || boardId === env.MONDAY_DEALS_BOARD_ID)) {
      try {
        await handleBoardChange(itemId, 'system:webhook');
      } catch (err) {
        logger.warn({ err, itemId }, 'freight pull from monday webhook failed');
      }
    }

    logger.info({ result }, 'monday webhook processed');
    return reply.send({ ok: true, result });
  });
}
