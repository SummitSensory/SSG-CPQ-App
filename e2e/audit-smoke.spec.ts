import { test, expect, type Page, type Response } from '@playwright/test';

// Audit smoke: load the app shell and open every main screen in the sidebar, failing
// on any console error, any uncaught page error, and any same-origin request that
// answers 5xx or a Fastify "Route ... not found" 404 (a client calling an endpoint
// that does not exist).
//
// Full-stack: requires the API running against a seeded Postgres and a SYSTEM_ADMIN
// bearer token in E2E_TOKEN (same convention as the other specs). The token is put
// where public/app.js keeps it (localStorage `ssg_at`) before the page loads. The
// anonymous check always runs.
const token = process.env.E2E_TOKEN;

/**
 * Known, already-diagnosed noise — listed explicitly so anything NEW still fails.
 *
 * 1. Inline `onerror="..."` on intro-art thumbnails (public/intro-admin.js:50,
 *    public/proposal-front-matter.js:300) is refused by the CSP's
 *    `script-src-attr 'none'`, which logs a console error per image. intro-admin.js
 *    re-binds the handler with addEventListener, so it is noise, not breakage.
 * 2. `/proposal/*.jpg|png` house art is served by Vercel's static CDN in production,
 *    but src/routes/web.ts has no route for public/proposal/**, so under the local
 *    Fastify server (and the CI e2e server) every intro image 404s.
 */
const KNOWN: RegExp[] = [
  /Executing inline event handler violates the following Content Security Policy directive 'script-src-attr 'none''/,
  /GET \S+\/proposal\/[\w.-]+\.(jpg|png) -> 404 \(no such route\)/,
];

interface Problem {
  where: string;
  what: string;
}

function watch(page: Page, origin: string): { problems: Problem[]; setWhere: (w: string) => void } {
  const problems: Problem[] = [];
  let where = 'load';
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // The browser's own line for a failed fetch duplicates the response check below.
    if (/Failed to load resource/.test(text)) return;
    problems.push({ where, what: `console.error: ${text}` });
  });
  page.on('pageerror', (err) => problems.push({ where, what: `pageerror: ${err.message}` }));
  page.on('response', async (res: Response) => {
    const url = res.url();
    if (!url.startsWith(origin)) return;
    const status = res.status();
    if (status >= 500) {
      problems.push({ where, what: `${res.request().method()} ${url} -> ${status}` });
      return;
    }
    if (status === 404) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        body = '';
      }
      if (/Route \w+:[^ ]+ not found/.test(body)) {
        problems.push({ where, what: `${res.request().method()} ${url} -> 404 (no such route)` });
      }
    }
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (!url.startsWith(origin)) return;
    const reason = req.failure()?.errorText ?? '';
    // Navigating away aborts in-flight requests; that is not a defect.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(reason)) return;
    problems.push({ where, what: `${req.method()} ${url} failed: ${reason}` });
  });
  return { problems, setWhere: (w) => (where = w) };
}

test('the login page loads without errors for an anonymous visitor', async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
  const { problems } = watch(page, origin);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // An anonymous visitor's own 401s are expected; only defects are recorded above.
  expect(problems, JSON.stringify(problems, null, 2)).toEqual([]);
});

test.describe('audit smoke: every main screen', () => {
  test.skip(!token, 'set E2E_TOKEN and run against a live stack');
  test.setTimeout(180_000);

  test('opens each sidebar screen without console errors or failed API calls', async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
    await page.addInitScript((t) => {
      try {
        localStorage.setItem('ssg_at', t);
      } catch {
        /* storage blocked: the test will fail on the missing shell instead */
      }
    }, token!);
    const { problems, setWhere } = watch(page, origin);

    await page.goto('/');
    await page.waitForSelector('#nav .nav-item', { timeout: 20_000 });
    await page.waitForLoadState('networkidle');

    const views = await page
      .locator('#nav .nav-item[data-view]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-view') ?? ''));
    expect(views.length).toBeGreaterThan(3);

    for (const view of views) {
      if (!view) continue;
      setWhere(view);
      await page.locator(`#nav .nav-item[data-view="${view}"]`).first().click();
      await page.waitForLoadState('networkidle');
      // A screen that renders asynchronously after its data arrives.
      await page.waitForTimeout(400);
      await expect(page.locator('#view')).toBeVisible();
    }

    const unexpected = problems.filter((p) => !KNOWN.some((re) => re.test(p.what)));
    expect(unexpected, JSON.stringify(unexpected, null, 2)).toEqual([]);
  });
});
