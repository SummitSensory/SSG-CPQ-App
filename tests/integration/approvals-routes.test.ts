import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

async function tokenFor(role: string, sub = 'user-' + role): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub, role });
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerApprovalRoutes } = await import('../../src/routes/approvals.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerApprovalRoutes(app);
  await app.ready();
  return app;
}

describe('approval routes — permission boundaries', () => {
  it('rejects unauthenticated create with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/approvals', payload: { type: 'DISCOUNT', reason: 'x', requestedValue: '10' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects unauthenticated queue access with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/approvals/queue' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('validates the request body (400 on missing reason)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/approvals',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
      payload: { type: 'DISCOUNT', requestedValue: '10' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('requires notes to request a revision (400)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/approvals/some-id/request-revision',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('requires toUserId to escalate (400)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/approvals/some-id/escalate',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
