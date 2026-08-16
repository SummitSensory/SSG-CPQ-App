import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { recordEvent, syncEnvelope } from '../integrations/docuseal/service.js';

/**
 * DocuSeal webhooks: `form.viewed`, `form.started`, `form.completed`,
 * `form.declined`, `submission.completed`.
 *
 * Public route — DocuSeal has no session — and therefore secret-checked. With no
 * secret configured it accepts nothing, the same stance as the Resend webhook: an
 * unauthenticated endpoint that writes to a signing audit trail is worse than no
 * endpoint.
 *
 * DocuSeal signs nothing by default; what it offers is a custom header you set on
 * the webhook. Both shapes are accepted:
 *
 *   X-Webhook-Secret: <DOCUSEAL_WEBHOOK_SECRET>          (shared secret, the usual case)
 *   X-Docuseal-Signature: <hex HMAC-SHA256 of the body>  (when signing is enabled)
 *
 * The event only tells us *that* something happened. The envelope's new state is
 * then read back from the API, so a webhook and a manual refresh cannot disagree —
 * and a spoofed body cannot invent a signature, because nothing in the payload is
 * trusted as state.
 */

function timingEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authorized(headers: Record<string, unknown>, raw: string, secret: string): boolean {
  const shared = headers['x-webhook-secret'];
  if (typeof shared === 'string' && timingEqual(shared, secret)) return true;
  const signature = headers['x-docuseal-signature'];
  if (typeof signature === 'string') {
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    return timingEqual(signature.replace(/^sha256=/, ''), expected);
  }
  return false;
}

interface DocusealWebhook {
  event_type?: string;
  timestamp?: string;
  data?: {
    id?: number | string;
    submission_id?: number | string;
    email?: string;
    status?: string;
    decline_reason?: string;
    submission?: { id?: number | string };
  };
}

export function registerDocusealWebhookRoutes(app: FastifyInstance): void {
  app.post('/webhooks/docuseal', async (req, reply) => {
    if (!env.DOCUSEAL_WEBHOOK_SECRET) {
      logger.warn('docuseal webhook: received but no secret is configured');
      return reply.status(503).send({ message: 'Webhooks are not configured' });
    }
    const raw =
      typeof (req as { rawBody?: string }).rawBody === 'string'
        ? (req as { rawBody?: string }).rawBody!
        : JSON.stringify(req.body);

    if (!authorized(req.headers as Record<string, unknown>, raw, env.DOCUSEAL_WEBHOOK_SECRET)) {
      logger.warn('docuseal webhook: rejected, bad secret');
      return reply.status(401).send({ message: 'Invalid signature' });
    }

    const event = req.body as DocusealWebhook;
    const submissionId = event.data?.submission_id ?? event.data?.submission?.id;
    const submitterId = event.data?.id;

    // Resolve on submission first, then on submitter: `submission.completed`
    // carries the submission id, while the form.* events carry the submitter's.
    let envelope: { id: string } | null = null;
    if (submissionId) {
      envelope = await prisma.esignEnvelope.findFirst({
        where: { docusealSubmissionId: String(submissionId) },
        select: { id: true },
      });
    } else if (submitterId) {
      const signer = await prisma.esignSigner.findFirst({
        where: { docusealSubmitterId: String(submitterId) },
        select: { envelopeId: true },
      });
      envelope = signer ? { id: signer.envelopeId } : null;
    }

    // Not one of ours — a template signed straight from DocuSeal, or another
    // deployment pointed at the same account. Acknowledge and move on, or DocuSeal
    // retries forever.
    if (!envelope) return reply.status(200).send({ ok: true });

    await recordEvent({
      envelopeId: envelope.id,
      eventType: event.event_type ?? 'unknown',
      raw,
      payload: event,
    });

    try {
      await syncEnvelope(envelope.id);
    } catch (err) {
      // A 200 is still the right answer: the event is recorded, and the next event
      // or a manual refresh will pick the state up. A 500 here only buys retries of
      // something that failed on our side of the wire.
      logger.error({ err, envelopeId: envelope.id }, 'docuseal webhook: sync failed');
    }

    return reply.status(200).send({ ok: true });
  });
}
