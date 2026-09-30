import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...orig,
    env: { ...orig.env, MONDAY_API_TOKEN: 't', MONDAY_DEALS_BOARD_ID: '6527740233' },
    isMondayPushConfigured: () => true,
  };
});

const { formatUsPhone } = await import('../../src/lib/phone.js');
const { readDealContacts } = await import('../../src/integrations/monday/dealContacts.js');

describe('formatUsPhone', () => {
  it.each([
    ['7204575500', '720-457-5500'],
    ['(720) 457-5500', '720-457-5500'],
    ['+1 720.457.5500', '720-457-5500'],
    ['1-720-457-5500', '720-457-5500'],
    ['720-457-5500 ext. 12', '720-457-5500 x12'],
    ['720 457 5500 x7', '720-457-5500 x7'],
  ])('%s -> %s', (raw, want) => {
    expect(formatUsPhone(raw)).toBe(want);
  });

  it.each(['', '555-0199', '+44 20 7946 0958', 'call the office'])('leaves %j as given', (raw) => {
    expect(formatUsPhone(raw)).toBe(raw);
  });
});

function mondayFetch(
  handler: (ids: string[]) => Array<{ id: string; column_values: unknown[] }>,
): typeof fetch {
  return vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const { variables } = JSON.parse(String(init?.body)) as { variables: { items: string[] } };
    return new Response(JSON.stringify({ data: { items: handler(variables.items) } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}

describe('readDealContacts', () => {
  it('reads email_1__1 and phone__1 off each deal, a hundred ids per query', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => String(1000 + i));
    const fetchImpl = mondayFetch((batch) =>
      batch.map((id) => ({
        id,
        column_values: [
          { id: 'email_1__1', text: `c${id}@example.test` },
          { id: 'phone__1', text: '7205550100' },
        ],
      })),
    );
    const got = await readDealContacts([...ids, '', 'not-an-id', '1000'], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(got.size).toBe(150);
    expect(got.get('1042')).toEqual({ email: 'c1042@example.test', phone: '7205550100' });
  });

  it('gives up after the time limit and returns what it has, without throwing', async () => {
    const fetchImpl = vi.fn(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;
    const got = await readDealContacts(['1'], { fetchImpl, timeoutMs: 20 });
    expect(got.size).toBe(0);
  });

  it('returns nothing, without throwing, when monday errors', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(readDealContacts(['1'], { fetchImpl })).resolves.toEqual(new Map());
  });
});
