import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit: Outlook (Microsoft Graph) token refresh — src/integrations/microsoft/graph.ts
 * accessTokenFor(), reached through sendOutlookMail().
 *
 * accessTokenFor wraps the refresh in a catch-all that sets `revokedAt` on ANY
 * failure. A dead grant (invalid_grant) should revoke; a transient failure — DNS
 * blip, socket reset, a 503 with an HTML body that makes res.json() throw — should
 * not. Revoking turns a one-second network hiccup into "reconnect Outlook" for the
 * rep, silently stops their scheduled reports, and reroutes their e-sign emails to
 * the fallback mailbox.
 *
 * Global fetch is stubbed; nothing reaches Microsoft. Runs only against a local DB.
 */

const dbUrl = process.env.DATABASE_URL ?? '';
const LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl);
const ENC_KEY = 'audit-graph-token-encryption-key-0123456789';

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>();
  const overrides: Record<string, unknown> = {
    GRAPH_TOKEN_ENC_KEY: 'audit-graph-token-encryption-key-0123456789',
    ENTRA_TENANT_ID: 'audit-tenant',
    ENTRA_CLIENT_ID: 'audit-client',
    ENTRA_CLIENT_SECRET: 'audit-secret',
  };
  return {
    ...real,
    env: new Proxy(real.env, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && prop in overrides) return overrides[prop];
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
  };
});
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** Same format graph.ts uses: base64(iv | ciphertext | tag), key = sha256(ENC_KEY). */
function enc(plaintext: string): string {
  const key = createHash('sha256').update(ENC_KEY).digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64');
}

const EMAIL = 'audit-outlook-refresh@example.test';
let userId = '';
const realFetch = globalThis.fetch;

describe.skipIf(!LOCAL)('Outlook token refresh (local DB)', () => {
  beforeAll(async () => {
    const { prisma } = await import('../../src/lib/prisma.js');
    const u = await prisma.user.upsert({
      where: { email: EMAIL },
      update: {},
      create: { email: EMAIL, passwordHash: 'x', name: 'Audit Outlook' },
    });
    userId = u.id;
  });

  beforeEach(async () => {
    const { prisma } = await import('../../src/lib/prisma.js');
    await prisma.outlookConnection.deleteMany({ where: { userId } });
    await prisma.outlookConnection.create({
      data: {
        userId,
        mailbox: EMAIL,
        accessToken: enc('old-access'),
        refreshToken: enc('refresh-1'),
        expiresAt: new Date(Date.now() - 1000), // expired: next send refreshes
        scope: 'offline_access Mail.ReadWrite Mail.Send',
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    const { prisma } = await import('../../src/lib/prisma.js');
    await prisma.outlookConnection.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await prisma.$disconnect();
  });

  async function trySend(): Promise<unknown> {
    const { sendOutlookMail } = await import('../../src/integrations/microsoft/graph.js');
    return sendOutlookMail({
      userId,
      to: [{ email: 'customer@example.test' }],
      subject: 's',
      html: '<p>x</p>',
    }).catch((e: unknown) => e);
  }

  async function revokedAt(): Promise<Date | null> {
    const { prisma } = await import('../../src/lib/prisma.js');
    const c = await prisma.outlookConnection.findUniqueOrThrow({ where: { userId } });
    return c.revokedAt;
  }

  it('a dead grant (invalid_grant) revokes the connection', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS70008 expired' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    const err = await trySend();
    expect((err as Error).name).toBe('OutlookNotConnectedError');
    expect(await revokedAt()).not.toBeNull();
  });

  // BUG: catch-all in accessTokenFor revokes on a network error.
  it.fails(
    'BUG: a transient network failure during refresh does not revoke the mailbox',
    async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      await trySend();
      expect(await revokedAt()).toBeNull();
    },
  );

  // BUG: a 503 with an HTML body makes res.json() throw inside tokenRequest; the
  // same catch-all revokes.
  it.fails(
    'BUG: a Microsoft 503 (HTML body) during refresh does not revoke the mailbox',
    async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response('<html>Service Unavailable</html>', {
            status: 503,
            headers: { 'content-type': 'text/html' },
          }),
      ) as unknown as typeof fetch;
      await trySend();
      expect(await revokedAt()).toBeNull();
    },
  );
});
