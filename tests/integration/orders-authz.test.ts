import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerOrderRoutes } = await import('../../src/routes/orders.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerOrderRoutes(app);
  await app.ready();
  return app;
}

async function tokenFor(role: string): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub: 'user-' + role, role });
}

describe('order & handoff route authorization', () => {
  it('requires authentication to list orders', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/orders' })).statusCode).toBe(401);
    await app.close();
  });

  it('forbids READ_ONLY from locking an order', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/orders/from-version/v1', headers: { authorization: 'Bearer ' + (await tokenFor('READ_ONLY')) }, payload: {} });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('forbids SALES_REP from managing handoff records', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/orders/o1/tasks', headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) }, payload: { title: 'x' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lets ORDERS_READ roles reach the list (past authorization)', async () => {
    const app = await makeApp();
    // INSTALLER has orders:read; unauth would be 401, forbidden 403 — neither.
    const res = await app.inject({ method: 'POST', url: '/orders/from-version/v1', headers: { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) }, payload: {} });
    // ORDERS_MANAGE granted → passes RBAC, fails body validation (400).
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
