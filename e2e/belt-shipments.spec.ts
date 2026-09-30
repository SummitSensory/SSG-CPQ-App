import { test, expect } from '@playwright/test';

// The belt-shipment ledger writes (ship, void, clear from the queue, restore) change
// what a customer is owed, so none of them answers an anonymous caller.
test('belt-shipment routes refuse an anonymous caller', async ({ request }) => {
  expect((await request.get('/belt-shipments')).status()).toBe(401);
  for (const url of [
    '/belt-shipments/ship',
    '/belt-shipments/void',
    '/belt-shipments/clear',
    '/belt-shipments/restore',
  ]) {
    const res = await request.post(url, { data: {} });
    expect(res.status(), url).toBe(401);
  }
});
