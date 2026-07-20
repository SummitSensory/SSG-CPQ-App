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
  const { registerCrmRoutes } = await import('../../src/routes/crm.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerCrmRoutes(app);
  await app.ready();
  return app;
}

// These assert authorization BEFORE any DB access — the preHandler rejects first.
describe('crm write authorization', () => {
  const body = { name: 'Test Org' };

  it('rejects unauthenticated writes with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/crm/organizations', payload: body });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects READ_ONLY and INSTALLER writes with 403', async () => {
    const app = await makeApp();
    for (const role of ['READ_ONLY', 'INSTALLER']) {
      const res = await app.inject({
        method: 'POST',
        url: '/crm/organizations',
        headers: { authorization: 'Bearer ' + (await tokenFor(role)) },
        payload: body,
      });
      expect(res.statusCode, role).toBe(403);
    }
    await app.close();
  });

  it('rejects reads from a role without crm:read', async () => {
    // Fabricate a token for a role that has no CRM permission at all.
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET);
    const token = await new SignJWT({ role: 'NONEXISTENT_ROLE' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('x')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/crm/organizations',
      headers: { authorization: 'Bearer ' + token },
    });
    expect(res.statusCode).toBe(401); // unknown role is rejected at auth
    await app.close();
  });
});
