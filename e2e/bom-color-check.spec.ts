import { test, expect } from '@playwright/test';

// Full-stack e2e: requires the API running against a seeded Postgres and a
// SYSTEM_ADMIN bearer token in E2E_TOKEN. The anonymous check always runs.
//
// The BOM tab's "Check colors" dialog reads this shape (openColorCheck in
// public/app.js; src/portal/colorCheck.ts).
const token = process.env.E2E_TOKEN;
const orderId = process.env.E2E_ORDER_ID;

test('the color check refuses an anonymous caller', async ({ request }) => {
  const res = await request.get('/orders/o1/bom/color-check');
  expect(res.status()).toBe(401);
});

test.describe('BOM color check', () => {
  test.skip(!token || !orderId, 'set E2E_TOKEN and E2E_ORDER_ID and run against a live stack');

  test('answers with the monday source and a summary', async ({ request }) => {
    const res = await request.get(`/orders/${orderId}/bom/color-check`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.source.columnId).toBe('long_text_mm6vj4d9');
    expect(Array.isArray(body.areas)).toBe(true);
    expect(body.summary).toEqual(
      expect.objectContaining({
        ok: expect.any(Number),
        problems: expect.any(Number),
        areas: expect.any(Number),
      }),
    );
  });
});
