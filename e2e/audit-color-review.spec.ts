import { test, expect } from '@playwright/test';

// Full-stack e2e for the staff side of customer colours. API-level, like the other
// specs here: it pins, from outside a running server, the shapes the order page's
// Customer Portal card (public/order-portal.js), the "Check colors" dialog
// (openColorCheck in public/app.js) and Administration → Portal colour areas
// (public/portal-color-areas.js) read.
//
// Deliberately NON-DESTRUCTIVE: it never marks anything reviewed and never saves a
// mapping, because a live stack's review writes colours onto a real Bill of
// Materials. The write path is covered against a throwaway database in
// tests/integration/audit-color-routes.test.ts.
//
// Requires E2E_TOKEN (SYSTEM_ADMIN) and E2E_COLOR_ORDER_ID (an order whose COLOR
// step has answers). The anonymous checks always run.
const token = process.env.E2E_TOKEN;
const orderId = process.env.E2E_COLOR_ORDER_ID;

test('colour routes refuse an anonymous caller', async ({ request }) => {
  expect((await request.get('/admin/portal-color-areas')).status()).toBe(401);
  expect(
    (
      await request.put('/admin/portal-color-areas/structure_frame_paint.legs', { data: {} })
    ).status(),
  ).toBe(401);
  expect(
    (await request.post('/orders/o1/portal/color/review', { data: { contentHash: 'x' } })).status(),
  ).toBe(401);
});

test.describe('staff colour review', () => {
  test.skip(
    !token || !orderId,
    'set E2E_TOKEN and E2E_COLOR_ORDER_ID and run against a live stack',
  );
  const auth = () => ({ Authorization: `Bearer ${token}` });

  test('the Portal card gets a COLOR step with every field it renders', async ({ request }) => {
    const res = await request.get(`/orders/${orderId}/portal`, { headers: auth() });
    expect(res.ok()).toBeTruthy();
    const items = (await res.json()) as Array<Record<string, unknown>>;
    const color = items.find((i) => i.kind === 'COLOR');
    expect(color).toBeTruthy();
    for (const k of [
      'display',
      'mondayStatus',
      'answers',
      'obtainedAt',
      'reviewedAt',
      'reviewedBy',
      'lastSyncedAt',
      'contentHash',
    ]) {
      expect(color).toHaveProperty(k);
    }
  });

  test('Mark reviewed with a stale version is refused without touching the BOM', async ({
    request,
  }) => {
    const res = await request.post(`/orders/${orderId}/portal/color/review`, {
      headers: auth(),
      data: { contentHash: 'not-the-version-on-screen' },
    });
    // 409 when answers exist (stale version), 404 when none were ever received.
    expect([404, 409]).toContain(res.status());
  });

  test('the colour check answers in the shape the dialog reads', async ({ request }) => {
    const res = await request.get(`/orders/${orderId}/bom/color-check`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.portal).toEqual(
      expect.objectContaining({
        found: expect.any(Boolean),
        reviewed: expect.any(Boolean),
      }),
    );
    expect(Array.isArray(body.handSet)).toBe(true);
    expect(Array.isArray(body.bomErrors)).toBe(true);
  });

  test('the mapping screen gets areas with parts and samples', async ({ request }) => {
    const res = await request.get('/admin/portal-color-areas', { headers: auth() });
    expect(res.status()).toBe(200);
    const { areas } = (await res.json()) as { areas: Array<Record<string, unknown>> };
    for (const a of areas) {
      for (const k of ['areaKey', 'label', 'orderCount', 'samples', 'parts']) {
        expect(a).toHaveProperty(k);
      }
    }
  });
});
