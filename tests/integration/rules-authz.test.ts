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
  const { registerRuleRoutes } = await import('../../src/routes/rules.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerRuleRoutes(app);
  await app.ready();
  return app;
}

describe('rules admin authorization', () => {
  it('blocks rule creation for a non-manager (READ_ONLY) with 403', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/rules',
      headers: { authorization: 'Bearer ' + (await tokenFor('READ_ONLY')) },
      payload: { key: 'x', type: 'EXCLUDES', outcome: 'BLOCK', params: { productId: 'B' } },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('blocks unauthenticated evaluation with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/rules/evaluate', payload: { lines: [{ productId: 'A', quantity: 1 }] } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('allows a RULES_MANAGE role (DESIGNER) past the authz gate', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/rules',
      headers: { authorization: 'Bearer ' + (await tokenFor('DESIGNER')) },
      // Invalid body → 400 from validation, but NOT 403 — proves authz passed.
      payload: { key: 'Bad Key!', type: 'EXCLUDES', outcome: 'BLOCK' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
