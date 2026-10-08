import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Audit: scheduled-work wiring.
 *
 * Every /cron/* endpoint is invoked by Vercel Cron, which (per the comment on
 * registerCronRoutes in src/routes/cron.ts) always sends GET. A cron route that
 * only answers POST, or one missing from vercel.json's `crons` list, never runs
 * in production and fails silently — nobody notices the absence of a job.
 *
 * Nothing here reaches a database or the network: auth is checked before any
 * handler work, and these requests never carry a valid secret.
 */

const h = vi.hoisted(() => ({ cronSecret: 'audit-cron-secret-0123456789' as string | undefined }));

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get(target, prop, receiver) {
        if (prop === 'CRON_SECRET') return h.cronSecret;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
  };
});

const CRON_PATHS = [
  '/cron/portal-delivery',
  '/cron/esign-reminders',
  '/cron/fx-refresh',
  '/cron/receivables',
  '/cron/scheduled-reports',
] as const;

let app: FastifyInstance;

beforeAll(async () => {
  const Fastify = (await import('fastify')).default;
  const { registerCronRoutes } = await import('../../src/routes/cron.js');
  const { registerEsignReminderCronRoutes } =
    await import('../../src/routes/cronEsignReminders.js');
  const { registerFxCronRoutes } = await import('../../src/routes/cronFx.js');
  const { registerReceivableCronRoutes } = await import('../../src/routes/cronReceivables.js');
  const { registerInsightCronRoutes } = await import('../../src/routes/cronInsights.js');
  app = Fastify();
  registerCronRoutes(app);
  registerEsignReminderCronRoutes(app);
  registerFxCronRoutes(app);
  registerReceivableCronRoutes(app);
  registerInsightCronRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('cron endpoints: authentication (no work runs without the secret)', () => {
  for (const url of CRON_PATHS) {
    it(`POST ${url} with a wrong bearer token is 401`, async () => {
      h.cronSecret = 'audit-cron-secret-0123456789';
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: 'Bearer nope' },
      });
      expect(res.statusCode).toBe(401);
    });

    it(`POST ${url} with CRON_SECRET unset refuses with 503 rather than running open`, async () => {
      h.cronSecret = undefined;
      try {
        const res = await app.inject({ method: 'POST', url });
        expect(res.statusCode).toBe(503);
      } finally {
        h.cronSecret = 'audit-cron-secret-0123456789';
      }
    });
  }
});

describe('cron endpoints: reachable by Vercel Cron (GET)', () => {
  for (const url of CRON_PATHS.filter((p) => p !== '/cron/scheduled-reports')) {
    it(`GET ${url} is routed (401 without a token, not 404)`, async () => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    });
  }

  // BUG: registerInsightCronRoutes uses app.post only. Vercel Cron sends GET, so
  // the scheduled-report email never fires in production (it 404s).
  it.fails('BUG: GET /cron/scheduled-reports is routed (Vercel Cron only sends GET)', async () => {
    const res = await app.inject({ method: 'GET', url: '/cron/scheduled-reports' });
    expect(res.statusCode).toBe(401);
  });
});

describe('vercel.json schedules every cron endpoint', () => {
  const vercel = JSON.parse(readFileSync(resolve(__dirname, '../../vercel.json'), 'utf8')) as {
    crons?: Array<{ path: string; schedule: string }>;
  };
  const scheduled = new Set((vercel.crons ?? []).map((c) => c.path));

  for (const url of CRON_PATHS.filter((p) => p !== '/cron/scheduled-reports')) {
    it(`${url} is scheduled`, () => {
      expect(scheduled.has(url)).toBe(true);
    });
  }

  // BUG: docs/reporting-and-goals.md says /cron/scheduled-reports runs daily at
  // 12:30 UTC, but vercel.json has no entry for it — scheduled reports never send.
  it.fails('BUG: /cron/scheduled-reports is scheduled in vercel.json', () => {
    expect(scheduled.has('/cron/scheduled-reports')).toBe(true);
  });
});
