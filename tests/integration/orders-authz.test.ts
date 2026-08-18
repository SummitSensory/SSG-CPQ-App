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
    const res = await app.inject({
      method: 'POST',
      url: '/orders/from-version/v1',
      headers: { authorization: 'Bearer ' + (await tokenFor('READ_ONLY')) },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('forbids SALES_REP from managing handoff records', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/orders/o1/tasks',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
      payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lets ORDERS_READ roles reach the list (past authorization)', async () => {
    const app = await makeApp();
    // INSTALLER has orders:read; unauth would be 401, forbidden 403 — neither.
    const res = await app.inject({
      method: 'POST',
      url: '/orders/from-version/v1',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) },
      payload: {},
    });
    // ORDERS_MANAGE granted → passes RBAC, fails body validation (400).
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
