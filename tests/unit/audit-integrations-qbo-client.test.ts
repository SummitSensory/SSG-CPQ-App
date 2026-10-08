import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit: QuickBooks REST client (src/integrations/quickbooks/client.ts) — retry
 * semantics. fetch is injected and the token source is stubbed, so nothing
 * reaches Intuit. `sleep` is made instant so backoff does not slow the suite.
 */

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get(target, prop, receiver) {
        if (prop === 'QBO_CLIENT_ID') return 'audit-client-id';
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
    qboEnvironment: () => 'SANDBOX',
  };
});
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/integrations/quickbooks/oauth.js', () => ({
  getAccessToken: vi.fn(async () => 'audit-access-token'),
}));
vi.mock('../../src/integrations/quickbooks/http.js', async (orig) => {
  const real = await orig<typeof import('../../src/integrations/quickbooks/http.js')>();
  return { ...real, sleep: async () => undefined };
});

import {
  create,
  query,
  sendDocument,
  update,
  qboRequestId,
} from '../../src/integrations/quickbooks/client.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', intuit_tid: 'tid-1' },
  });
}

const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
});

function recorder(responses: Response[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('no more stubbed responses');
    return next;
  }) as typeof fetch;
}

describe('QuickBooks client: idempotent create', () => {
  it('sends the same requestid on every retry of a create', async () => {
    const f = recorder([json({}, 503), json({}, 429), json({ Invoice: { Id: '9' } })]);
    const out = await create<{ Invoice: { Id: string } }>('realm', 'invoice', { a: 1 }, 'key-1', f);
    expect(out.Invoice.Id).toBe('9');
    expect(calls).toHaveLength(3);
    const ids = calls.map((u) => new URL(u).searchParams.get('requestid'));
    expect(new Set(ids)).toEqual(new Set(['key-1']));
  });

  it('hashes an over-long idempotency key to <= 50 URL-encoded chars, deterministically', () => {
    const k = `qbo:PRODUCTION:ESTIMATE:${'c'.repeat(30)}:1`;
    const a = qboRequestId(k);
    expect(encodeURIComponent(a).length).toBeLessThanOrEqual(50);
    expect(qboRequestId(k)).toBe(a);
    expect(qboRequestId(`${k}x`)).not.toBe(a);
  });

  it('fails a 4xx immediately with the fault detail and tid', async () => {
    const f = recorder([
      json({ Fault: { Error: [{ code: '2020', Message: 'Required param missing' }] } }, 400),
    ]);
    await expect(create('realm', 'invoice', {}, 'k', f)).rejects.toThrow(
      /fault 2020.*Required param missing.*intuit_tid=tid-1/,
    );
    expect(calls).toHaveLength(1);
  });

  it('a read query retries a 5xx', async () => {
    const f = recorder([json({}, 502), json({ QueryResponse: { Customer: [] } })]);
    const out = await query<{ Customer: unknown[] }>('realm', 'select * from Customer', f);
    expect(out.Customer).toEqual([]);
  });
});

describe('QuickBooks client: non-idempotent POSTs on a 5xx', () => {
  // BUG: request() retries ANY POST on 5xx. For /send there is no requestid and no
  // SyncToken — a gateway 502/504 after Intuit already emailed the invoice means
  // the retry emails the customer a second time.
  it.fails('BUG: sendDocument is not blindly re-sent after a 5xx', async () => {
    const f = recorder([json({}, 504), json({ Invoice: { Id: '9' } })]);
    await sendDocument('realm', 'invoice', '9', 'ap@customer.example', f).catch(() => undefined);
    expect(calls.filter((u) => u.includes('/send'))).toHaveLength(1);
  });

  // BUG: same retry path for a sparse update. If the first POST applied but the
  // response was a 5xx, the retry carries the now-stale SyncToken and QuickBooks
  // answers 5010 — the caller is told the update FAILED although it succeeded.
  it.fails(
    'BUG: a 5xx on update does not end as a misleading stale-token (5010) failure',
    async () => {
      const f = recorder([
        json({}, 503),
        json({ Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } }, 400),
      ]);
      const err = await update(
        'realm',
        'invoice',
        { Id: '9', SyncToken: '0', PrivateNote: 'x' },
        f,
      ).then(
        () => null,
        (e: unknown) => e as { faultCode?: string },
      );
      expect(err?.faultCode).not.toBe('5010');
    },
  );
});
