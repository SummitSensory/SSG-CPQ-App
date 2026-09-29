import { test, expect } from '@playwright/test';

// Full-stack e2e: requires the API running against a seeded Postgres and a
// SYSTEM_ADMIN bearer token in E2E_TOKEN. The anonymous checks always run.
//
// The order screen's "Create Purchase Order" window reads these shapes
// (openPurchaseOrderWindow in public/app.js).
const token = process.env.E2E_TOKEN;

test('vendor purchase-order routes refuse an anonymous caller', async ({ request }) => {
  for (const url of ['/orders/o1/vendor-pos', '/vendor-pos/po1', '/render/vendor-pos/po1.pdf']) {
    const res = await request.get(url);
    expect(res.status(), url).toBe(401);
  }
});

test.describe('vendor purchase orders', () => {
  test.skip(!token, 'set E2E_TOKEN and run against a live stack');

  test("an order's PO list and a vendor's PO source answer with their documented shapes", async ({
    request,
  }) => {
    const auth = { Authorization: 'Bearer ' + token };
    const rows = (await (await request.get('/orders', { headers: auth })).json()) as Array<{
      id: string;
    }>;
    test.skip(!rows.length, 'no orders in this database');
    const list = await request.get('/orders/' + rows[0]!.id + '/vendor-pos', { headers: auth });
    expect(list.ok()).toBeTruthy();
    expect(Array.isArray((await list.json()).purchaseOrders)).toBe(true);

    const sections = await request.get('/orders/' + rows[0]!.id + '/bom/sections', {
      headers: auth,
    });
    const secs = ((await sections.json()).sections ?? []) as Array<{
      vendor: string;
      poEnabled: boolean;
    }>;
    test.skip(!secs.length, 'no BOM sections on this order');
    for (const s of secs) expect(typeof s.poEnabled).toBe('boolean');
  });
});
