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
