import { test, expect } from '@playwright/test';

// The prebuilt proposal-title list (Administration → Proposal content → Proposal
// titles) is internal: neither reading nor saving it answers an anonymous caller.
test('proposal-title routes refuse an anonymous caller', async ({ request }) => {
  expect((await request.get('/proposal-titles')).status()).toBe(401);
  const put = await request.put('/proposal-titles', { data: { version: null, titles: [] } });
  expect(put.status()).toBe(401);
});
