import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.MONDAY_API_TOKEN ??= 'test-token';
});

/** Build a fake fetch that returns a queued sequence of responses. */
function fakeFetch(responses: Array<{ status?: number; headers?: Record<string, string>; body?: unknown }>) {
  let i = 0;
  const calls = { count: 0 };
  const fn = async () => {
    calls.count++;
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      headers: { get: (k: string) => (r.headers ?? {})[k.toLowerCase()] ?? null },
      json: async () => r.body ?? { data: { ok: true } },
    } as unknown as Response;
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('monday client rate-limit handling', () => {
  it('retries after HTTP 429 then succeeds', async () => {
    const { mondayQuery } = await import('../../src/integrations/monday/client.js');
    const { fn, calls } = fakeFetch([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 200, body: { data: { value: 42 } } },
    ]);
    const data = await mondayQuery<{ value: number }>('query {}', {}, fn);
    expect(data.value).toBe(42);
    expect(calls.count).toBe(2);
  });

  it('retries on a complexity error code then succeeds', async () => {
    const { mondayQuery } = await import('../../src/integrations/monday/client.js');
    const { fn, calls } = fakeFetch([
      { status: 200, body: { error_code: 'ComplexityException' } },
      { status: 200, body: { data: { ok: true } } },
    ]);
    await mondayQuery('query {}', {}, fn);
    expect(calls.count).toBe(2);
  });

  it('throws GraphQL errors without retrying', async () => {
    const { mondayQuery } = await import('../../src/integrations/monday/client.js');
    const { fn, calls } = fakeFetch([{ status: 200, body: { errors: [{ message: 'bad column' }] } }]);
    await expect(mondayQuery('query {}', {}, fn)).rejects.toThrow(/bad column/);
    expect(calls.count).toBe(1);
  });

  it('backoff grows with attempt and is capped', async () => {
    const { backoff } = await import('../../src/integrations/monday/client.js');
    expect(backoff(0)).toBeLessThan(backoff(4) + 1);
    expect(backoff(20)).toBeLessThanOrEqual(15_000 + 250);
    expect(backoff(0, 3)).toBe(3000); // honors Retry-After seconds
  });
});
