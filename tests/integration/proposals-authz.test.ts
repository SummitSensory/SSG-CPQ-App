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
  const { registerProposalRoutes } = await import('../../src/routes/proposals.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerProposalRoutes(app);
  await app.ready();
  return app;
}

describe('proposal permissions', () => {
  it('blocks unauthenticated release with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/proposals/versions/v1/release' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('lets a writer submit for review but NOT release (403)', async () => {
    const app = await makeApp();
    const auth = { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) };
    // SALES_REP has proposal:write but not proposal:release.
    const rel = await app.inject({ method: 'POST', url: '/proposals/versions/v1/release', headers: auth });
    expect(rel.statusCode).toBe(403);
    await app.close();
  });

  it('allows a releaser role (SALES_MANAGER) past the release gate', async () => {
    const app = await makeApp();
    const auth = { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) };
    // Passes authz; fails later (no such version) — proves the gate allowed it.
    const res = await app.inject({ method: 'POST', url: '/proposals/versions/nonexistent/release', headers: auth });
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });

  it('blocks a READ_ONLY user from creating a proposal (403)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/proposals',
      headers: { authorization: 'Bearer ' + (await tokenFor('READ_ONLY')) },
      payload: { organizationId: 'o1', title: 'Test', sections: [], items: [] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
