import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { isBearerSecret } from '../lib/secretCompare.js';
import { logger } from '../lib/logger.js';
import { retryPendingSubmissions } from '../integrations/monday/portalDelivery.js';
import {
  isPortalInviteConfigured,
  sweepPendingInvites,
} from '../integrations/monday/portalInvite.js';
import { sweepVoidedDocuments } from '../integrations/quickbooks/billing.js';
import { sendUpchargeReminder } from '../integrations/quickbooks/colorUpcharge.js';
import { refreshPortal } from '../portal/orderPortal.js';
import { verifySchemaOnBoot } from '../lib/schemaCheck.js';
import { ensureDbReachable } from '../lib/dbRetry.js';
import { syncWebhooks } from '../integrations/monday/webhookRegistration.js';

/**
 * Scheduled work.
 *
 * One endpoint, called by Vercel Cron (see vercel.json). Not behind the ordinary
 * permission system — there is no user — so it authenticates on `CRON_SECRET`
 * instead, which Vercel sends as a bearer token on its own scheduled requests.
 *
 * Deliberately narrow. Everything it calls is idempotent and safe to run twice,
 * because a cron that must not double-fire is a cron that will eventually ruin an
 * afternoon.
 *
 * It never throws. A 500 from a cron endpoint is a Vercel alert with no reader; the
 * work that failed is reported in the body and logged, and the sweep runs again
 * tomorrow.
 */
export function registerCronRoutes(app: FastifyInstance): void {
  // Vercel Cron always invokes with GET, never POST, regardless of what's
  // configured in vercel.json — GET stays registered alongside POST so the
  // manual `curl -X POST` trigger in ops docs keeps working too.
  app.route({
    method: ['GET', 'POST'],
    url: '/cron/portal-delivery',
    handler: async (req, reply) => {
      // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. With no secret set,
      // the endpoint refuses rather than running open — an unauthenticated endpoint
      // that retries integration work is a way for anyone to hammer monday's API.
      if (!env.CRON_SECRET) {
        return reply.status(503).send({ error: 'CRON_SECRET_NOT_SET' });
      }
      const auth = req.headers.authorization ?? '';
      if (!isBearerSecret(auth, env.CRON_SECRET)) {
        return reply.status(401).send({ error: 'UNAUTHORIZED' });
      }

      const started = Date.now();
      const out: Record<string, unknown> = { ranAt: new Date().toISOString() };

      // 0. Is the database still shaped the way this build expects? Cheap, and it
      //    catches a migration that did not run even when nobody has hit the affected
      //    screen yet.
      //    The run's first database read, so a briefly unreachable database is
      //    waited out here (src/lib/dbRetry.ts) rather than failing every step
      //    below it.
      try {
        await ensureDbReachable('cron:portal-delivery');
        out.schema = await verifySchemaOnBoot();
      } catch (err) {
        logger.error({ err }, 'cron: schema check failed');
        out.schema = { error: String(err) };
      }

      // 1. Anything waiting on something: an address that arrived before its order,
      //    a row whose columns had not landed, a failed read.
      try {
        out.submissions = await retryPendingSubmissions(50);
      } catch (err) {
        logger.error({ err }, 'cron: portal delivery retry failed');
        out.submissions = { error: String(err) };
      }

      // 2. Re-assert the monday subscriptions. Cheap, idempotent, and it means a
      //    webhook deleted in monday by accident repairs itself within a day instead
      //    of silently swallowing every submission until someone notices.
      try {
        out.webhooks = await syncWebhooks();
      } catch (err) {
        logger.error({ err }, 'cron: webhook sync failed');
        out.webhooks = { error: String(err) };
      }

      // 3. Any manufacturing row that says Send Invite but whose invite column does
      //    not. This is the backstop for a webhook that never arrived and for a
      //    monday automation suppressed as automation-triggered — both fail by doing
      //    nothing, so the only way to catch them is to look. One board read on a
      //    quiet day, no writes.
      if (isPortalInviteConfigured()) {
        try {
          out.portalInvites = await sweepPendingInvites();
        } catch (err) {
          logger.error({ err }, 'cron: portal invite sweep failed');
          out.portalInvites = { error: String(err) };
        }
      }

      // 4. Retire QuickBooks documents that have been voided there.
      //
      //    Voiding happens in QuickBooks and nothing pushes the fact back. Every other
      //    place that notices only looks when a person asks it to, so until somebody
      //    opens the right screen the CRM shows a live invoice that no longer exists —
      //    and goes on blocking whatever that invoice gates, with no way out from
      //    inside the app. Capped per run; a backlog drains over successive nights
      //    rather than spending the whole function budget on Intuit reads.
      try {
        out.voidedDocuments = await sweepVoidedDocuments();
      } catch (err) {
        logger.error({ err }, 'cron: quickbooks void sweep failed');
        out.voidedDocuments = { error: String(err) };
      }

      // 5. Prismatic upcharges not yet billed.
      //
      //    The portal's colour answers otherwise reach the CRM only when someone opens
      //    the Orders page, and billing the upcharge is a person's click — so without a
      //    daily look, an upcharge nobody opened stays off the invoice. Re-read the
      //    portal first, then email accounting the list (every day while it is not
      //    empty) — including upcharges on monday rows no order is linked to yet.
      try {
        const refresh = await refreshPortal({ force: true });
        if (refresh.error)
          logger.warn(
            { error: refresh.error },
            'cron: portal refresh before upcharge check failed',
          );
        out.colorUpcharges = await sendUpchargeReminder(refresh.unlinkedColorUpcharges ?? []);
      } catch (err) {
        logger.error({ err }, 'cron: color upcharge check failed');
        out.colorUpcharges = { error: String(err) };
      }

      out.ms = Date.now() - started;
      logger.info(out, 'cron: portal delivery sweep');
      return reply.send(out);
    },
  });
}
