import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { isMondayConfigured } from '../config/env.js';
import { verifyMondayWebhook } from '../integrations/monday/webhook.js';
import { applyInboundChange } from '../integrations/monday/sync.js';
import { logger } from '../lib/logger.js';

export function registerIntegrationRoutes(app: FastifyInstance): void {
  // Settings visibility is gated by integrations:manage (server-side).
  app.get('/integrations/monday/status', { preHandler: requirePermission(Permission.INTEGRATIONS_MANAGE) }, async () => ({
    provider: 'monday',
    configured: isMondayConfigured(),
    mode: 'two-way',
    entity: 'deal',
  }));

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
