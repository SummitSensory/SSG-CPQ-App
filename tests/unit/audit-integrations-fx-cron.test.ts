import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Audit: /cron/fx-refresh (src/routes/cronFx.ts) and its interaction with the
 * rate-resolution cache in src/crossborder/rateService.ts.
 *
 * The cron's stated job is to put TODAY's Bank of Canada rate onto every open
 * Canadian draft. It runs at 23:00 UTC (vercel.json), after the Bank publishes
 * (~16:30 ET). But resolveRateForDate answers from ExchangeRateResolution first,
 * and a rep opening any Canadian proposal earlier in the day (crossBorderStateFor)
 * has already cached "today" -> yesterday's observation. The cron then reads that
 * cache, never asks the Bank, and stamps yesterday's rate on every draft.
 *
 * The Bank provider, prisma, alerts and the snapshot writer are all stubbed —
 * nothing reaches the network or a database.
 */

const h = vi.hoisted(() => ({
  cachedResolution: null as Record<string, unknown> | null,
  providerCalls: 0,
  todayIso: new Date().toISOString().slice(0, 10),
  alerts: [] as Array<{ title: string; fingerprint?: string }>,
}));

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get(target, prop, receiver) {
        if (prop === 'CRON_SECRET') return 'audit-cron-secret-0123456789';
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
  };
});
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/lib/audit.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../../src/lib/alerts.js', () => ({
  sendAlert: (a: { title: string; fingerprint?: string }) => h.alerts.push(a),
}));
vi.mock('../../src/crossborder/snapshot.js', () => ({
  writeCrossBorderSnapshot: vi.fn(async () => ({ snapshotId: 'snap-1' })),
}));
vi.mock('../../src/crossborder/fx.js', async (orig) => {
  const real = await orig<typeof import('../../src/crossborder/fx.js')>();
  class StubBank {
    readonly name = 'stub-bank';
    observationOnOrBefore(asOf: string) {
      h.providerCalls += 1;
      return Promise.resolve({
        pair: 'USD/CAD',
        rate: '1.4000',
        observationDate: asOf,
        source: 'BANK_OF_CANADA' as const,
        retrievedAt: new Date(),
      });
    }
  }
  return { ...real, BankOfCanadaExchangeRateProvider: StubBank };
});
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    crossBorderSetting: {
      findUnique: async () => ({
        id: 'singleton',
        enabled: true,
        fxFallbackMode: 'DRAFT_WITH_REVIEW',
        staleRateDays: 5,
      }),
    },
    exchangeRateResolution: {
      findUnique: async () => h.cachedResolution,
      upsert: async () => ({}),
    },
    exchangeRateObservation: { findFirst: async () => null, upsert: async () => ({}) },
    exchangeRateOverride: { findFirst: async () => null },
    $transaction: async (ops: unknown[]) => ops,
    proposalVersion: { findMany: async () => [{ id: 'v1' }, { id: 'v2' }] },
  },
}));

let app: FastifyInstance;
const AUTH = { authorization: 'Bearer audit-cron-secret-0123456789' };

beforeAll(async () => {
  const Fastify = (await import('fastify')).default;
  const { registerFxCronRoutes } = await import('../../src/routes/cronFx.js');
  app = Fastify();
  registerFxCronRoutes(app);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  h.cachedResolution = null;
  h.providerCalls = 0;
  h.alerts.length = 0;
});

function yesterday(): string {
  const d = new Date(`${h.todayIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe('/cron/fx-refresh', () => {
  it('with no cache: asks the Bank, refreshes every draft, raises no alert', async () => {
    const res = await app.inject({ method: 'GET', url: '/cron/fx-refresh', headers: AUTH });
    const out = res.json<{
      fallbackUsed: boolean;
      draftsUpdated: number;
      observation: { observationDate: string };
    }>();
    expect(res.statusCode).toBe(200);
    expect(h.providerCalls).toBe(1);
    expect(out.fallbackUsed).toBe(false);
    expect(out.observation.observationDate).toBe(h.todayIso);
    expect(out.draftsUpdated).toBe(2);
    expect(h.alerts).toHaveLength(0);
  });

  // DESIGN CONFLICT / BUG: the resolution cache ("a date resolves once") pins today
  // to yesterday's observation if anything resolved today before the Bank
  // published, and the cron honours that cache — so its own purpose is defeated.
  it.fails(
    'BUG: stores today’s published rate even if a morning page view cached yesterday’s for today',
    async () => {
      h.cachedResolution = {
        pair: 'USD/CAD',
        forDate: new Date(`${h.todayIso}T00:00:00Z`),
        observationDate: new Date(`${yesterday()}T00:00:00Z`),
        rate: '1.3500',
        source: 'BANK_OF_CANADA',
        resolvedAt: new Date(),
      };
      const res = await app.inject({ method: 'GET', url: '/cron/fx-refresh', headers: AUTH });
      const out = res.json<{ observation: { observationDate: string; rate: string } }>();
      expect(out.observation.observationDate).toBe(h.todayIso);
    },
  );
});
