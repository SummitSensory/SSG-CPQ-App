import { test, expect, type Page } from '@playwright/test';

// Full-stack: the reorderable sidebar and the one-step New proposal flow, in a real
// browser. Requires the API running against a seeded Postgres and a SYSTEM_ADMIN
// bearer token in E2E_TOKEN, like audit-smoke.spec.ts. Run it with the monday token
// blank: the picker then answers from the CRM alone, and nothing reaches monday.
const token = process.env.E2E_TOKEN;

async function signIn(page: Page): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('ssg_at', t);
    } catch {
      /* storage blocked: the test fails on the missing shell instead */
    }
  }, token!);
  await page.goto('/');
  await page.waitForSelector('#nav .nav-item', { timeout: 20_000 });
}

async function navIds(page: Page): Promise<string[]> {
  return page
    .locator('#nav > .nav-item[data-view]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-view') ?? ''));
}

test.describe('reorderable sidebar and New proposal', () => {
  test.skip(!token, 'set E2E_TOKEN and run against a live stack');
  test.setTimeout(90_000);
  // One account's tab order is shared state between these tests.
  test.describe.configure({ mode: 'serial' });

  test('New proposal: picking a monday deal brings it into the CRM first', async ({
    page,
    request,
  }) => {
    // monday itself is never reached: the picker's two endpoints are answered here,
    // with a real CRM organization standing in for the imported deal.
    const auth = { Authorization: 'Bearer ' + token };
    const name = 'E2E Monday Deal ' + Date.now();
    const org = await (
      await request.post('/crm/organizations', { headers: auth, data: { name } })
    ).json();
    let imported = 0;
    await page.route('**/crm/customer-picker?*', (route) =>
      route.fulfill({
        json: {
          q: 'deal',
          crm: [],
          monday: {
            status: 'ok',
            error: null,
            rows: [
              {
                itemId: '123456789',
                name,
                industry: null,
                contact: 'Pat Example',
                email: null,
                city: 'Denver',
                state: 'CO',
                projectId: '4242',
                stage: 'New Lead',
                existingOrganizationId: null,
              },
            ],
          },
        },
      }),
    );
    await page.route('**/crm/customer-picker/monday/123456789', (route) => {
      imported++;
      return route.fulfill({
        json: {
          result: 'created',
          organizationId: org.id,
          organizationName: name,
          opportunityId: null,
          opportunityName: null,
          projectId: '4242',
        },
      });
    });

    await signIn(page);
    await page.locator('#nav .nav-item[data-view="proposals"]').click();
    await page.locator('#propNew').click();
    await page.locator('#fCust').fill('deal');
    const option = page.locator('#fCustList [role="option"]', { hasText: name });
    await expect(option).toBeVisible();
    await expect(page.locator('#fCustList')).toContainText('not in the CRM yet');
    // Keyboard: arrow onto the deal, Enter picks it.
    await page.locator('#fCust').press('ArrowDown');
    await page.locator('#fCust').press('Enter');
    await expect(page.locator('#fCustChosenLabel')).toContainText(name);
    await expect(page.locator('#fCustChosenLabel')).toContainText('Project 4242');
    expect(imported).toBe(1);
  });

  test('a saved tab order survives a reload, and Reset puts the default back', async ({
    page,
    request,
  }) => {
    const auth = { Authorization: 'Bearer ' + token };
    await request.patch('/auth/me', { headers: auth, data: { navOrder: null } });
    await signIn(page);
    const before = await navIds(page);
    expect(before.slice(0, 4)).toEqual(['dashboard', 'crm', 'catalog', 'proposals']);

    await page.locator('#navOrderBtn').click();
    // Move Proposals up three places, to the top.
    for (let i = 0; i < 3; i++) await page.locator('[data-up="proposals"]').click();
    await page.locator('#mSave').click();
    await expect(page.locator('#navOrderList')).toHaveCount(0);
    expect((await navIds(page))[0]).toBe('proposals');

    await page.reload();
    await page.waitForSelector('#nav .nav-item');
    await page.waitForLoadState('networkidle');
    const after = await navIds(page);
    expect(after[0]).toBe('proposals');
    // Nothing gained or lost — plugin tabs included.
    expect([...after].sort()).toEqual([...before].sort());

    await page.locator('#navOrderBtn').click();
    await page.locator('#navOrderReset').click();
    await page.locator('#mSave').click();
    await expect(page.locator('#navOrderList')).toHaveCount(0);
    expect(await navIds(page)).toEqual(before);
    const me = await (await request.get('/auth/me', { headers: auth })).json();
    expect(me.navOrder).toBeNull();
  });

  test('dragging a tab in the sidebar moves it and saves the order', async ({ page, request }) => {
    const auth = { Authorization: 'Bearer ' + token };
    await request.patch('/auth/me', { headers: auth, data: { navOrder: null } });
    await signIn(page);
    await page
      .locator('#nav > .nav-item[data-view="reports"]')
      .dragTo(page.locator('#nav > .nav-item[data-view="dashboard"]'), {
        targetPosition: { x: 20, y: 2 },
      });
    expect((await navIds(page))[0]).toBe('reports');
    await expect
      .poll(
        async () => (await (await request.get('/auth/me', { headers: auth })).json()).navOrder?.[0],
      )
      .toBe('reports');
    await request.patch('/auth/me', { headers: auth, data: { navOrder: null } });
  });

  test('New proposal: search a customer, pick it, and land in the builder', async ({
    page,
    request,
  }) => {
    const auth = { Authorization: 'Bearer ' + token };
    const name = 'E2E Picker Clinic ' + Date.now();
    const org = await request.post('/crm/organizations', { headers: auth, data: { name } });
    expect(org.status()).toBe(201);

    await signIn(page);
    await page.locator('#nav .nav-item[data-view="proposals"]').click();
    await page.locator('#propNew').click();
    await page.locator('#fCust').fill(name);
    const option = page.locator('#fCustList [role="option"]', { hasText: name });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.locator('#fCustChosenLabel')).toContainText(name);
    await page.locator('#fTitle').fill('E2E picker proposal');
    await page.locator('#mSave').click();
    // The builder opens on the new proposal, for that customer.
    await expect(page.locator('#viewTitle')).toHaveText('Proposals');
    await expect(page.locator('#view')).toContainText(name, { timeout: 20_000 });
  });

  test('New proposal from a CRM row opens with that customer already chosen', async ({
    page,
    request,
  }) => {
    const auth = { Authorization: 'Bearer ' + token };
    const name = 'E2E Row Clinic ' + Date.now();
    await request.post('/crm/organizations', { headers: auth, data: { name } });

    await signIn(page);
    await page.locator('#nav .nav-item[data-view="crm"]').click();
    await page.locator('#crmSearch').fill(name);
    const row = page.locator('#crmList tr', { hasText: name });
    await expect(row).toBeVisible();
    await row.locator('.crmNewProp').click();
    await expect(page.locator('#fCustChosenLabel')).toContainText(name);
    await expect(page.locator('#fCust')).toBeHidden();
  });
});
