import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { sendAlert } from '../lib/alerts.js';
import { prisma } from '../lib/prisma.js';
import { resolveRateForDate, type FxFallbackModeValue } from '../crossborder/rateService.js';
import { writeCrossBorderSnapshot } from '../crossborder/snapshot.js';

/** Attributed to no real user — the same "no user, this is a cron" stance as
 * every other scheduled job in this file's siblings, made explicit here because
 * writeCrossBorderSnapshot takes an actorId and there genuinely isn't one. */
const CRON_ACTOR_ID = 'system:fx-cron';

/**
 * The daily USD/CAD refresh.
 *
 * Two things a live proposal view alone never did:
 *
 * 1. **Actually store the day's rate onto every open draft.** `crossBorderStateFor`
 *    (the builder's live view) resolves and caches the rate globally on every page
 *    view, but nothing called `writeCrossBorderSnapshot` for a draft — only release
 *    does. So a rep could watch the rate refresh on screen and the proposal's own
 *    stored totals never moved. This is that missing write, run once a day instead
 *    of on a page view, so every open Canadian draft carries today's rate without
 *    anyone having to open it.
 *
 * 2. **Say so when the Bank of Canada could not be reached.** resolveRateForDate
 *    never throws — a provider failure falls back and the caller gets a `warning`
 *    string, which is exactly right for a proposal screen. But a warning nobody is
 *    looking at is not a notification. Same alert path every other genuine fault in
 *    this app uses (src/lib/alerts.ts): fire-and-forget, deduplicated by fingerprint,
 *    so a string of failed days is one email, not one per day.
 *
 * Not behind the ordinary permission system: there is no user. It authenticates on
 * CRON_SECRET, same as its siblings, and refuses outright when no secret is set.
 *
 * It never throws. A 500 from a cron endpoint is a Vercel alert with no reader;
 * what failed is reported in the body, logged, and — via sendAlert — actually
 * reaches someone.
 */
// TEMPORARY — diagnosing a manual-test 401 that shouldn't be happening. Never
// the secret itself: length plus a few characters off each end is enough to
// spot a copy/paste or environment-scope mismatch without exposing it.
// Revert this once that's resolved.
function fingerprint(s: string): { length: number; head: string; tail: string } {
  return { length: s.length, head: s.slice(0, 4), tail: s.slice(-4) };
}

export function registerFxCronRoutes(app: FastifyInstance): void {
  app.post('/cron/fx-refresh', async (req, reply) => {
    if (!env.CRON_SECRET) {
      return reply.status(503).send({ error: 'CRON_SECRET_NOT_SET' });
    }
    if ((req.headers.authorization ?? '') !== `Bearer ${env.CRON_SECRET}`) {
      const received = req.headers.authorization ?? '';
      const receivedToken = received.startsWith('Bearer ') ? received.slice(7) : received;
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        debug: {
          expected: fingerprint(env.CRON_SECRET),
          received: fingerprint(receivedToken),
          receivedHadBearerPrefix: received.startsWith('Bearer '),
        },
      });
    }

    const started = Date.now();
    const asOf = new Date().toISOString().slice(0, 10);
    const out: Record<string, unknown> = { ranAt: new Date().toISOString(), asOf };

    try {
      const settings = await prisma.crossBorderSetting.findUnique({ where: { id: 'singleton' } });
      if (!settings?.enabled) {
        out.skipped = 'cross-border pricing is off';
        return reply.send(out);
      }

      const resolution = await resolveRateForDate(asOf, {
        fallbackMode: (settings.fxFallbackMode as FxFallbackModeValue) ?? 'DRAFT_WITH_REVIEW',
        staleRateDays: settings.staleRateDays ?? 5,
      });
      out.fallbackUsed = resolution.fallbackUsed;
      out.observation = resolution.observation;

      // fallbackUsed means the Bank was not reached today — a real error (a
      // timeout, a DNS failure) or an empty publication window read as one. Either
      // way, today's rate did not come from the Bank, and that is worth someone's
      // attention rather than a line in a log nobody reads.
      if (resolution.fallbackUsed) {
        sendAlert({
          title: 'Bank of Canada exchange rate refresh failed',
          detail:
            resolution.warning ?? 'The daily USD/CAD refresh could not reach the Bank of Canada.',
          fingerprint: 'cron:fx-refresh:fallback',
          context: { asOf, observation: resolution.observation },
        });
      }

      if (!resolution.observation) {
        out.draftsUpdated = 0;
        return reply.send(out);
      }

      // Every open Canadian draft, refreshed with today's rate. writeCrossBorderSnapshot
      // is a no-op (returns snapshotId: null) for a version that turns out not to be
      // Canadian or not applicable — cheaper to let it say so than to re-derive
      // jurisdiction here and risk the two rules drifting apart.
      const drafts = await prisma.proposalVersion.findMany({
        where: { status: 'DRAFT' },
        select: { id: true },
      });

      let updated = 0;
      const failures: Array<{ versionId: string; error: string }> = [];
      for (const draft of drafts) {
        try {
          const result = await writeCrossBorderSnapshot(draft.id, CRON_ACTOR_ID);
          if (result.snapshotId) updated++;
        } catch (err) {
          failures.push({
            versionId: draft.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      out.draftsChecked = drafts.length;
      out.draftsUpdated = updated;
      if (failures.length) {
        out.draftFailures = failures;
        sendAlert({
          title: 'Daily exchange-rate refresh: some drafts failed to update',
          detail: `${failures.length} of ${drafts.length} Canadian draft(s) failed to recalculate with today's rate.`,
          fingerprint: 'cron:fx-refresh:draft-failures',
          context: { asOf, failures },
        });
      }
    } catch (err) {
      logger.error({ err }, 'cron: fx refresh failed');
      out.error = err instanceof Error ? err.message : String(err);
      sendAlert({
        title: 'Daily exchange-rate refresh crashed',
        detail: 'The /cron/fx-refresh job threw before it could finish.',
        err,
        fingerprint: 'cron:fx-refresh:crash',
        context: { asOf },
      });
    }

    out.ms = Date.now() - started;
    logger.info(out, 'cron: fx refresh');
    return reply.send(out);
  });
}
