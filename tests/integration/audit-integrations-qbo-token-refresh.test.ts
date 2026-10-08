import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit: QuickBooks access-token refresh (src/integrations/quickbooks/oauth.ts)
 * against a real local database.
 *
 * Intuit rotates the refresh token on use. getAccessToken has no single-flight
 * guard, so two requests that both see an expiring access token both refresh
 * with the same refresh token. The second is answered `invalid_grant`, and
 * getAccessToken then DEACTIVATES the connection — even though the first caller
 * just stored a perfectly good new token pair. Every QuickBooks screen then asks
 * for a reconnect.
 *
 * Intuit is emulated by an injected fetch. Nothing leaves the machine.
 * Refuses to run unless DATABASE_URL points at a local database.
 */

const dbUrl = process.env.DATABASE_URL ?? '';
const LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl);

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>();
  const overrides: Record<string, unknown> = {
    QBO_CLIENT_ID: 'audit-client',
    QBO_CLIENT_SECRET: 'audit-secret',
    QBO_TOKEN_ENC_KEY: 'audit-qbo-token-encryption-key-0123456789',
  };
  return {
    ...real,
    env: new Proxy(real.env, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && prop in overrides) return overrides[prop];
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
    qboEnvironment: () => 'SANDBOX',
  };
});
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const REALM = 'audit-realm-token-refresh';

/** Emulates Intuit: each refresh token is single-use and rotates. */
function intuit() {
  let valid = new Set(['RT-1']);
  let n = 1;
  const tokenCalls: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('openid')) return new Response('nope', { status: 404 });
    const body = new URLSearchParams(String(init?.body ?? ''));
    const rt = body.get('refresh_token') ?? '';
    tokenCalls.push(rt);
    // Simulate network latency so concurrent callers overlap.
    await new Promise((r) => setTimeout(r, 20));
    if (!valid.has(rt)) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }
    n += 1;
    valid = new Set([`RT-${n}`]);
    return new Response(
      JSON.stringify({
        access_token: `AT-${n}`,
        refresh_token: `RT-${n}`,
        expires_in: 3600,
        x_refresh_token_expires_in: 8_640_000,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { f, tokenCalls };
}

describe.skipIf(!LOCAL)('QuickBooks token refresh (local DB)', () => {
  beforeEach(async () => {
    const { prisma } = await import('../../src/lib/prisma.js');
    const { encryptToken } = await import('../../src/integrations/quickbooks/crypto.js');
    await prisma.qboConnection.deleteMany({ where: { realmId: REALM } });
    await prisma.qboConnection.create({
      data: {
        realmId: REALM,
        environment: 'SANDBOX',
        accessTokenEnc: encryptToken('AT-1'),
        refreshTokenEnc: encryptToken('RT-1'),
        // Expired access token: the next call must refresh.
        accessTokenExpiresAt: new Date(Date.now() - 1000),
        refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
        connectedById: 'audit-user',
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    const { prisma } = await import('../../src/lib/prisma.js');
    await prisma.qboConnection.deleteMany({ where: { realmId: REALM } });
    await prisma.$disconnect();
  });

  it('a single caller refreshes, persists the rotated pair, and stays active', async () => {
    const { getAccessToken } = await import('../../src/integrations/quickbooks/oauth.js');
    const { prisma } = await import('../../src/lib/prisma.js');
    const { decryptToken } = await import('../../src/integrations/quickbooks/crypto.js');
    const { f } = intuit();
    expect(await getAccessToken(REALM, f)).toBe('AT-2');
    const conn = await prisma.qboConnection.findFirstOrThrow({ where: { realmId: REALM } });
    expect(conn.isActive).toBe(true);
    expect(decryptToken(conn.refreshTokenEnc)).toBe('RT-2');
    // A second call within the access token's life does not hit Intuit.
    const second = intuit();
    expect(await getAccessToken(REALM, second.f)).toBe('AT-2');
    expect(second.tokenCalls).toHaveLength(0);
  });

  it('an expired refresh token deactivates without calling Intuit', async () => {
    const { getAccessToken } = await import('../../src/integrations/quickbooks/oauth.js');
    const { prisma } = await import('../../src/lib/prisma.js');
    await prisma.qboConnection.updateMany({
      where: { realmId: REALM },
      data: { refreshTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    const { f, tokenCalls } = intuit();
    await expect(getAccessToken(REALM, f)).rejects.toThrow(/expired/i);
    expect(tokenCalls).toHaveLength(0);
    const conn = await prisma.qboConnection.findFirstOrThrow({ where: { realmId: REALM } });
    expect(conn.isActive).toBe(false);
  });

  // BUG: no single-flight / row lock around the refresh. Two concurrent callers
  // both spend RT-1; the loser gets invalid_grant and deactivates a connection
  // that the winner just refreshed successfully.
  it('BUG: two concurrent callers both get a token and the connection stays active', async () => {
    const { getAccessToken } = await import('../../src/integrations/quickbooks/oauth.js');
    const { prisma } = await import('../../src/lib/prisma.js');
    const { f } = intuit();
    const results = await Promise.allSettled([getAccessToken(REALM, f), getAccessToken(REALM, f)]);
    const conn = await prisma.qboConnection.findFirstOrThrow({ where: { realmId: REALM } });
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(conn.isActive).toBe(true);
  });
});
