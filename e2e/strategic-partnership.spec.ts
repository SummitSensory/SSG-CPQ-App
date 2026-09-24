import { test, expect } from '@playwright/test';

// Full-stack e2e: requires the API running against a seeded Postgres and a
// SYSTEM_ADMIN bearer token in E2E_TOKEN. Skipped automatically when unset.
// Never reaches Canva: generation is expected to refuse (no logo, no connection).
const token = process.env.E2E_TOKEN;

test.describe('strategic partnership proposal', () => {
  test.skip(!token, 'set E2E_TOKEN and run against a live stack');

  test('create, calculate on the server, and refuse to generate until set up', async ({
    request,
  }) => {
    const auth = { Authorization: 'Bearer ' + token };
    const org = await request.post('/crm/organizations', {
      headers: auth,
      data: { name: 'E2E Partnership ' + Date.now() },
    });
    expect(org.status()).toBe(201);
    const orgId = (await org.json()).id;

    const created = await request.post('/strategic-partnerships', {
      headers: auth,
      data: {
        organizationId: orgId,
        customerShortName: 'E2E',
        customerFullName: 'E2E Therapy Center',
        executiveName: 'Pat Example',
        executiveTitle: 'CEO',
        industry: 'ABA Therapy',
        partnerDiscountPercent: '17.5',
        standardProjectValue: '16514',
        pmHoursReturnedPerCenter: '41',
        pmHourValue: '75',
        year1PlannedCenters: 10,
        year2PlannedCenters: 10,
        year3PlannedCenters: 10,
      },
    });
    expect(created.status()).toBe(201);
    const body = await created.json();
    expect(body.status).toBe('READY_TO_GENERATE');
    expect(body.outputs.threeYearEquipmentSavingsMinor).toBe(8_669_850);

    const detail = await request.get('/strategic-partnerships/' + body.id, { headers: auth });
    expect(detail.ok()).toBeTruthy();
    expect((await detail.json()).generationBlockers.join(' ')).toMatch(/customer logo/);

    const gen = await request.post('/strategic-partnerships/' + body.id + '/generate', {
      headers: auth,
    });
    expect(gen.status()).toBe(400);
  });
});
