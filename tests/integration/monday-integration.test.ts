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
  process.env.MONDAY_SIGNING_SECRET ??= 'test-monday-signing-secret';
});

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerIntegrationRoutes } = await import('../../src/routes/integrations.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerIntegrationRoutes(app);
  await app.ready();
  return app;
}

async function tokenFor(role: string): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub: 'user-' + role, role });
}

describe('monday integration routes', () => {
  it('echoes the webhook challenge handshake', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/integrations/monday/webhook',
      payload: { challenge: 'xyz' },
    });
    expect(res.json()).toEqual({ challenge: 'xyz' });
    await app.close();
  });

  it('rejects an unsigned webhook event with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/integrations/monday/webhook',
      payload: { event: { pulseId: 1, columnId: 'status' } },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts a validly signed webhook (verifier unit)', async () => {
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({ ok: true })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(process.env.MONDAY_SIGNING_SECRET));
    const { verifyMondayWebhook } = await import('../../src/integrations/monday/webhook.js');
    expect(await verifyMondayWebhook('Bearer ' + token)).toBe(true);
    expect(await verifyMondayWebhook('Bearer nope')).toBe(false);
  });

  it('gates status/reconcile/retry behind integrations:manage', async () => {
    const app = await makeApp();
    const noauth = await app.inject({ method: 'GET', url: '/integrations/monday/reconcile' });
    expect(noauth.statusCode).toBe(401);
    const forbidden = await app.inject({
      method: 'GET',
      url: '/integrations/monday/reconcile',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
});
