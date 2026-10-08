import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit: src/lib/alerts.ts delivery semantics.
 *
 * sendAlert is not only the fault pager: it is also how staff learn that a
 * proposal was viewed, declined, countersign-needed, or fully signed (see
 * src/integrations/docuseal/notifications.ts). Those callers claim a one-shot
 * guard column BEFORE calling sendAlert, so if the alert is not delivered there is
 * no second chance from them. The in-memory dedupe must therefore only count an
 * alert as "sent" once Resend has accepted it.
 *
 * Global fetch is stubbed; nothing reaches Resend.
 */

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>();
  const overrides: Record<string, unknown> = {
    RESEND_API_KEY: 're_audit_key',
    ALERT_EMAIL: 'alerts@example.test, ops@example.test',
    ALERT_FROM_EMAIL: 'noreply@example.test',
    ALERT_FROM_NAME: 'Audit',
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

const realFetch = globalThis.fetch;
const flush = () => new Promise((r) => setTimeout(r, 0));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('sendAlert', () => {
  it('sends to every configured recipient and never throws', async () => {
    const { sendAlert } = await import('../../src/lib/alerts.js');
    expect(() => sendAlert({ title: 'T1', fingerprint: 'fp-1' })).not.toThrow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      to: string[];
    };
    expect(body.to).toEqual(['alerts@example.test', 'ops@example.test']);
  });

  it('dedupes the same fingerprint within the hour', async () => {
    const { sendAlert } = await import('../../src/lib/alerts.js');
    sendAlert({ title: 'T', fingerprint: 'fp-2' });
    await flush();
    sendAlert({ title: 'T', fingerprint: 'fp-2' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours an explicit `to` override', async () => {
    const { sendAlert } = await import('../../src/lib/alerts.js');
    sendAlert({ title: 'T', fingerprint: 'fp-3', to: ['rep@example.test'] });
    await flush();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      to: string[];
    };
    expect(body.to).toEqual(['rep@example.test']);
  });

  it('swallows a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { sendAlert } = await import('../../src/lib/alerts.js');
    sendAlert({ title: 'T', fingerprint: 'fp-4' });
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // BUG: shouldSend() records the fingerprint BEFORE the POST. When Resend rejects
  // (5xx/429) or the network fails, the next attempt within the hour is
  // suppressed. For one-shot business alerts (esign viewed/declined/completed)
  // the caller's guard is already claimed, so the notification is lost for good.
  it.fails(
    'BUG: a rejected delivery does not suppress the retry of the same fingerprint',
    async () => {
      fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }));
      const { sendAlert } = await import('../../src/lib/alerts.js');
      sendAlert({ title: 'Proposal P-1 — declined', fingerprint: 'esign-declined-env1' });
      await flush();
      sendAlert({ title: 'Proposal P-1 — declined', fingerprint: 'esign-declined-env1' });
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
});
