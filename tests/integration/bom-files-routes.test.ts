import { describe, it, expect, vi, beforeAll } from 'vitest';

/**
 * The Bill of Materials file routes register alongside the rest of the BOM routes
 * (a duplicate path stops the whole app from booting), and none of them answers
 * without a session — a vendor's drawings are not public.
 */
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: new Proxy(
    {},
    {
      get: () =>
        new Proxy(() => Promise.resolve(null), {
          get: () => () => Promise.resolve(null),
        }),
    },
  ),
}));

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

describe('BOM file routes', () => {
  it('register and refuse an anonymous caller', async () => {
    const { buildApp } = await import('../../src/app.js');
    const app = buildApp();
    await app.ready();
    const calls: Array<[string, string]> = [
      ['GET', '/bom/sections/s1/files'],
      ['POST', '/bom/sections/s1/files/upload-token'],
      ['POST', '/bom/sections/s1/files'],
      ['GET', '/bom/sections/s1/files/f1/download'],
      ['DELETE', '/bom/sections/s1/files/f1'],
      ['POST', '/bom/sections/s1/send'],
    ];
    for (const [method, url] of calls) {
      const res = await app.inject({
        method: method as 'GET',
        url,
        payload: method === 'GET' || method === 'DELETE' ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    await app.close();
  }, 30_000);
});
