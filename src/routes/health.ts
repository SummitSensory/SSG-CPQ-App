import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { BUILD_INFO } from '../lib/buildInfo.js';
import { checkSchemaDrift } from '../lib/schemaCheck.js';
import { checkOrphanedReferences } from '../lib/orphanCheck.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { env, resetLinkBaseUrl, weakJwtSecrets } from '../config/env.js';
import { effectiveThresholds } from './pricing.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/health/db', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', db: 'reachable' };
  });

  /**
   * Is the database caught up with the deployed code?
   *
   * schemaCheck.ts already knew how to answer this and already alerted at boot, but
   * nothing exposed it, so the only way to ask was to read the alert email. That is
   * the wrong direction: the question comes up when a screen is throwing 500s and
   * you want a one-line answer about why.
   *
   * Unauthenticated and 503 on drift, for the same reason /build-info is open — a
   * broken deployment is exactly when you cannot log in to investigate, and the
   * response says which migration is missing, not what any of it does. 503 rather
   * than 200 so an uptime check treats "code ahead of database" as down, because it
   * is: queries against those tables fail.
   */
  app.get('/health/schema', async (_req, reply) => {
    const report = await checkSchemaDrift();

    // The check itself failing is a third state — the schema may be fine. Report it
    // as such rather than claiming drift we did not observe.
    if (report.error) return reply.status(503).send({ status: 'unknown', ...report });

    const pending = [
      ...new Set([...report.missingTables, ...report.missingColumns].map((x) => x.since)),
    ];
    const missing = [
      ...report.missingTables.map((t) => `table ${t.table} (${t.since})`),
      ...report.missingColumns.map((c) => `${c.table}.${c.column} (${c.since})`),
    ];

    if (report.ok) return { status: 'ok', ok: true, missing: [], pendingMigrations: [] };

    return reply.status(503).send({
      status: 'drift',
      ok: false,
      missing,
      pendingMigrations: pending,
      fix: 'pnpm db:migrate:deploy',
      missingTables: report.missingTables,
      missingColumns: report.missingColumns,
    });
  });

  /**
   * What is deployed.
   *
   * Unauthenticated, because the shell asks for it while the login screen is still up —
   * knowing which build you are looking at matters most when something is behaving
   * oddly before you can get in. Nothing here is sensitive: a commit sha and its subject
   * line say what changed, not how anything works.
   */
  /**
   * Dangling `*ById` references.
   *
   * Several id columns here are deliberately not foreign keys, so that a deactivated
   * user does not take a customer note or a sales target with them. The cost is that
   * orphaned ids accumulate silently and resolve to "—" on screen. This counts them.
   *
   * Authenticated, unlike /health/schema: that one is open because a broken deployment
   * is exactly when you cannot log in, whereas this returns row ids and is a
   * housekeeping question, not an outage question.
   *
   * Always 200. An orphan is not a fault — it is usually the correct outcome of
   * someone being deactivated — so an uptime check must not read it as down.
   */
  app.get(
    '/health/references',
    { preHandler: requirePermission(Permission.USERS_MANAGE) },
    async () => checkOrphanedReferences(),
  );

  /**
   * Are the deploy-time settings the audit fixes depend on in place?
   *
   * Each of these used to be answerable only by reading the Vercel dashboard or the
   * boot logs. This answers yes/no and NEVER returns a secret: a secret's length class,
   * not the secret; whether a reset-link origin is configured, and which one (an origin
   * is not sensitive — it is in every email we send). Same permission as
   * /health/references.
   */
  app.get(
    '/health/config',
    { preHandler: requirePermission(Permission.USERS_MANAGE) },
    async () => {
      const resetBase = resetLinkBaseUrl();
      const weak = weakJwtSecrets();
      const t = effectiveThresholds();
      return {
        passwordResetLinks: {
          ok: resetBase !== null,
          origin: resetBase ? new URL(resetBase).origin : null,
          source: env.APP_BASE_URL
            ? 'APP_BASE_URL'
            : env.PUBLIC_BASE_URL
              ? 'PUBLIC_BASE_URL'
              : env.ENTRA_REDIRECT_URI
                ? 'ENTRA_REDIRECT_URI'
                : null,
        },
        jwtSecrets: { ok: weak.length === 0, shorterThan32: weak },
        pricingThresholds: {
          minMarginBps: t.minMarginBps ?? null,
          discountAuthorityBps: t.discountAuthorityBps ?? null,
          enforced: t.minMarginBps !== undefined || t.discountAuthorityBps !== undefined,
        },
      };
    },
  );

  app.get('/build-info', async () => BUILD_INFO);
}
