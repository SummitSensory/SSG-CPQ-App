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
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerCatalogRoutes } = await import('../../src/routes/catalog.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerCatalogRoutes(app);
  await app.ready();
  return app;
}

describe('catalog role restrictions', () => {
  it('blocks non-admin product creation with 403 (SALES_REP has catalog:read only)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/catalog/products',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
      payload: { sku: 'ABC-123', name: 'Swing', categoryId: 'c1' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
  it('blocks unauthenticated import with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/catalog/import', payload: { rows: [] } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
