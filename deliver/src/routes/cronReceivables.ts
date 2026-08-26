import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { refreshOpenInvoices } from '../integrations/quickbooks/receivables.js';

/**
 * The nightly receivables sweep.
 *
 * Its own endpoint rather than another block inside /cron/portal-delivery,
 * because the two have nothing to do with each other and a QuickBooks read
 * storm should not be able to delay a portal-delivery retry — or be delayed by
 * one. Vercel calls each on its own schedule (see vercel.json).
 *
 * Not behind the ordinary permission system: there is no user. It authenticates
 * on `CRON_SECRET`, which Vercel sends as a bearer token on its own scheduled
 * requests, and refuses outright when no secret is set rather than running open —
 * an unauthenticated endpoint that hammers Intuit's API is a way for anyone to
 * get this company rate limited.
 *
 * Idempotent and safe to run twice: it only reads from QuickBooks and writes the
 * answers into our own mirror. Nothing here sends anything to a customer. Chasing
 * a balance stays a decision a person makes, which is the whole reason the email
 * is composed by hand — a cron that emailed customers about money would be one
 * bad query away from an apology.
 *
 * It never throws. A 500 from a cron endpoint is a Vercel alert with no reader;
 * what failed is reported in the body, logged, and swept again tomorrow.
 */
export function registerReceivableCronRoutes(app: FastifyInstance): void {
  app.post('/cron/receivables', async (req, reply) => {
    if (!env.CRON_SECRET) {
      return reply.status(503).send({ error: 'CRON_SECRET_NOT_SET' });
    }
    if ((req.headers.authorization ?? '') !== `Bearer ${env.CRON_SECRET}`) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' });
    }

    const started = Date.now();
    const out: Record<string, unknown> = { ranAt: new Date().toISOString() };

    try {
      // 200 is above the number of invoices this company has open at once, so a
      // normal night refreshes everything. Oldest-synced first, so if there is ever
      // more than one page the stalest figures are the ones that get corrected.
      out.invoices = await refreshOpenInvoices(200);
    } catch (err) {
      logger.error({ err }, 'cron: receivables sweep failed');
      out.invoices = { error: err instanceof Error ? err.message : String(err) };
    }

    out.ms = Date.now() - started;
    logger.info(out, 'cron: receivables sweep');
    return reply.send(out);
  });
}
