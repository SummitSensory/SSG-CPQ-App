import { describe, it, expect, vi, beforeAll } from 'vitest';

/**
 * The vendor purchase-order routes live under /vendor-pos because
 * /orders/:orderId/purchase-orders already belongs to the CUSTOMER's purchase orders
 * (the files uploaded in Accounts Receivable, src/routes/receivables.ts). Registering
 * both under one path stops the whole app from booting — FST_ERR_DUPLICATED_ROUTE —
 * which is what the first draft of this feature did. This pins that every route
 * registers, and that none of them answers without a session.
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

describe('vendor purchase-order routes', () => {
  it('register alongside the customer PO routes and refuse an anonymous caller', async () => {
    const { buildApp } = await import('../../src/app.js');
    const app = buildApp();
    await app.ready();
    const calls: Array<[string, string]> = [
      ['GET', '/orders/o1/vendor-pos'],
      ['GET', '/orders/o1/vendor-pos/source?vendor=Acme'],
      ['POST', '/orders/o1/vendor-pos'],
      ['GET', '/vendor-pos/po1'],
      ['PATCH', '/vendor-pos/po1'],
      ['DELETE', '/vendor-pos/po1'],
      ['GET', '/vendor-pos/po1/preview'],
      ['GET', '/vendor-pos/po1/send-defaults'],
      ['GET', '/render/vendor-pos/po1.pdf'],
      ['POST', '/render/vendor-pos/po1/send'],
      // The customer's PO files, still where Accounts Receivable expects them.
      ['GET', '/orders/o1/purchase-orders'],
    ];
    for (const [method, url] of calls) {
      const res = await app.inject({
        method: method as 'GET',
        url,
        payload: method === 'GET' ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    await app.close();
  }, 30_000);
});
