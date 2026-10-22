import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * /cron/esign-reminders and a briefly unreachable database.
 *
 * Production, 2026-10-22 14:01 UTC: "Signed-copy repair sweep crashed" —
 * PrismaClientKnownRequestError P1001 from repairStuckSignedCopies' opening
 * findMany. The route now waits out a transient outage (src/lib/dbRetry.ts)
 * before each sweep: a blip that heals inside the retry window runs the sweep and
 * sends no alert; one that persists, or any non-connectivity error, alerts exactly
 * as before. Prisma, the sweeps, alerts and sleep are all stubbed.
 */

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  reminders: vi.fn(),
  repair: vi.fn(),
  alerts: [] as Array<{ title: string; fingerprint?: string }>,
}));

vi.mock('node:timers/promises', () => ({ setTimeout: async () => undefined }));
vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get(target, prop, receiver) {
        if (prop === 'CRON_SECRET') return 'esign-cron-secret-0123456789';
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
  };
});
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/lib/alerts.js', () => ({
  sendAlert: (a: { title: string; fingerprint?: string }) => h.alerts.push(a),
  deliverAlert: async (a: { title: string; fingerprint?: string }) => {
    h.alerts.push(a);
  },
}));
vi.mock('../../src/lib/prisma.js', () => ({ prisma: { $queryRaw: h.queryRaw } }));
vi.mock('../../src/integrations/docuseal/notifications.js', () => ({
  sendEsignReminders: h.reminders,
}));
vi.mock('../../src/integrations/docuseal/service.js', () => ({
  repairStuckSignedCopies: h.repair,
}));

function p1001(): Error {
  return Object.assign(
    new Error("Can't reach database server at `ep-example-pooler.neon.tech:5432`"),
    { name: 'PrismaClientKnownRequestError', code: 'P1001' },
  );
}

let app: FastifyInstance;
const AUTH = { authorization: 'Bearer esign-cron-secret-0123456789' };

beforeAll(async () => {
  const Fastify = (await import('fastify')).default;
  const { registerEsignReminderCronRoutes } =
    await import('../../src/routes/cronEsignReminders.js');
  app = Fastify();
  registerEsignReminderCronRoutes(app);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  h.alerts.length = 0;
  h.queryRaw.mockReset().mockResolvedValue([{ x: 1 }]);
  h.reminders.mockReset().mockResolvedValue({ reminded: 2 });
  h.repair.mockReset().mockResolvedValue({ repaired: 1, stillStuck: 0 });
});

async function run() {
  const res = await app.inject({ method: 'GET', url: '/cron/esign-reminders', headers: AUTH });
  expect(res.statusCode).toBe(200);
  return res.json<Record<string, unknown>>();
}

describe('/cron/esign-reminders: transient database outage', () => {
  it('a blip that heals on retry runs both sweeps and sends no alert', async () => {
    h.queryRaw
      .mockRejectedValueOnce(p1001())
      .mockRejectedValueOnce(p1001())
      .mockResolvedValue([{ x: 1 }]);

    const out = await run();
    expect(out.reminders).toEqual({ reminded: 2 });
    expect(out.signedCopyRepair).toEqual({ repaired: 1, stillStuck: 0 });
    expect(h.reminders).toHaveBeenCalledTimes(1);
    expect(h.repair).toHaveBeenCalledTimes(1);
    expect(h.alerts).toEqual([]);
  });

  it('the database dropping between the sweeps is waited out before the repair sweep', async () => {
    // First probe fine; the repair sweep's probe fails once then recovers — the
    // 2026-10-22 shape, where the failure hit the second sweep.
    h.queryRaw
      .mockResolvedValueOnce([{ x: 1 }])
      .mockRejectedValueOnce(p1001())
      .mockResolvedValue([{ x: 1 }]);

    const out = await run();
    expect(out.signedCopyRepair).toEqual({ repaired: 1, stillStuck: 0 });
    expect(h.alerts).toEqual([]);
  });

  it('an outage that outlasts the retries still alerts, once per sweep, as before', async () => {
    h.queryRaw.mockRejectedValue(p1001());

    const out = await run();
    expect(h.reminders).not.toHaveBeenCalled();
    expect(h.repair).not.toHaveBeenCalled();
    expect(out.reminders).toMatchObject({ error: expect.stringContaining("Can't reach") });
    expect(out.signedCopyRepair).toMatchObject({ error: expect.stringContaining("Can't reach") });
    expect(h.alerts.map((a) => a.fingerprint)).toEqual([
      'cron:esign-reminders:crash',
      'cron:esign-reminders:repair-crash',
    ]);
    // 3 attempts per sweep.
    expect(h.queryRaw).toHaveBeenCalledTimes(6);
  });

  it('a non-connectivity failure inside a sweep alerts immediately, without retrying', async () => {
    h.repair.mockRejectedValue(
      Object.assign(new Error('column does not exist'), { code: 'P2022' }),
    );

    const out = await run();
    expect(h.repair).toHaveBeenCalledTimes(1);
    expect(out.signedCopyRepair).toMatchObject({ error: expect.stringContaining('column') });
    expect(h.alerts.map((a) => a.fingerprint)).toEqual(['cron:esign-reminders:repair-crash']);
  });
});
