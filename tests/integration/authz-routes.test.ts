import { describe, it, expect, beforeAll, vi } from 'vitest';
/**
 * These suites mount routes without a database on purpose, and mint synthetic tokens
 * for users that were never inserted. `requireAuth` now verifies live account state
 * (so a deactivated or demoted user cannot spend a token minted before the change),
 * which means it needs a User row to read. Mock it: the role is taken from the id the
 * token carries (`user-SALES_REP` -> SALES_REP), so each case still exercises exactly
 * the role it is named for, and the authorization decision is still made on account
 * state rather than on the token's own claim.
 */
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
  },
}));

import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

async function tokenFor(role: string): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub: 'user-' + role, role });
}

async function makeApp(): Promise<FastifyInstance> {
  // Only mount the protected routes so the suite needs no database.
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerProtectedRoutes } = await import('../../src/routes/protected.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerProtectedRoutes(app);
  await app.ready();
  return app;
}

describe('server-side route authorization', () => {
  const cases: Array<{ method: 'GET' | 'POST'; url: string }> = [
    { method: 'GET', url: '/internal/costs' },
    { method: 'GET', url: '/internal/margins' },
    { method: 'POST', url: '/internal/discounts/authorize' },
    { method: 'GET', url: '/internal/accounting' },
    { method: 'POST', url: '/internal/accounting/post' },
    { method: 'GET', url: '/internal/integrations' },
    { method: 'GET', url: '/internal/products/admin' },
  ];

  it('rejects unauthenticated requests with 401', async () => {
    const app = await makeApp();
    for (const c of cases) {
      const res = await app.inject({ method: c.method, url: c.url });
      expect(res.statusCode).toBe(401);
    }
    await app.close();
  });

  it('rejects READ_ONLY and SALES_REP with 403 on every protected route', async () => {
    const app = await makeApp();
    for (const role of ['READ_ONLY', 'SALES_REP']) {
      const auth = { authorization: 'Bearer ' + (await tokenFor(role)) };
      for (const c of cases) {
        const res = await app.inject({ method: c.method, url: c.url, headers: auth });
        expect(res.statusCode, role + ' ' + c.url).toBe(403);
      }
    }
    await app.close();
  });

  it('allows SYSTEM_ADMIN everywhere and SALES_MANAGER only where permitted', async () => {
    const app = await makeApp();
    const admin = { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) };
    for (const c of cases) {
      const res = await app.inject({ method: c.method, url: c.url, headers: admin });
      expect(res.statusCode, 'admin ' + c.url).toBe(200);
    }
    const mgr = { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) };
    expect(
      (await app.inject({ method: 'GET', url: '/internal/costs', headers: mgr })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/internal/integrations', headers: mgr })).statusCode,
    ).toBe(403);
    await app.close();
  });

  it('rejects a tampered/invalid token with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/internal/costs',
      headers: { authorization: 'Bearer not.a.valid.token' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
