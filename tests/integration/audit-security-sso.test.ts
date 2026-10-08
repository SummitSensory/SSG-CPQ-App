import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Security audit — browser sign-in flows: Entra SSO (redirect target, token hand-off
 * page), password reset link construction, login throttling, and the Outlook
 * consent callback. Entra/Graph settings are planted before env.ts is imported;
 * every value is a test placeholder and no request leaves the process.
 */
vi.hoisted(() => {
  process.env.ENTRA_TENANT_ID = 'audit-tenant';
  process.env.ENTRA_CLIENT_ID = 'audit-client';
  process.env.ENTRA_CLIENT_SECRET = 'audit-client-secret';
  process.env.ENTRA_REDIRECT_URI = 'https://crm.audit.example/auth/sso/callback';
  process.env.GRAPH_REDIRECT_URI = 'https://crm.audit.example/me/outlook/callback';
  process.env.GRAPH_TOKEN_ENC_KEY = 'audit-graph-token-encryption-key-0123456789';
  delete process.env.APP_BASE_URL;
});

const captured = vi.hoisted(() => ({
  resetBaseUrl: null as string | null,
  upserts: [] as unknown[],
}));

vi.mock('../../src/lib/prisma.js', () => {
  const refuse = () => Promise.reject(new Error('audit: database disabled'));
  const user = {
    id: 'user-SALES_REP',
    email: 'rep@summitsensory.com',
    name: 'Rep',
    role: 'SALES_REP',
    isActive: true,
  };
  const models: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> = {
    user: {
      findUnique: async () => user,
      findFirst: async () => null,
      count: async () => 1,
    },
    session: { create: async () => ({}) },
    outlookConnection: {
      upsert: async (arg: unknown) => {
        captured.upserts.push(arg);
        return {};
      },
    },
  };
  return {
    prisma: new Proxy(
      {},
      {
        get: (_t, key: string) =>
          new Proxy(models[key] ?? {}, {
            get: (target, m: string) => target[m] ?? refuse,
          }),
      },
    ),
  };
});

vi.mock('../../src/auth/entra.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/auth/entra.js')>();
  return {
    ...orig,
    completeLogin: async () => ({
      email: 'rep@summitsensory.com',
      oid: 'oid-1',
      groups: [],
      groupsOverage: false,
    }),
  };
});

vi.mock('../../src/auth/passwordReset.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/auth/passwordReset.js')>();
  return {
    ...orig,
    requestPasswordReset: async (_email: string, baseUrl: string) => {
      captured.resetBaseUrl = baseUrl;
    },
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

/** Start SSO with a returnTo and read back the returnTo the signed state carries. */
async function returnToFor(returnTo: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: `/auth/sso/start?returnTo=${encodeURIComponent(returnTo)}`,
  });
  expect(res.statusCode).toBe(302);
  const state = new URL(String(res.headers.location)).searchParams.get('state')!;
  const payload = JSON.parse(Buffer.from(state.split('.')[1]!, 'base64url').toString()) as {
    returnTo: string;
  };
  return payload.returnTo;
}

describe('SSO start: returnTo is same-site only', () => {
  it('keeps an ordinary path', async () => {
    expect(await returnToFor('/orders/123')).toBe('/orders/123');
  });

  it.each(['https://evil.example/', '//evil.example/', 'javascript:alert(1)'])(
    'drops %s',
    async (target) => {
      expect(await returnToFor(target)).toBe('/');
    },
  );

  // FINDING (medium): src/routes/sso.ts:51 only rejects a leading `//`. Browsers
  // treat `/\` exactly like `//`, so location.replace('/\\evil.example') in the
  // hand-off page navigates off-site — an open redirect immediately after a real
  // Microsoft sign-in. Fix: parse with new URL(returnTo, origin) and require the
  // same origin, or allow only /^\/(?![\\/])/.
  it.fails('drops a backslash-prefixed path (/\\evil.example)', async () => {
    expect(await returnToFor('/\\evil.example/')).toBe('/');
  });
});

describe('SSO callback hand-off page', () => {
  // FINDING (high): handoffPage (src/routes/sso.ts:24-30) writes JSON.stringify(...)
  // straight into an inline <script>. JSON.stringify does not escape `<`, so a
  // returnTo of `/</script><script>…` closes the script and runs attacker markup —
  // on the one page whose CSP is `script-src 'unsafe-inline'`, and which holds the
  // freshly minted access + refresh tokens. Attack: send a victim
  // /auth/sso/start?returnTo=/%3C/script%3E%3Cscript%3E…; Microsoft SSO usually
  // completes silently; the injected script reads localStorage ssg_at/ssg_rt.
  // Fix: escape `<`, `>`, `&`, U+2028/2029 in the embedded JSON (e.g.
  // .replace(/</g,'\\u003c')), and validate returnTo against a strict path pattern.
  it.fails('a returnTo cannot break out of the inline script', async () => {
    const { createState } = await import('../../src/auth/entra.js');
    const { state } = await createState('/</script><script>window.pwned=1</script>');
    const res = await app.inject({
      method: 'GET',
      url: `/auth/sso/callback?code=c&state=${encodeURIComponent(state)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('</script><script>window.pwned=1');
  });

  it('escapes the provider error text on the failure page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/sso/callback?error=x&error_description=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&#60;img');
  });

  it('refuses a forged state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/sso/callback?code=c&state=eyJhbGciOiJIUzI1NiJ9.e30.forged',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('password reset link construction', () => {
  // FINDING (medium, if APP_BASE_URL is unset in production — it is absent from
  // .env.example): src/routes/auth.ts:212-215 builds the emailed reset link from
  // X-Forwarded-Host / Host. Anyone can request a reset for a colleague with
  // X-Forwarded-Host: attacker.example; the real email then carries a link that
  // hands the reset token to the attacker when clicked (reset-link poisoning).
  // Fix: require APP_BASE_URL in production (boot-time check) and never derive it
  // from request headers.
  it.fails('a forged X-Forwarded-Host does not end up in the reset link', async () => {
    captured.resetBaseUrl = null;
    const res = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      headers: { 'x-forwarded-host': 'attacker.example' },
      payload: { email: 'victim@summitsensory.com' },
    });
    expect(res.statusCode).toBe(204);
    expect(captured.resetBaseUrl).not.toContain('attacker.example');
  });
});

describe('login throttling', () => {
  it('refuses the 11th attempt for one address with 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'throttle-target@example.com', password: 'wrong' },
        remoteAddress: `10.0.0.${i + 1}`, // rotate IPs: the address bucket must still trip
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('Outlook consent binds the mailbox to the user who started it', () => {
  // FINDING (medium): completeConsent (src/integrations/microsoft/graph.ts:191) stores
  // whatever mailbox Microsoft returns under the user id in the state. Any staff user
  // can mint a consent URL (POST /me/outlook/connect, CRM_READ) and get a colleague to
  // click it; the colleague's Mail.Send/Mail.ReadWrite tokens are then stored on the
  // attacker's CRM account, and every "send from my Outlook" path sends as the
  // colleague. Fix: require mailbox === user.email (case-insensitive), or compare
  // the Graph /me id to the user's Entra oid.
  it.fails('refuses a mailbox that is not the CRM user’s own', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/oauth2/v2.0/token')) {
        return new Response(
          JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ mail: 'ceo@summitsensory.com' }), { status: 200 });
    });
    try {
      captured.upserts.length = 0;
      const { completeConsent } = await import('../../src/integrations/microsoft/graph.js');
      await expect(completeConsent('code', 'user-SALES_REP')).rejects.toThrow();
      expect(captured.upserts).toHaveLength(0);
    } finally {
      vi.stubGlobal('fetch', () => Promise.reject(new Error('audit: network disabled')));
    }
  });
});
