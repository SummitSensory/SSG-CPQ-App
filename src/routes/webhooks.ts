import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Resend delivery webhooks.
 *
 * Moves a `BomSend` row from SENT to DELIVERED or BOUNCED so the audit trail says
 * what actually happened to a vendor's email rather than only that we handed it
 * over.
 *
 * Deliberately NOT handled: `email.opened`. Most corporate mail clients block the
 * tracking pixel, so an absent open says nothing at all — recording it would put a
 * number on the screen that looks like evidence and is not. Delivered and bounced
 * come from the receiving mail server and are real.
 *
 * The route is public (Resend has no session) and therefore signature-verified.
 * Without a configured secret it accepts nothing: an unauthenticated endpoint that
 * writes to an audit trail is worse than no endpoint.
 */

interface SvixHeaders {
  'svix-id'?: string;
  'svix-timestamp'?: string;
  'svix-signature'?: string;
}

/** Svix signatures are `v1,<base64>`, space-separated, any of which may match. */
function verify(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
  header: string,
): boolean {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  const expectedBuf = Buffer.from(expected);
  return header
    .split(' ')
    .map((p) => p.split(',')[1])
    .filter(Boolean)
    .some((sig) => {
      const given = Buffer.from(sig as string);
      // Length check first: timingSafeEqual throws on a mismatch rather than
      // returning false.
      return given.length === expectedBuf.length && crypto.timingSafeEqual(given, expectedBuf);
    });
}

/** Reject anything older than five minutes — a captured payload cannot be replayed. */
const MAX_AGE_SECONDS = 300;

export function registerWebhookRoutes(app: FastifyInstance): void {
  app.post('/webhooks/resend', async (req, reply) => {
    if (!env.RESEND_WEBHOOK_SECRET) {
      logger.warn('resend webhook: received but no secret is configured');
      return reply.status(503).send({ message: 'Webhooks are not configured' });
    }

    const h = req.headers as SvixHeaders;
    const id = h['svix-id'];
    const timestamp = h['svix-timestamp'];
    const signature = h['svix-signature'];
    const raw =
      typeof (req as { rawBody?: string }).rawBody === 'string'
        ? (req as { rawBody?: string }).rawBody!
        : JSON.stringify(req.body);

    if (!id || !timestamp || !signature)
      return reply.status(400).send({ message: 'Missing signature headers' });

    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > MAX_AGE_SECONDS) {
      return reply.status(400).send({ message: 'Timestamp outside the accepted window' });
    }
    if (!verify(env.RESEND_WEBHOOK_SECRET, id, timestamp, raw, signature)) {
      logger.warn({ id }, 'resend webhook: bad signature');
      return reply.status(401).send({ message: 'Invalid signature' });
    }

    const event = req.body as {
      type?: string;
      data?: { email_id?: string; bounce?: { message?: string } };
    };
    const messageId = event.data?.email_id;
    if (!messageId) return reply.status(200).send({ ok: true });

    const bounceMessage =
      event.data?.bounce?.message ?? 'The recipient’s mail server rejected the message';

    // Two kinds of send carry a provider message id: a Bill of Materials and a freight
    // request. Both matter for the same reason — a vendor who never received the email
    // is not working on it, and nobody finds out until the job needs the answer.
    const send = await prisma.bomSend.findFirst({ where: { providerMessageId: messageId } });
    if (send) {
      if (event.type === 'email.delivered') {
        await prisma.bomSend.update({
          where: { id: send.id },
          data: { status: 'DELIVERED', deliveredAt: new Date() },
        });
      } else if (event.type === 'email.opened') {
        // Only the FIRST open is recorded. Resend fires on every image load, and a
        // timestamp that keeps moving tells you when the vendor last scrolled past the
        // message in their inbox, not when they read it.
        if (!send.openedAt) {
          await prisma.bomSend.update({ where: { id: send.id }, data: { openedAt: new Date() } });
        }
      } else if (event.type === 'email.bounced') {
        await prisma.bomSend.update({
          where: { id: send.id },
          data: { status: 'BOUNCED', error: bounceMessage },
        });
        // A bounce is operationally urgent — the vendor does not have the BOM and
        // nobody would otherwise find out. Put it on the order timeline.
        await prisma.orderEvent.create({
          data: {
            orderId: send.orderId,
            action: 'bom.email.bounced',
            actorId: send.sentById,
            detail: { vendor: send.vendor, to: send.toEmail } as object,
          },
        });
        logger.warn({ sendId: send.id, to: send.toEmail }, 'resend webhook: BOM bounced');
      }
      return reply.status(200).send({ ok: true });
    }

    const rfqSend = await prisma.freightRfqSend.findFirst({
      where: { providerMessageId: messageId },
      select: {
        id: true,
        toEmail: true,
        openedAt: true,
        rfq: { select: { id: true, vendor: true } },
      },
    });
    if (rfqSend) {
      if (event.type === 'email.delivered') {
        await prisma.freightRfqSend.update({
          where: { id: rfqSend.id },
          data: { status: 'DELIVERED', deliveredAt: new Date() },
        });
      } else if (event.type === 'email.opened') {
        if (!rfqSend.openedAt) {
          await prisma.freightRfqSend.update({
            where: { id: rfqSend.id },
            data: { openedAt: new Date() },
          });
        }
      } else if (event.type === 'email.bounced') {
        await prisma.freightRfqSend.update({
          where: { id: rfqSend.id },
          data: { status: 'BOUNCED', error: bounceMessage },
        });
        logger.warn(
          { sendId: rfqSend.id, to: rfqSend.toEmail, vendor: rfqSend.rfq?.vendor },
          'resend webhook: freight request bounced',
        );
      }
      return reply.status(200).send({ ok: true });
    }

    // Not one of ours — an invite, a password reset, a notification. Acknowledge and
    // move on: a 200 is what stops the provider retrying something we do not track.
    return reply.status(200).send({ ok: true });
  });
}
