import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * GET /health/config — the deploy settings the audit fixes depend on, as yes/no.
 * It must never echo a secret, and only a user administrator may ask.
 */

const RUN = Date.now().toString(36);
let app: FastifyInstance;
const userIds: Record<string, string> = {};

beforeAll(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled')));
  const { prisma } = await import('../../src/lib/prisma.js');
  for (const role of ['SYSTEM_ADMIN', 'SALES_REP'] as const) {
    const u = await prisma.user.create({
      data: { email: `hc-${RUN}-${role.toLowerCase()}@example.com`, passwordHash: 'x', role },
    });
    userIds[role] = u.id;
  }
  const { buildApp } = await import('../../src/app.js');
  app = buildApp();
  await app.ready();
}, 60_000);

afterAll(async () => {
  const { prisma } = await import('../../src/lib/prisma.js');
  await prisma.user.deleteMany({ where: { id: { in: Object.values(userIds) } } });
  await app?.close();
  vi.unstubAllGlobals();
});

async function bearer(role: 'SYSTEM_ADMIN' | 'SALES_REP'): Promise<Record<string, string>> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  const sub = userIds[role] ?? '';
  return { authorization: 'Bearer ' + (await signAccessToken({ sub, role })) };
}

describe('GET /health/config', () => {
  it('refuses an anonymous caller and a non-admin', async () => {
    expect((await app.inject({ method: 'GET', url: '/health/config' })).statusCode).toBe(401);
    const rep = await app.inject({
      method: 'GET',
      url: '/health/config',
      headers: await bearer('SALES_REP'),
    });
    expect(rep.statusCode).toBe(403);
  });

  it('reports each setting without returning any secret', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/config',
      headers: await bearer('SYSTEM_ADMIN'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      passwordResetLinks: { ok: boolean; origin: string | null; source: string | null };
      jwtSecrets: { ok: boolean; shorterThan32: string[] };
      pricingThresholds: {
        minMarginBps: number | null;
        discountAuthorityBps: number | null;
        enforced: boolean;
      };
    }>();
    // Outside production the reset link falls back to localhost and the JWT length
    // rule does not apply; both must still read as ok.
    expect(body.passwordResetLinks.ok).toBe(true);
    expect(body.jwtSecrets).toEqual({ ok: true, shorterThan32: [] });
    expect(typeof body.pricingThresholds.enforced).toBe('boolean');

    const raw = res.body;
    for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'DATABASE_URL'] as const) {
      const v = process.env[k];
      if (v) expect(raw).not.toContain(v);
    }
  });
});
