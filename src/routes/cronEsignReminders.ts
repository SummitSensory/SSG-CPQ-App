import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { sendAlert } from '../lib/alerts.js';
import { sendEsignReminders } from '../integrations/docuseal/notifications.js';
import { repairStuckSignedCopies } from '../integrations/docuseal/service.js';

/**
 * Daily esign follow-up: nudge staff about proposals that are still not
 * signed, and retry capturing/pushing any signed copy that got stuck on a
 * previous run.
 *
 * Same shape as this file's cron siblings: authenticates on CRON_SECRET
 * (there is no user), never throws, and reports what happened in the response
 * body and the log rather than only a 500 nobody reads.
 */
export function registerEsignReminderCronRoutes(app: FastifyInstance): void {
  // Vercel Cron always invokes with GET, never POST — see the note on
  // registerCronRoutes in ./cron.ts. GET stays registered alongside POST so the
  // manual `curl -X POST` trigger in ops docs keeps working too.
  app.route({
    method: ['GET', 'POST'],
    url: '/cron/esign-reminders',
    handler: async (req, reply) => {
      if (!env.CRON_SECRET) {
        return reply.status(503).send({ error: 'CRON_SECRET_NOT_SET' });
      }
      if ((req.headers.authorization ?? '') !== `Bearer ${env.CRON_SECRET}`) {
        return reply.status(401).send({ error: 'UNAUTHORIZED' });
      }

      const started = Date.now();
      const out: Record<string, unknown> = { ranAt: new Date().toISOString() };

      try {
        out.reminders = await sendEsignReminders();
      } catch (err) {
        logger.error({ err }, 'cron: esign reminder sweep failed');
        out.reminders = { error: String(err) };
        sendAlert({
          title: 'Daily esign reminder sweep crashed',
          detail: 'The /cron/esign-reminders job threw before it could finish reminders.',
          err,
          fingerprint: 'cron:esign-reminders:crash',
        });
      }

      try {
        out.signedCopyRepair = await repairStuckSignedCopies();
      } catch (err) {
        logger.error({ err }, 'cron: signed-copy repair sweep failed');
        out.signedCopyRepair = { error: String(err) };
        sendAlert({
          title: 'Signed-copy repair sweep crashed',
          detail: 'The /cron/esign-reminders job threw before it could finish the repair sweep.',
          err,
          fingerprint: 'cron:esign-reminders:repair-crash',
        });
      }

      out.ms = Date.now() - started;
      logger.info(out, 'cron: esign reminders');
      return reply.send(out);
    },
  });
}
