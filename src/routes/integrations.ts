import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { isMondayConfigured } from '../config/env.js';
import { verifyMondayWebhook } from '../integrations/monday/webhook.js';
import { applyInboundChange, retrySync } from '../integrations/monday/sync.js';
import { reconcile } from '../integrations/monday/reconcile.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export function registerIntegrationRoutes(app: FastifyInstance): void {
  // Settings visibility is gated by integrations:manage (server-side).
  app.get('/integrations/monday/status', { preHandler: requirePermission(Permission.INTEGRATIONS_MANAGE) }, async () => ({
    provider: 'monday',
    configured: isMondayConfigured(),
    mode: 'two-way',
    entity: 'deal',
  }));

  const manage = { preHandler: requirePermission(Permission.INTEGRATIONS_MANAGE) };

  // Per-entity link + recent sync-log state.
  app.get('/integrations/monday/links', manage, async () =>
    prisma.externalLink.findMany({ where: { provider: 'monday' }, orderBy: { updatedAt: 'desc' }, take: 200 }),
  );
  app.get('/integrations/monday/logs', manage, async () =>
    prisma.integrationSyncLog.findMany({ where: { provider: 'monday' }, orderBy: { createdAt: 'desc' }, take: 200 }),
  );

  // Reconciliation report — drift, errored links, recent failures.
  app.get('/integrations/monday/reconcile', manage, async () => reconcile());

  // Manual retry of a failed sync attempt.
  app.post('/integrations/monday/retry/:logId', manage, async (req, reply) => {
    const { logId } = req.params as { logId: string };
    const result = await retrySync(logId);
    if (result === 'notfound') return reply.status(404).send({ error: 'NOT_FOUND' });
    return { result };
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
    const result = await applyInboundChange({
      eventId: String((ev as { triggerUuid?: string }).triggerUuid ?? `${ev.pulseId}-${ev.columnId}-${Date.now()}`),
      itemId: String((ev as { pulseId?: unknown }).pulseId ?? ''),
      columnId: (ev as { columnId?: string }).columnId,
      newStatusLabel: ((ev as { value?: { label?: { text?: string } } }).value?.label?.text) ?? undefined,
    });
    logger.info({ result }, 'monday webhook processed');
    return reply.send({ ok: true, result });
  });
}
