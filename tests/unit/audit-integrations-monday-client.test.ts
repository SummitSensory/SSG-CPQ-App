import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit: monday GraphQL client (src/integrations/monday/client.ts) — retry and
 * error surfacing. fetch is injected; nothing reaches api.monday.com.
 */

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get(target, prop, receiver) {
        if (prop === 'MONDAY_API_TOKEN') return 'audit-monday-token';
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
  };
});
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { mondayQuery } from '../../src/integrations/monday/client.js';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('mondayQuery', () => {
  it('returns data on success and sends the token', async () => {
    const f = vi.fn(async () => json({ data: { me: { id: 1 } } }));
    const out = await mondayQuery<{ me: { id: number } }>('query { me { id } }', {}, f);
    expect(out.me.id).toBe(1);
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('audit-monday-token');
  });

  it('retries a 429 and then succeeds', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json({ data: { ok: true } }));
    const p = mondayQuery<{ ok: boolean }>('q', {}, f as unknown as typeof fetch);
    await vi.runAllTimersAsync();
    expect((await p).ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('retries a ComplexityException then succeeds', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        json({ errors: [{ message: 'budget', extensions: { code: 'ComplexityException' } }] }),
      )
      .mockResolvedValueOnce(json({ data: { ok: true } }));
    const p = mondayQuery<{ ok: boolean }>('q', {}, f as unknown as typeof fetch);
    await vi.runAllTimersAsync();
    expect((await p).ok).toBe(true);
  });

  it('gives up after five 429s', async () => {
    const f = vi.fn(async () => json({}, 429));
    const p = mondayQuery('q', {}, f);
    const settled = p.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(String(await settled)).toContain('429');
    expect(f).toHaveBeenCalledTimes(5);
  });

  it('does not retry a 5xx (a mutation may have applied)', async () => {
    const f = vi.fn(async () => json({}, 500));
    await expect(mondayQuery('q', {}, f)).rejects.toThrow('HTTP 500');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('surfaces GraphQL errors[] messages', async () => {
    const f = vi.fn(async () => json({ errors: [{ message: 'Item not found' }] }));
    await expect(mondayQuery('q', {}, f)).rejects.toThrow('Item not found');
  });

  // BUG (low): API-Version 2024-01 reports column-value failures as HTTP 200 with
  // top-level { error_code, error_message } and no `errors` array. The client
  // only reads errors[].message, so the thrown text is "returned no data" and the
  // real reason (e.g. a status label that does not exist on the board) is lost
  // from the IntegrationSyncLog row.
  it.fails('BUG: a top-level error_message is surfaced in the thrown error', async () => {
    const f = vi.fn(async () =>
      json({
        error_code: 'ColumnValueException',
        status_code: 200,
        error_message: 'This status label does not exist',
      }),
    );
    await expect(mondayQuery('q', {}, f)).rejects.toThrow('This status label does not exist');
  });
});
