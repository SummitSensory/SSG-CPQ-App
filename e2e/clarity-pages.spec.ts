import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

// Full-stack: the What's Included / Before You Sign pages in a real browser — the
// builder card, the preview, save and reopen, and the wording editor in
// Administration → Frame naming. Requires the API running against a seeded Postgres
// and a SYSTEM_ADMIN bearer token in E2E_TOKEN, like audit-smoke.spec.ts. Run it with
// the monday / QuickBooks / DocuSeal tokens blank: nothing here is sent anywhere.
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

/** The Baby Fold (P-2026-000144 Rev 1), as the configurator leaves it. */
const ADV_ANSWERS = {
  length: 10,
  width: 8,
  config: 'Rectangle',
  legs: 4,
  ladders: 1,
  monkeyBars: true,
  interiorBeams: true,
  interiorBeamsQty: 1,
  zipLine: true,
  slide: true,
  steamroller: true,
  climbWall: true,
  matColumn: true,
  uShaped: 4,
  matLadderLeg: true,
  floorPadding: true,
};
const line = (o: Record<string, unknown>, i: number) => ({
  ref: 'r' + i,
  lineType: 'PRODUCT',
  kind: 'INCLUDED',
  sku: '',
  description: '',
  quantity: 1,
  rateMinor: 100000,
  order: i,
  ...o,
});
const ITEMS = [
  { lineType: 'GROUP', name: 'R-2MBL1Z — Itemized', description: "Frame Dimensions: 10' × 8'" },
  { sku: 'A-2245', name: 'Vertical Post', quantity: 4 },
  { lineType: 'GROUP', name: 'Adventure Components' },
  { sku: 'A-2216', name: 'Summit Adventure Slide' },
  { sku: '150045', name: 'Steamroller Ramp' },
  { sku: 'A-2349', name: 'Steamroller/Scooter Board Conversion Kit' },
  { sku: 'SSG-SA-CWM', name: 'Adventure Climbing Wall - Wall Mounted' },
  { lineType: 'GROUP', name: 'Adventure Mat System' },
  { sku: 'R-SSG-1008CLM', name: "Adventure Floor Mat System (10' x 8' x 3.25\")" },
  { sku: 'SSUSP67', name: 'U-Shaped Column Wrap', quantity: 4 },
  { sku: 'SSUSP72', name: 'Ladder Leg Wrap', quantity: 1 },
].map(line);

async function adventureProposal(
  request: APIRequestContext,
  title: string,
  clarityPages: Record<string, unknown> | undefined,
): Promise<string> {
  const auth = { Authorization: 'Bearer ' + token };
  const org = await request.post('/crm/organizations', {
    headers: auth,
    data: { name: 'E2E Clarity ' + Date.now() },
  });
  expect(org.ok()).toBeTruthy();
  const orgId = (await org.json()).id as string;
  const created = await request.post('/proposals', {
    headers: auth,
    data: { organizationId: orgId, title, sections: [], items: [] },
  });
  expect(created.status()).toBe(201);
  const cj = await created.json();
  const proposalId = (cj.proposal?.id ?? cj.id) as string;
  const full = await (await request.get('/proposals/' + proposalId, { headers: auth })).json();
  const version = full.versions[full.versions.length - 1];
  const meta = {
    contactName: 'Jane Customer',
    shipTo: '123 Main St\nBloomington, IL',
    introTemplate: 'NONE',
    advAnswers: ADV_ANSWERS,
    ...(clarityPages ? { clarityPages } : {}),
  };
  const patched = await request.patch('/proposals/versions/' + version.id, {
    headers: auth,
    data: {
      sections: [
        {
          id: 'meta',
          type: 'CUSTOMER_INFO',
          title: 'Proposal',
          order: 0,
          enabled: true,
          data: meta,
        },
      ],
      items: ITEMS,
      expectedUpdatedAt: version.updatedAt,
    },
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  return proposalId;
}

async function openInBuilder(page: Page, title: string): Promise<void> {
  await page.locator('#nav .nav-item[data-view="proposals"]').click();
  await page.getByText(title).first().click();
  await page.locator('[data-open="edit"]').first().click();
  await expect(page.locator('#bSave')).toBeVisible({ timeout: 20_000 });
}

test.describe('proposal clarity pages', () => {
  test.skip(!token, 'set E2E_TOKEN and run against a live stack');
  test.setTimeout(120_000);

  test('a proposal saved before the pages existed opens with both pages off', async ({
    page,
    request,
  }) => {
    const title = 'E2E Clarity Legacy ' + Date.now();
    await adventureProposal(request, title, undefined);
    await signIn(page);
    await openInBuilder(page, title);
    await expect(page.locator('#bClarityCard')).toBeVisible();
    await expect(page.locator('#mClarityIncl')).not.toBeChecked();
    await expect(page.locator('#mClaritySign')).not.toBeChecked();
  });

  test('both pages print in the preview, each toggles off, and it survives a save', async ({
    page,
    request,
  }) => {
    const title = 'E2E Clarity On ' + Date.now();
    await adventureProposal(request, title, { whatsIncluded: true, beforeYouSign: true });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await signIn(page);
    await openInBuilder(page, title);
    await expect(page.locator('#bClarityDetail')).toContainText('R-2MBL1Z-10x8');

    await page.locator('#bPreview').click();
    const sheets = page.locator('.ssg-sheet');
    await expect(sheets.first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.ssg-sheet', { hasText: 'Your System, Decoded' })).toHaveCount(1);
    await expect(page.locator('.ssg-sheet', { hasText: 'Your Investment, Scope' })).toHaveCount(1);
    const included = page.locator('.ssg-sheet', { hasText: 'Your System, Decoded' });
    await expect(included).toContainText('Climbing Wall: Wall Mounted');
    await expect(included).toContainText('4 column wraps · 1 ladder wrap');
    await expect(included).toContainText("What's Included · Page 1 of");
    const withBoth = await sheets.count();
    await page.locator('#pvClose').click();

    // Off goes Before You Sign; the page count drops by exactly one.
    await page.locator('#mClaritySign').uncheck();
    await page.locator('#bSave').click();
    await expect(page.locator('#bSave')).toHaveText('Save', { timeout: 20_000 });
    await openInBuilder(page, title);
    await expect(page.locator('#mClarityIncl')).toBeChecked();
    await expect(page.locator('#mClaritySign')).not.toBeChecked();
    await page.locator('#bPreview').click();
    await expect(page.locator('.ssg-sheet').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.ssg-sheet', { hasText: 'Your Investment, Scope' })).toHaveCount(0);
    expect(await page.locator('.ssg-sheet').count()).toBe(withBoth - 1);
    expect(errors).toEqual([]);
  });

  test('Administration → Frame naming edits the page wording and previews it', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await signIn(page);
    await page.locator('#nav .nav-item[data-view="admin"]').click();
    await page.locator('[data-admt="proposals"]').click();
    await page.locator('[data-admacctoggle="propFrameNaming"]').click();
    const heading = page.locator('[data-path="page.text.includedHeading"]');
    await expect(heading).toHaveValue("What's Included in Your Proposal", { timeout: 20_000 });
    await expect(page.locator('#fcPreview')).toContainText('Square Frame');

    // Two rows on one page position is refused before it can be saved.
    const order = page.locator('[data-path="page.features.ladders.pageOrder"]');
    await order.fill('20');
    await expect(page.locator('#fcPreview')).toContainText('page order 20');
    await expect(page.locator('#fcSave')).toBeDisabled();
    await order.fill('40');
    await expect(page.locator('#fcPreview')).toContainText('Square Frame');
    expect(errors).toEqual([]);
  });
});
