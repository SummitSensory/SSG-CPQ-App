import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';

/**
 * Security audit — the whole route table, enumerated at runtime.
 *
 * Every route `buildApp()` registers is captured through an `onRoute` hook, and the
 * guard each one carries is read off the preHandler: `requirePermission` and
 * `requireAuth` are wrapped (behaviour unchanged) so the permission they enforce is
 * visible on the function. That makes the matrix exact rather than grepped, and it
 * means a route added tomorrow is covered by these assertions without editing them.
 *
 * No database. Prisma is replaced by a proxy that answers only the live-account
 * lookup `requireAuth` makes (role derived from the id the token carries) and refuses
 * everything else, so a request that is wrongly let through shows up as a non-401/403
 * rather than touching anything. `fetch` is stubbed so nothing leaves the process.
 */

// ---------------------------------------------------------------- mocks

const dbState = vi.hoisted(() => ({
  section: null as null | { orderId: string },
  order: null as null | { proposalId: string },
}));

vi.mock('../../src/lib/prisma.js', () => {
  const refuse = (): Promise<never> => Promise.reject(new Error('audit: database disabled'));
  const userFindUnique = async ({ where }: { where: { id: string } }) => {
    const id = String(where.id);
    // user-<ROLE>            -> active, that role
    // inactive-<ROLE>        -> deactivated
    // demoted-<anything>     -> active, READ_ONLY in the database
    if (id.startsWith('user-')) return { isActive: true, role: id.slice(5) };
    if (id.startsWith('inactive-')) return { isActive: false, role: id.slice(9) };
    if (id.startsWith('demoted-')) return { isActive: true, role: 'READ_ONLY' };
    return null;
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => {
          if (name === 'user' && method === 'findUnique') return userFindUnique;
          if (name === 'bomVendorSection' && method === 'findUnique')
            return async () => dbState.section;
          if (name === 'acceptedOrder' && method === 'findUnique') return async () => dbState.order;
          return refuse;
        },
      },
    );
  return {
    prisma: new Proxy(
      {},
      { get: (_t, key: string) => (key.startsWith('$') ? refuse : model(key)) },
    ),
  };
});

vi.mock('../../src/plugins/authz.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/plugins/authz.js')>();
  const requireAuth = Object.assign(
    (...a: Parameters<typeof orig.requireAuth>) => orig.requireAuth(...a),
    { __guard: 'AUTH' },
  );
  return {
    ...orig,
    requireAuth,
    requirePermission: (p: string) => Object.assign(orig.requirePermission(p), { __guard: p }),
  };
});

interface CapturedRoute {
  method: string;
  url: string;
  guards: string[];
}
const captured = vi.hoisted(() => ({ routes: [] as CapturedRoute[] }));

vi.mock('fastify', async (importOriginal) => {
  const m = await importOriginal<typeof import('fastify')>();
  const wrapped = (opts: unknown): FastifyInstance => {
    const app = (m.default as unknown as (o: unknown) => FastifyInstance)(opts);
    app.addHook('onRoute', (r: RouteOptions) => {
      const hooks = ([] as unknown[]).concat(
        r.onRequest ?? [],
        r.preValidation ?? [],
        r.preHandler ?? [],
      );
      const guards = hooks.map((h) => (h as { __guard?: string }).__guard ?? 'unknown-hook');
      for (const method of ([] as string[]).concat(r.method as string | string[])) {
        if (method === 'HEAD') continue;
        captured.routes.push({ method, url: r.url, guards });
      }
    });
    return app;
  };
  return { ...m, default: wrapped };
});

// ---------------------------------------------------------------- helpers

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

async function bearer(sub: string, role: string): Promise<Record<string, string>> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return { authorization: 'Bearer ' + (await signAccessToken({ sub, role })) };
}

/** `/a/:id/b/:part` -> `/a/audit-x/b/audit-x`; wildcards likewise. */
function concrete(url: string): string {
  return url.replace(/:[A-Za-z0-9_]+/g, 'audit-x').replace(/\*/g, 'audit-x');
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function call(method: string, url: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: method as Method,
    url,
    headers,
    ...(MUTATING.has(method) ? { payload: {} } : {}),
  });
}

/**
 * Routes that are deliberately reachable without a session, and what authenticates
 * them instead. Anything unguarded that is NOT on this list fails the first test.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  'GET /health': 'liveness',
  'GET /health/db': 'liveness',
  'GET /health/schema': 'deploy diagnostics (no data)',
  'GET /build-info': 'deploy diagnostics',
  'GET /render/status': 'renderer diagnostics',
  'POST /webhooks/resend': 'Svix HMAC + 5 min timestamp window',
  'POST /webhooks/docuseal': 'shared secret header or HMAC',
  'POST /integrations/monday/webhook': 'monday HS256 JWT',
  'POST /auth/login': 'credentials, rate limited',
  'POST /auth/refresh': 'opaque refresh token',
  'POST /auth/logout': 'opaque refresh token',
  'POST /auth/forgot-password': 'always 204, rate limited',
  'GET /auth/reset-password': 'reset token',
  'POST /auth/reset-password': 'reset token, rate limited',
  'GET /auth/sso/status': 'boolean only',
  'GET /auth/sso/start': 'starts OIDC',
  'GET /auth/sso/callback': 'signed state + OIDC id_token',
  'GET /integrations/quickbooks/callback': 'signed state',
  'GET /integrations/canva/callback': 'single-use state',
  'GET /me/outlook/callback': 'signed state',
  'GET /cron/freight-pull': 'CRON_SECRET',
  'POST /cron/freight-pull': 'CRON_SECRET',
  'POST /freight/board-changed': 'CRON_SECRET',
  'GET /cron/portal-delivery': 'CRON_SECRET',
  'POST /cron/portal-delivery': 'CRON_SECRET',
  'GET /cron/receivables': 'CRON_SECRET',
  'POST /cron/receivables': 'CRON_SECRET',
  'POST /cron/scheduled-reports': 'CRON_SECRET',
  'GET /cron/fx-refresh': 'CRON_SECRET',
  'POST /cron/fx-refresh': 'CRON_SECRET',
  'GET /cron/esign-reminders': 'CRON_SECRET',
  'POST /cron/esign-reminders': 'CRON_SECRET',
  'GET /portal/status': 'feature flag only',
  'GET /portal/colors/:token': 'hashed link token, rate limited',
  'POST /portal/colors/:token': 'hashed link token, rate limited',
  'GET /': 'static shell',
  'GET /legal/privacy': 'static page',
  'GET /legal/eula': 'static page',
  'GET /quickbooks': 'static page',
  'GET /quickbooks/connect': 'static page (Intuit listing URL)',
  'GET /quickbooks/disconnect': 'static page (Intuit listing URL)',
};
const STATIC_ASSET = /^\/[a-z0-9-]+\.(js|png|ico)$/;

const ROLES_WITHOUT_ADMIN = [
  'EXECUTIVE',
  'SALES_REP',
  'SALES_MANAGER',
  'DESIGNER',
  'ESTIMATOR',
  'OPERATIONS',
  'ACCOUNTING',
  'PROJECT_MANAGER',
  'INSTALLER',
  'READ_ONLY',
] as const;

// ---------------------------------------------------------------- tests

describe('route/permission matrix', () => {
  it('captures the whole route table', () => {
    // Sanity: if this drops sharply the capture hook stopped working, and every
    // table-driven test below would pass vacuously.
    expect(captured.routes.length).toBeGreaterThan(500);
  });

  it('every unguarded route is on the reviewed public allowlist', () => {
    const unexpected = captured.routes
      .filter((r) => r.guards.length === 0)
      .map((r) => `${r.method} ${r.url}`)
      .filter((k) => !(k in PUBLIC_ROUTES) && !STATIC_ASSET.test(k.split(' ')[1]!));
    expect(unexpected).toEqual([]);
  });

  it('no route carries a hook the audit cannot identify as a guard', () => {
    const odd = captured.routes
      .filter((r) => r.guards.includes('unknown-hook'))
      .map((r) => `${r.method} ${r.url}`);
    expect(odd).toEqual([]);
  });

  it('every guarded route answers 401 without a token', async () => {
    const wrong: string[] = [];
    for (const r of captured.routes.filter((x) => x.guards.length)) {
      const res = await call(r.method, concrete(r.url));
      if (res.statusCode !== 401) wrong.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it('every guarded route answers 401 to a garbage bearer token', async () => {
    const wrong: string[] = [];
    for (const r of captured.routes.filter((x) => x.guards.length)) {
      const res = await call(r.method, concrete(r.url), {
        authorization: 'Bearer not.a.real.token',
      });
      if (res.statusCode !== 401) wrong.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it('every mutating route answers 403 to a role lacking its permission', async () => {
    const { can } = await import('../../src/authz/rbac.js');
    const wrong: string[] = [];
    let checked = 0;
    for (const r of captured.routes) {
      if (!MUTATING.has(r.method)) continue;
      const perm = r.guards.find((g) => g !== 'AUTH');
      if (!perm) continue;
      const role = ROLES_WITHOUT_ADMIN.find((ro) => !can(ro, perm));
      if (!role) continue; // every role holds it — see the weak-permission table below
      checked++;
      const res = await call(r.method, concrete(r.url), await bearer(`user-${role}`, role));
      if (res.statusCode !== 403)
        wrong.push(`${r.method} ${r.url} as ${role} -> ${res.statusCode}`);
    }
    expect(checked).toBeGreaterThan(300);
    expect(wrong).toEqual([]);
  }, 120_000);

  it('every route guarded by a permission refuses READ_ONLY unless READ_ONLY holds it', async () => {
    const { can } = await import('../../src/authz/rbac.js');
    const auth = await bearer('user-READ_ONLY', 'READ_ONLY');
    const wrong: string[] = [];
    for (const r of captured.routes) {
      const perm = r.guards.find((g) => g !== 'AUTH');
      if (!perm || can('READ_ONLY', perm)) continue;
      const res = await call(r.method, concrete(r.url), auth);
      if (res.statusCode !== 403) wrong.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  /**
   * The weak-permission table: mutating routes whose guard is a *read* permission (or
   * bare login), so READ_ONLY / INSTALLER pass it. Pinned here so a change to it is a
   * deliberate diff. Pure computations (evaluate, quote, preview, calculate) are fine;
   * the ones that change state or send mail are called out as findings below.
   */
  it('pins the set of mutating routes that only need a read permission or a login', () => {
    const weak = captured.routes
      .filter((r) => MUTATING.has(r.method) && r.guards.length)
      .filter((r) => r.guards.every((g) => g === 'AUTH' || g.endsWith(':read')))
      .map((r) => `${r.method} ${r.url} [${r.guards.join('+')}]`)
      .sort();
    expect(weak).toMatchInlineSnapshot(`
      [
        "DELETE /me/outlook [crm:read]",
        "PATCH /auth/me [AUTH]",
        "POST /approvals [AUTH]",
        "POST /approvals/:id/approve [AUTH]",
        "POST /approvals/:id/escalate [AUTH]",
        "POST /approvals/:id/reject [AUTH]",
        "POST /approvals/:id/request-revision [AUTH]",
        "POST /approvals/delegations [AUTH]",
        "POST /auth/password [AUTH]",
        "POST /crm/organizations/:organizationId/follow-ups/:key/draft-in-outlook [crm:read]",
        "POST /formulas/preview [proposal:read]",
        "POST /insights/query [proposal:read]",
        "POST /me/outlook/connect [crm:read]",
        "POST /orders/:id/portal/sync [orders:read]",
        "POST /orders/portal/refresh [orders:read]",
        "POST /pricing/quote [pricing:read]",
        "POST /proposals/versions/:versionId/freight-coverage [proposal:read]",
        "POST /proposals/versions/:versionId/preview [proposal:read]",
        "POST /proposals/versions/:versionId/rfq/vendors [proposal:read]",
        "POST /receivables/:txnId/preview [accounting:read]",
        "POST /render/proposals/document.pdf [proposal:read]",
        "POST /render/receivables/:txnId/letter-preview.pdf [accounting:read]",
        "POST /rules/evaluate [rules:read]",
        "POST /strategic-partnerships/calculate [proposal:read]",
        "PUT /me/outlook/signature [crm:read]",
      ]
    `);
  });
});

describe('token handling', () => {
  it('the database role wins over the role claim in the token', async () => {
    const res = await call('GET', '/admin/users', await bearer('demoted-1', 'SYSTEM_ADMIN'));
    expect(res.statusCode).toBe(403);
  });

  it('a deactivated account is refused even with a valid token', async () => {
    const res = await call('GET', '/auth/me', await bearer('inactive-SALES_REP', 'SALES_REP'));
    expect(res.statusCode).toBe(401);
  });

  it('a token for a user that does not exist is refused', async () => {
    const res = await call('GET', '/auth/me', await bearer('ghost', 'SYSTEM_ADMIN'));
    expect(res.statusCode).toBe(401);
  });

  it('an unknown role claim is refused', async () => {
    const res = await call('GET', '/auth/me', await bearer('user-SALES_REP', 'ROOT'));
    expect(res.statusCode).toBe(401);
  });

  it('an expired token is refused', async () => {
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET!);
    const token = await new SignJWT({ role: 'SYSTEM_ADMIN' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-SYSTEM_ADMIN')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    const res = await call('GET', '/admin/users', { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(401);
  });

  it('an unsigned (alg: none) token is refused', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      sub: 'user-SYSTEM_ADMIN',
      role: 'SYSTEM_ADMIN',
      exp: Math.floor(Date.now() / 1000) + 600,
    })}.`;
    const res = await call('GET', '/admin/users', { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(401);
  });

  it('a token signed with the REFRESH secret is not an access token', async () => {
    const { signRefreshToken } = await import('../../src/auth/tokens.js');
    const token = await signRefreshToken({ sub: 'user-SYSTEM_ADMIN', role: 'SYSTEM_ADMIN' });
    const res = await call('GET', '/admin/users', { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(401);
  });

  it('a token signed with a different key is refused', async () => {
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({ role: 'SYSTEM_ADMIN' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-SYSTEM_ADMIN')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('some-other-secret-entirely-xxxx'));
    const res = await call('GET', '/admin/users', { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('error responses', () => {
  it('a 500 never leaks the underlying error text or a stack', async () => {
    const res = await call(
      'GET',
      '/admin/users',
      await bearer('user-SYSTEM_ADMIN', 'SYSTEM_ADMIN'),
    );
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'INTERNAL', message: 'Internal server error' });
    expect(res.body).not.toMatch(/database disabled|\bat \w+ \(|node_modules/);
  });

  // FINDING (low): the app's own application/json parser (src/app.ts) calls
  // done(err) with a bare SyntaxError, which carries no statusCode, so the error
  // handler treats a client's malformed body as a server fault: 500 + an alert email.
  it('malformed JSON from an anonymous caller is a 400, not a 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('authorization findings (fixed; each test pins its fix)', () => {
  // FINDING (medium): /belt-shipments/{ship,void,clear,restore,freight} change the
  // shipment ledger (and push to monday) behind PROPOSAL_READ, which READ_ONLY and
  // INSTALLER hold. src/routes/beltShipments.ts:268.
  it('READ_ONLY cannot void a belt shipment slip', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/belt-shipments/void',
      headers: await bearer('user-READ_ONLY', 'READ_ONLY'),
      payload: { slipId: 'slip-1' },
    });
    expect(res.statusCode).toBe(403);
  });

  // FINDING (medium-high): the financing send emails customer name, amount and a PDF
  // from the company's verified sending domain to ANY address in `to`, with a
  // caller-written message, behind PROPOSAL_READ. src/routes/finance.ts:543, :581.
  it('READ_ONLY cannot email a financing sheet to an arbitrary address', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/proposals/p1/financing/send',
      headers: await bearer('user-READ_ONLY', 'READ_ONLY'),
      payload: { to: 'someone@attacker.example', message: 'hello' },
    });
    expect(res.statusCode).toBe(403);
  });

  // FINDING (medium): saved reports carry `recipients` that the scheduled-reports cron
  // emails. Any PROPOSAL_READ holder can edit a SHARED report's recipients.
  // src/routes/insights.ts:237-249.
  it('READ_ONLY cannot re-point a shared scheduled report', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/insights/reports/r1',
      headers: await bearer('user-READ_ONLY', 'READ_ONLY'),
      payload: { recipients: 'someone@attacker.example' },
    });
    expect(res.statusCode).toBe(403);
  });

  // FINDING (low): customer record writes behind PROPOSAL_READ.
  // src/routes/customerNotes.ts:109, :167.
  it('READ_ONLY cannot change a customer’s decision/follow-up dates', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/crm/organizations/o1/dates',
      headers: await bearer('user-READ_ONLY', 'READ_ONLY'),
      payload: { followUpDate: '2027-01-01' },
    });
    expect(res.statusCode).toBe(403);
  });

  // FINDING (low): the freight gate (src/plugins/freightGate.ts:33) is an app-level
  // preHandler, so it runs BEFORE the route's requirePermission: an anonymous POST
  // reaches three database reads (and their errors) before anyone asks who it is.
  it('an anonymous BOM send is refused before the freight gate runs', async () => {
    dbState.section = { orderId: 'o1' };
    dbState.order = { proposalId: 'p1' };
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/bom/sections/s1/send',
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    } finally {
      dbState.section = null;
      dbState.order = null;
    }
  });
});
