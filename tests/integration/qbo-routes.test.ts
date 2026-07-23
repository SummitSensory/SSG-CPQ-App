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
  const { registerQuickbooksRoutes } = await import('../../src/routes/quickbooks.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerQuickbooksRoutes(app);
  await app.ready();
  return app;
}

async function tokenFor(role: string): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub: 'user-' + role, role });
}

describe('QuickBooks routes authorization', () => {
  it('requires authentication for status', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/integrations/quickbooks/status' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('forbids sales reps from managing the integration', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/integrations/quickbooks/status', headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('gates transaction creation behind quickbooks:transact', async () => {
    const app = await makeApp();
    // A read-only accounting-less role cannot prepare a financial transaction.
    const res = await app.inject({
      method: 'POST', url: '/integrations/quickbooks/transactions/prepare',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) },
      payload: { proposalVersionId: 'v1', type: 'DEPOSIT_INVOICE' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows ACCOUNTING to reach the transact handler (past authorization)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/integrations/quickbooks/transactions/prepare',
      headers: { authorization: 'Bearer ' + (await tokenFor('ACCOUNTING')) },
      payload: {},
    });
    // Authorized by RBAC, so it fails validation (400) rather than 403.
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
