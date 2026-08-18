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
    const res = await app.inject({
      method: 'GET',
      url: '/integrations/quickbooks/status',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('gates transaction creation behind quickbooks:transact', async () => {
    const app = await makeApp();
    // A read-only accounting-less role cannot prepare a financial transaction.
    const res = await app.inject({
      method: 'POST',
      url: '/integrations/quickbooks/transactions/prepare',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) },
      payload: { proposalVersionId: 'v1', type: 'DEPOSIT_INVOICE' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows ACCOUNTING to reach the transact handler (past authorization)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/integrations/quickbooks/transactions/prepare',
      headers: { authorization: 'Bearer ' + (await tokenFor('ACCOUNTING')) },
      payload: {},
    });
    // Authorized by RBAC, so it fails validation (400) rather than 403.
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
