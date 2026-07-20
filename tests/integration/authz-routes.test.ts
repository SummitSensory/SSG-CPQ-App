import { describe, it, expect, beforeAll } from 'vitest';
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
    expect((await app.inject({ method: 'GET', url: '/internal/costs', headers: mgr })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/internal/integrations', headers: mgr })).statusCode).toBe(403);
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
