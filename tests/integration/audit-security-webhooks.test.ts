import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * Security audit — inbound machine-to-machine endpoints: the Resend (Svix), DocuSeal
 * and monday webhooks, and every CRON_SECRET-gated route.
 *
 * src/config/env.ts parses process.env once at import, so the secrets are planted
 * in vi.hoisted, before anything imports it. All values are test-only.
 */
const secrets = vi.hoisted(() => {
  const s = {
    cron: 'audit-cron-secret-0123456789abcdef',
    resend: 'whsec_' + Buffer.from('audit-resend-signing-key-32bytes!').toString('base64'),
    docuseal: 'audit-docuseal-shared-secret',
    monday: 'audit-monday-signing-secret',
  };
  process.env.CRON_SECRET = s.cron;
  process.env.RESEND_WEBHOOK_SECRET = s.resend;
  process.env.DOCUSEAL_WEBHOOK_SECRET = s.docuseal;
  process.env.DOCUSEAL_API_TOKEN = 'audit-docuseal-token';
  process.env.MONDAY_SIGNING_SECRET = s.monday;
  process.env.MONDAY_API_TOKEN = 'audit-monday-token';
  return s;
});

vi.mock('../../src/lib/prisma.js', () => {
  // Lookups answer "not one of ours"; anything that would write is refused.
  const model = new Proxy(
    {},
    {
      get: (_t, method: string) =>
        method === 'findFirst' || method === 'findUnique'
          ? async () => null
          : () => Promise.reject(new Error('audit: database disabled')),
    },
  );
  return {
    prisma: new Proxy(
      {},
      {
        get: (_t, key: string) =>
          key.startsWith('$') ? () => Promise.reject(new Error('audit: db')) : model,
      },
    ),
  };
});

let app: FastifyInstance;

beforeAll(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('audit: network disabled')));
  const { buildApp } = await import('../../src/app.js');
  app = buildApp();
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ Resend / Svix

function svixSign(id: string, ts: string, body: string, secret = secrets.resend): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}

describe('POST /webhooks/resend', () => {
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'msg_1' } });
  const now = () => String(Math.floor(Date.now() / 1000));
  const send = (headers: Record<string, string>, payload = body) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/resend',
      headers: { 'content-type': 'application/json', ...headers },
      payload,
    });

  it('accepts a correctly signed, fresh event', async () => {
    const ts = now();
    const res = await send({
      'svix-id': 'msg_a',
      'svix-timestamp': ts,
      'svix-signature': svixSign('msg_a', ts, body),
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a request with no signature headers', async () => {
    expect((await send({})).statusCode).toBe(400);
  });

  it('refuses a bad signature', async () => {
    const ts = now();
    const res = await send({
      'svix-id': 'msg_a',
      'svix-timestamp': ts,
      'svix-signature': 'v1,' + Buffer.from('nope').toString('base64'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a signature made with a different secret', async () => {
    const ts = now();
    const other = 'whsec_' + Buffer.from('a-different-key').toString('base64');
    const res = await send({
      'svix-id': 'msg_a',
      'svix-timestamp': ts,
      'svix-signature': svixSign('msg_a', ts, body, other),
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a body altered after signing', async () => {
    const ts = now();
    const res = await send(
      { 'svix-id': 'msg_a', 'svix-timestamp': ts, 'svix-signature': svixSign('msg_a', ts, body) },
      body.replace('delivered', 'bounced'),
    );
    expect(res.statusCode).toBe(401);
  });

  it('refuses a correctly signed event outside the 5-minute window (replay)', async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await send({
      'svix-id': 'msg_a',
      'svix-timestamp': ts,
      'svix-signature': svixSign('msg_a', ts, body),
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a non-numeric timestamp', async () => {
    const res = await send({
      'svix-id': 'msg_a',
      'svix-timestamp': 'yesterday',
      'svix-signature': svixSign('msg_a', 'yesterday', body),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ------------------------------------------------------------------ DocuSeal

describe('POST /webhooks/docuseal', () => {
  const body = JSON.stringify({ event_type: 'form.completed', data: { submission_id: 42 } });
  const send = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/docuseal',
      headers: { 'content-type': 'application/json', ...headers },
      payload: body,
    });

  it('accepts the shared secret header', async () => {
    expect((await send({ 'x-webhook-secret': secrets.docuseal })).statusCode).toBe(200);
  });

  it('accepts a correct HMAC of the raw body', async () => {
    const sig = crypto.createHmac('sha256', secrets.docuseal).update(body).digest('hex');
    expect((await send({ 'x-docuseal-signature': sig })).statusCode).toBe(200);
  });

  it('refuses no credentials', async () => {
    expect((await send({})).statusCode).toBe(401);
  });

  it('refuses a wrong shared secret', async () => {
    expect((await send({ 'x-webhook-secret': secrets.docuseal + 'x' })).statusCode).toBe(401);
  });

  it('refuses a wrong HMAC', async () => {
    const sig = crypto.createHmac('sha256', 'wrong').update(body).digest('hex');
    expect((await send({ 'x-docuseal-signature': sig })).statusCode).toBe(401);
  });
});

// ------------------------------------------------------------------ monday

describe('POST /integrations/monday/webhook', () => {
  const payload = { event: { boardId: 1, pulseId: 2, columnId: 'status' } };
  const jwt = async (secret: string, opts: { iatOffset?: number; exp?: boolean } = {}) => {
    const { SignJWT } = await import('jose');
    let b = new SignJWT({ dat: { account_id: 1 } })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) + (opts.iatOffset ?? 0));
    if (opts.exp !== false) b = b.setExpirationTime('5m');
    return b.sign(new TextEncoder().encode(secret));
  };

  it('refuses an event with no Authorization', async () => {
    const res = await app.inject({ method: 'POST', url: '/integrations/monday/webhook', payload });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a JWT signed with the wrong secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/integrations/monday/webhook',
      headers: { authorization: await jwt('not-the-secret') },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an unsigned (alg: none) JWT', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const res = await app.inject({
      method: 'POST',
      url: '/integrations/monday/webhook',
      headers: { authorization: `${b64({ alg: 'none' })}.${b64({ dat: {} })}.` },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets a correctly signed event past the signature check', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/integrations/monday/webhook',
      headers: { authorization: await jwt(secrets.monday) },
      payload,
    });
    expect(res.statusCode).not.toBe(401);
  });

  // FINDING (low/medium): verifyMondayWebhook (src/integrations/monday/webhook.ts:8)
  // checks the signature only. monday's JWT does not cover the body, so a token
  // without `exp` — or with a long one — once observed (proxy log, debug capture) can
  // be replayed with ANY body forever, e.g. to move a deal's stage. Fix: require
  // `iat` within a few minutes (jwtVerify maxTokenAge: '5m') and dedupe on triggerUuid.
  it('refuses a signed token issued a year ago with no expiry (replay)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/integrations/monday/webhook',
      headers: {
        authorization: await jwt(secrets.monday, { iatOffset: -365 * 86400, exp: false }),
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ------------------------------------------------------------------ cron

describe('CRON_SECRET-gated routes', () => {
  const cronRoutes: Array<['GET' | 'POST', string]> = [
    ['GET', '/cron/portal-delivery'],
    ['POST', '/cron/portal-delivery'],
    ['GET', '/cron/receivables'],
    ['POST', '/cron/receivables'],
    ['POST', '/cron/scheduled-reports'],
    ['GET', '/cron/fx-refresh'],
    ['POST', '/cron/fx-refresh'],
    ['GET', '/cron/esign-reminders'],
    ['POST', '/cron/esign-reminders'],
    ['GET', '/cron/freight-pull'],
    ['POST', '/cron/freight-pull'],
    ['POST', '/freight/board-changed'],
  ];

  it.each(cronRoutes)('%s %s refuses no / wrong / staff credentials', async (method, url) => {
    const { signAccessToken } = await import('../../src/auth/tokens.js');
    const staff = await signAccessToken({ sub: 'user-SYSTEM_ADMIN', role: 'SYSTEM_ADMIN' });
    for (const authorization of [
      undefined,
      'Bearer ',
      'Bearer wrong',
      secrets.cron.slice(0, -1),
      `Bearer ${secrets.cron}x`,
      `Basic ${secrets.cron}`,
      `Bearer ${staff}`,
    ]) {
      const res = await app.inject({
        method,
        url,
        headers: authorization === undefined ? {} : { authorization },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(res.statusCode, `${method} ${url} with ${String(authorization)}`).toBe(401);
    }
  });
});
