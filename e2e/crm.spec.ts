import { test, expect } from '@playwright/test';

// Full-stack e2e: requires the API running against a seeded Postgres and a
// SYSTEM_ADMIN bearer token in E2E_TOKEN. Skipped automatically when unset.
const token = process.env.E2E_TOKEN;

test.describe('crm opportunity lifecycle', () => {
  test.skip(!token, 'set E2E_TOKEN and run against a live stack');

  test('create org then opportunity, then list & filter', async ({ request }) => {
    const auth = { Authorization: 'Bearer ' + token };
    const org = await request.post('/crm/organizations', {
      headers: auth,
      data: { name: 'E2E Clinic ' + Date.now() },
    });
    expect(org.status()).toBe(201);
    const orgId = (await org.json()).id;

    const opp = await request.post('/crm/opportunities', {
      headers: auth,
      data: { organizationId: orgId, name: 'Sensory Gym', stage: 'QUALIFICATION', budgetAmount: '50000.00', budgetCurrency: 'USD' },
    });
    expect(opp.status()).toBe(201);

    const list = await request.get('/crm/opportunities?stage=QUALIFICATION&sort=name&dir=asc', { headers: auth });
    expect(list.ok()).toBeTruthy();
    expect((await list.json()).total).toBeGreaterThan(0);
  });
});
