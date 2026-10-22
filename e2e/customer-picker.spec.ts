import { test, expect } from '@playwright/test';

// The New proposal customer picker searches the CRM and monday, and can import a
// monday deal into the CRM — neither answers an anonymous caller.
test('customer-picker routes refuse an anonymous caller', async ({ request }) => {
  expect((await request.get('/crm/customer-picker?q=soar')).status()).toBe(401);
  expect((await request.post('/crm/customer-picker/monday/123')).status()).toBe(401);
});

// The new-deal sweep is an admin action like the other monday imports.
test('the manual new-deal sweep refuses an anonymous caller', async ({ request }) => {
  expect((await request.post('/integrations/monday/deals/sweep')).status()).toBe(401);
});

// Reorderable sidebar tabs: the shell loads public/nav-order.js, so it must be served
// (CLIENT_SCRIPTS) or the feature silently disappears in local development.
test('the shell serves the tab-order script it loads', async ({ request }) => {
  const shell = await request.get('/');
  expect(shell.ok()).toBeTruthy();
  expect(await shell.text()).toContain('/nav-order.js');
  const script = await request.get('/nav-order.js');
  expect(script.ok()).toBeTruthy();
  expect(await script.text()).toContain('SSGNavOrder');
});
