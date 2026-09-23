import { test, expect } from '@playwright/test';

// Full-stack e2e: requires the API running against a seeded Postgres and a
// SYSTEM_ADMIN bearer token in E2E_TOKEN. Skipped automatically when unset.
//
// The Orders page's Delivery / Color / Billing columns and its Customer Portal card
// read exactly these shapes (public/order-portal.js); this pins them from the
// outside so a server change that breaks the page is caught here.
const token = process.env.E2E_TOKEN;
const KINDS = ['DELIVERY', 'COLOR', 'BILLING', 'CONTACT', 'REQUIRED'];

test.describe('orders: customer-portal steps', () => {
  test.skip(!token, 'set E2E_TOKEN and run against a live stack');

  test('every order row carries all five portal steps', async ({ request }) => {
    const auth = { Authorization: 'Bearer ' + token };
    const res = await request.get('/orders', { headers: auth });
    expect(res.ok()).toBeTruthy();
    const rows = (await res.json()) as Array<{ id: string; portal: Record<string, unknown> }>;
    for (const r of rows) {
      for (const k of KINDS) {
        const e = r.portal[k] as { display: string; obtainedAt: string | null };
        expect(['NEW', 'REVIEWED', 'NONE', 'NA']).toContain(e.display);
      }
    }
  });

  test('the page-open refresh answers with its documented shape', async ({ request }) => {
    const auth = { Authorization: 'Bearer ' + token };
    const res = await request.post('/orders/portal/refresh', { headers: auth, data: {} });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    for (const key of ['refreshed', 'throttled', 'at', 'itemsChanged', 'error']) {
      expect(body).toHaveProperty(key);
    }
  });

  test("one order's steps list all five, in column order", async ({ request }) => {
    const auth = { Authorization: 'Bearer ' + token };
    const rows = (await (await request.get('/orders', { headers: auth })).json()) as Array<{
      id: string;
    }>;
    test.skip(!rows.length, 'no orders in this database');
    const res = await request.get('/orders/' + rows[0]!.id + '/portal', { headers: auth });
    expect(res.ok()).toBeTruthy();
    const items = (await res.json()) as Array<{ kind: string }>;
    expect(items.map((i) => i.kind)).toEqual(KINDS);
  });
});
