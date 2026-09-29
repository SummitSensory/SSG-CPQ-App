import { readFile, readdir, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, sep } from 'node:path';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

/**
 * HTML → PDF, for documents a customer or vendor receives: the Bill of Materials
 * and the Ryan Capital financing sheet.
 *
 * Runs headless Chromium so the PDF is the same document the browser's print
 * dialog produces — one HTML template, not a second layout engine that drifts.
 *
 * Two deliberate choices:
 *
 *   1. **Everything is imported lazily.** `playwright-core` and the Chromium pack
 *      are heavy and only needed when someone actually exports. A deployment
 *      without them installed still boots; the export just reports that PDF is
 *      unavailable and Excel keeps working.
 *   2. **One browser per render, never shared.** See acquirePage for why a cached
 *      browser cannot work with the serverless build of Chromium. What is expensive
 *      on a cold container is fetching and unpacking the pack, not launching the
 *      browser, and the unpacked copy is what stays warm (see chromiumExecutable).
 *
 * Vercel: fits inside Pro's limits (3 GB memory, 300 s duration). The full
 * Playwright browser exceeds the 250 MB bundle cap, so `@sparticuz/chromium-min`
 * fetches the compressed pack at cold start instead of bundling it — set
 * CHROMIUM_PACK_URL to the pack matching the installed version.
 *
 *   pnpm add playwright-core @sparticuz/chromium-min
 */

type Browser = {
  newPage: () => Promise<Page>;
  close: () => Promise<void>;
  isConnected: () => boolean;
};
/** A Playwright request, narrowed to what a route handler here needs. */
export type RouteRequest = { url: () => string };
/** A Playwright route, narrowed to what a route handler here needs. */
export type Route = {
  request: () => RouteRequest;
  fulfill: (opts: { status?: number; contentType?: string; body: string }) => Promise<void>;
  abort: () => Promise<void>;
};
type Page = {
  setContent: (html: string, opts?: Record<string, unknown>) => Promise<void>;
  emulateMedia: (opts: Record<string, unknown>) => Promise<void>;
  pdf: (opts: Record<string, unknown>) => Promise<Buffer>;
  close: () => Promise<void>;
  waitForFunction: (fn: string, arg?: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  route: (pattern: string, handler: (route: Route) => unknown) => Promise<void>;
  /**
   * A source-code STRING, not a function reference — same reason waitForFunction
   * takes one above: this file has no DOM lib (it is a server-side module), and
   * the expression runs inside the PAGE, not here. See lib/pdfRaster.ts, the one
   * caller, for how arguments are passed in (JSON-embedded in the string).
   */
  evaluate: <T>(script: string) => Promise<T>;
};

/**
 * `public/app.js`'s `proposalStandaloneHtml` ships its own pagination as an inline
 * `<script>` — the exact function the rep's own browser runs, so there is one
 * implementation rather than two that drift (see that function's own comment). It
 * marks `document.documentElement` with `data-paginated="1"` once the real page
 * breaks, margins and "Page N of M" footer are actually in the DOM — but only after
 * `document.fonts.ready` resolves, which is asynchronous and has no relationship to
 * `domcontentloaded` at all. A page can be captured before that promise settles.
 */
const PAGINATION_MARKER = 'paginateProposalArea';

/** True when the renderer's optional dependencies are installed. */
export async function pdfAvailable(): Promise<boolean> {
  try {
    await import('playwright-core');
    return true;
  } catch {
    return false;
  }
}

type LaunchConfig = { executablePath?: string; args: string[] };
let executablePromise: Promise<LaunchConfig> | null = null;

/**
 * Where Chromium is and how to start it — resolved once per container.
 *
 * Locally, Playwright's own Chromium is on the machine and no pack is needed. On the
 * serverless host the pack is fetched and unpacked to /tmp: that is the several-second
 * cold start, and it is the part worth keeping warm. Launching the unpacked binary
 * afterwards takes milliseconds.
 */
function chromiumExecutable(): Promise<LaunchConfig> {
  if (!executablePromise) {
    const resolving = (async (): Promise<LaunchConfig> => {
      if (!env.CHROMIUM_PACK_URL) return { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
      const mod = (await import('@sparticuz/chromium-min')) as unknown as {
        default: { executablePath: (url: string) => Promise<string>; args: string[] };
      };
      const sparticuz = mod.default;
      const executablePath = await sparticuz.executablePath(env.CHROMIUM_PACK_URL);
      // The downloaded pack is only the compressed source of what was just unpacked to
      // /tmp/chromium (and executablePath() returns that copy whenever it exists), so
      // keeping it only spends ~65 MB of the 512 MB /tmp.
      await rm(join(tmpdir(), 'chromium-pack'), { recursive: true, force: true }).catch(
        () => undefined,
      );
      const args = sparticuz.args.map((a) =>
        a.startsWith('--disk-cache-size=') ? `--disk-cache-size=${DISK_CACHE_BYTES}` : a,
      );
      return { executablePath, args };
    })();
    executablePromise = resolving;
    // A failed fetch must not be handed to the next caller as the answer.
    resolving.catch(() => {
      if (executablePromise === resolving) executablePromise = null;
    });
  }
  return executablePromise;
}

/**
 * Every document here is set with `setContent` and has its images inlined as data
 * URIs (see inlineKnownAssets), so there is nothing for Chromium's HTTP cache to
 * cache. Its default on the serverless pack is 32 MB per profile, all of it in /tmp.
 */
const DISK_CACHE_BYTES = 1024 * 1024;

/** Every browser this module has launched and not yet closed. */
const openBrowsers = new Set<Browser>();

async function launch(): Promise<Browser> {
  const { chromium } = (await import('playwright-core')) as unknown as {
    chromium: { launch: (o: Record<string, unknown>) => Promise<Browser> };
  };
  const { executablePath, args } = await chromiumExecutable();
  if (env.CHROMIUM_PACK_URL) await freeServerlessTmp();
  try {
    const browser = await chromium.launch({
      args,
      ...(executablePath ? { executablePath } : {}),
      headless: true,
    });
    openBrowsers.add(browser);
    return browser;
  } catch (err) {
    if (err instanceof Error && err.message.includes('ENOSPC')) {
      logger.error({ err, tmp: await tmpUsage() }, 'pdf: /tmp is full, Chromium could not launch');
    }
    throw err;
  }
}

/**
 * Profiles a previous browser in this container failed to clean up.
 *
 * Vercel's /tmp is 512 MB and lives as long as the warm container does. Each launch
 * gives Chromium a profile directory there, which Playwright deletes when the browser
 * exits. One that never exits cleanly leaves it behind. On 2026-09-28 the old cached
 * browser (which died on every page close — see acquirePage) filled /tmp that way:
 * `browserType.launch: ENOSPC: no space left on device, mkdtemp
 * '/tmp/playwright_chromiumdev_profile-…'` — Save PDF failed, fell back to the browser
 * print dialog, and the rep got the 76%-scaled copy the server renderer exists to
 * prevent.
 *
 * Only directories older than any render can be: several requests can render at once
 * in one container, each with its own live profile, and none of them outlives the
 * function's 180 s limit. Never locally — the machine's temp directory is shared with
 * the developer's own Playwright runs.
 */
const STALE_TMP_PREFIXES = ['playwright_chromiumdev_profile-', 'playwright-artifacts-'];
const STALE_TMP_AGE_MS = 10 * 60_000;

async function freeServerlessTmp(): Promise<void> {
  const root = tmpdir();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TMP_AGE_MS;
  const candidates = names.filter((n) => STALE_TMP_PREFIXES.some((p) => n.startsWith(p)));
  const stale = (
    await Promise.all(
      candidates.map(async (n) => {
        const s = await stat(join(root, n)).catch(() => null);
        return s && s.mtimeMs < cutoff ? n : null;
      }),
    )
  ).filter((n): n is string => n !== null);
  if (!stale.length) return;
  await Promise.all(
    stale.map((n) => rm(join(root, n), { recursive: true, force: true }).catch(() => undefined)),
  );
  logger.info({ removed: stale.length }, 'pdf: removed profiles left by earlier browsers');
}

/** Free/total bytes of /tmp, for the log line when it fills up anyway. */
async function tmpUsage(): Promise<{ freeBytes: number; totalBytes: number } | null> {
  try {
    const s = await statfs(tmpdir());
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/**
 * Time limits on every call into Chromium. A browser that stops answering would
 * otherwise wait out the function's whole 180 s and the request would die with a 504
 * (production, 2026-09-24/26: a Save PDF and three monday-file uploads). A limit turns
 * the hang into an error the caller can report, or retry (see renderPdf).
 */
const DEFAULT_LIMITS = { launchMs: 60_000, newPageMs: 10_000, renderMs: 45_000 };
let limits = { ...DEFAULT_LIMITS };

/** Tests only: shrink the limits so a hang can be exercised in milliseconds. */
export function setRenderLimitsForTests(next: Partial<typeof DEFAULT_LIMITS> | null): void {
  limits = next ? { ...DEFAULT_LIMITS, ...next } : { ...DEFAULT_LIMITS };
}

export class RenderTimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RenderTimeoutError(`pdf: ${what} took over ${ms} ms`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * Close a browser without letting a stuck one hold the request. Playwright removes the
 * profile directory once the process exits; one that never exits is swept later (see
 * freeServerlessTmp).
 */
async function closeBrowser(browser: Browser): Promise<void> {
  openBrowsers.delete(browser);
  await withTimeout(browser.close(), 5_000, 'closing the browser').catch(() => undefined);
}

/**
 * Fetch and unpack Chromium now, so the next render does not pay the cold start.
 * Called when a rep opens a proposal (GET /render/warm), a few seconds before they are
 * likely to press Save PDF or Print. Never throws.
 *
 * `reused` is true when this container had already unpacked it.
 */
export async function warmRenderer(): Promise<{ ok: boolean; reused: boolean; ms: number }> {
  const t0 = Date.now();
  if (!(await pdfAvailable())) return { ok: false, reused: false, ms: 0 };
  const reused = executablePromise !== null;
  try {
    await withTimeout(chromiumExecutable(), limits.launchMs, 'preparing Chromium');
    return { ok: true, reused, ms: Date.now() - t0 };
  } catch (err) {
    logger.warn({ err }, 'pdf: warm-up failed');
    return { ok: false, reused: false, ms: Date.now() - t0 };
  }
}

/**
 * A page on a browser of its own. Closing the page closes that browser.
 *
 * Why not one cached browser per container, which is what this used to be: the
 * serverless build runs Chromium with `--single-process`, and in that mode closing a
 * page kills the whole browser (SIGTRAP) — reproduced on Amazon Linux 2023 with the
 * same pack, even for an empty page. So the cached browser was dead after every
 * render: the next request on a warm container waited out the new-page limit and
 * relaunched, each dead browser could leave its profile in /tmp (the ENOSPC above),
 * and a request that closed a page while another was still printing on the shared
 * browser took that render down with it (`Page.printToPDF: Printing failed`, on
 * 2026-09-29). A browser of its own per render costs ~15 ms to launch once the pack
 * is unpacked, and nothing one request does can reach another.
 *
 * Shared with lib/pdfRaster.ts, which needs a page rather than a full renderPdf.
 */
export async function acquirePage(): Promise<Page> {
  if (!(await pdfAvailable())) {
    throw new Error(
      'PDF rendering is not installed on this deployment — run: pnpm add playwright-core @sparticuz/chromium-min',
    );
  }
  const browser = await withTimeout(launch(), limits.launchMs, 'launching Chromium');
  let page: Page;
  try {
    page = await withTimeout(browser.newPage(), limits.newPageMs, 'opening a page');
  } catch (err) {
    await closeBrowser(browser);
    throw err;
  }
  // Only `close` changes: the caller's close is the end of this browser's one job, and
  // closing the page itself first is exactly what crashes a single-process Chromium.
  return {
    setContent: (html, opts) => page.setContent(html, opts),
    emulateMedia: (opts) => page.emulateMedia(opts),
    pdf: (opts) => page.pdf(opts),
    waitForFunction: (fn, arg, opts) => page.waitForFunction(fn, arg, opts),
    goto: (url, opts) => page.goto(url, opts),
    route: (pattern, handler) => page.route(pattern, handler),
    evaluate: <T>(script: string) => page.evaluate<T>(script),
    close: () => closeBrowser(browser),
  };
}

/**
 * Proposal templates reference images two ways: an admin-uploaded photo comes
 * in as a `data:` URI already (see `prepareImage` in
 * public/proposal-front-matter.js), but the company logo, the engineer-of-
 * record badge, and every "house file" fallback photo for every product line
 * (Adventure, Soar, Flex) are plain paths — `logo.png`, `/proposal/flex-p3-
 * unit.jpg` — because those resolve fine in a real browser tab, against the
 * app's own origin. None of them resolve here: `page.setContent()` gives the
 * page no base URL at all, so every one of them came out as a broken image
 * (or, worse, silent blank space) in every server-rendered document — the
 * monday upload, the DocuSeal signing package, anything routed through this
 * file. Embedded as data URIs before Chromium ever sees the markup instead,
 * matching the "self-contained" rule above.
 *
 * Deliberately not a fixed list of paths: the failure mode here (a local
 * asset referenced by path, invisible in every server-rendered PDF, working
 * fine on screen so nobody notices) already hit two unrelated hardcoded
 * images and, separately, every house photo behind every product line's
 * introduction — a fixed allowlist just repeats that mistake against the
 * next template someone adds a picture to.
 */
const IMG_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*(["'])([^"']*)\1/gi;
const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** Read once per warm container and cached — these are static app assets. */
const inlineAssetCache = new Map<string, Promise<string | null>>();

/**
 * Resolve a local `<img src>` to an embeddable data URI, or null for anything
 * that is not a local, recognised-image, in-bounds file — a `data:` URI
 * already, an `http(s)://` URL (never fetched; this renderer promises to
 * touch nothing on the network), or a path that does not stay inside
 * `public/` once resolved. That last check matters because not every caller
 * of `renderPdf` necessarily authored the HTML it passes in itself (an
 * attachment's markup, for one) — a crafted `src="../../.env"` must not turn
 * an `<img>` tag into a file-read of anything outside the app's own assets.
 */
function loadLocalImageAsset(src: string): Promise<string | null> {
  if (src.startsWith('data:') || /^[a-z][a-z0-9+.-]*:\/\//i.test(src)) return Promise.resolve(null);
  const cached = inlineAssetCache.get(src);
  if (cached) return cached;
  const promise = (async () => {
    const mime = EXT_TO_MIME[extname(src).toLowerCase()];
    if (!mime) return null;
    const publicRoot = join(process.cwd(), 'public');
    const abs = join(publicRoot, src.replace(/^\/+/, ''));
    if (abs !== publicRoot && !abs.startsWith(publicRoot + sep)) return null;
    try {
      const buf = await readFile(abs);
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err) {
      // Missing on disk is a deploy/content problem, not a reason to fail the
      // whole render — the image goes out exactly as broken as it always was.
      logger.warn({ err, src }, 'pdf: could not load a local image asset, leaving its src as-is');
      return null;
    }
  })();
  inlineAssetCache.set(src, promise);
  return promise;
}

export async function inlineKnownAssets(html: string): Promise<string> {
  const srcs = new Set<string>();
  for (const m of html.matchAll(IMG_SRC_RE)) if (m[2]) srcs.add(m[2]);
  if (!srcs.size) return html;

  const resolved = await Promise.all(
    Array.from(srcs).map(async (src) => [src, await loadLocalImageAsset(src)] as const),
  );

  let out = html;
  for (const [src, dataUri] of resolved) {
    if (!dataUri) continue;
    out = out.split(`src="${src}"`).join(`src="${dataUri}"`);
    out = out.split(`src='${src}'`).join(`src='${dataUri}'`);
  }
  return out;
}

export interface PdfOptions {
  /** Paper size. Letter for US-facing documents, which is everything here. */
  format?: 'Letter' | 'A4';
  landscape?: boolean;
  marginTop?: string;
  marginBottom?: string;
  /**
   * Print with no page margin at all, letting the document own its own geometry.
   *
   * The customer proposal needs this: its introduction pages are authored at a full
   * 8.5in x 11in and print edge to edge, and the itemized pages carry their half inch
   * as padding instead. A margin applied here would shrink the introduction pages onto
   * a smaller box and spill each one onto a second sheet.
   */
  edgeToEdge?: boolean;
  headerHtml?: string;
  footerHtml?: string;
}

/**
 * Render a complete HTML document to a PDF buffer.
 *
 * The HTML must be self-contained — inline CSS, no external stylesheets or
 * images. Nothing here fetches from the network, so a broken asset URL can't
 * hang the render or leak a request from the render host.
 */
export async function renderPdf(html: string, opts: PdfOptions = {}): Promise<Buffer> {
  if (!(await pdfAvailable())) {
    throw new Error(
      'PDF rendering is not installed on this deployment — export as Excel, or run: pnpm add playwright-core @sparticuz/chromium-min',
    );
  }
  html = await inlineKnownAssets(html);
  /*
   * One retry, on another fresh browser, when Chromium itself failed — a crash or a
   * protocol error such as `Page.printToPDF: Printing failed`. Never after a render
   * that timed out: that already cost the rep 45 s, and a document that hangs one
   * browser hangs the next. A launch that fails (no pack, /tmp full) is not retried
   * either — it throws from acquirePage before an attempt starts.
   */
  const attempt = async (): Promise<Buffer> => {
    const page = await acquirePage();
    try {
      return await withTimeout(renderOnPage(page, html, opts), limits.renderMs, 'rendering');
    } finally {
      await page.close();
    }
  };
  try {
    return await attempt();
  } catch (err) {
    if (err instanceof RenderTimeoutError) throw err;
    logger.warn({ err }, 'pdf: render failed; retrying once on a fresh browser');
    return await attempt();
  }
}

async function renderOnPage(page: Page, html: string, opts: PdfOptions): Promise<Buffer> {
  // 'domcontentloaded' rather than 'networkidle': the document is self-contained,
  // so waiting on the network only adds the timeout to every render.
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  // Only for documents that actually ship the inline pagination script (see
  // PAGINATION_MARKER's own comment) — everything else (an attachment, the
  // certificate page, a financing sheet) has no `data-paginated` attribute to
  // wait for, and waiting on one would just burn the full timeout on every
  // render that doesn't use it. Best-effort: a font/pagination bug that never
  // signals completion should still produce a PDF — an imperfectly paginated
  // page is a smaller problem than no document at all.
  if (html.includes(PAGINATION_MARKER)) {
    // A string, not a function reference: this file has no DOM lib (it is a
    // server-side module), and the expression below runs inside the PAGE, not
    // here — Playwright accepts either form for exactly this reason.
    await page
      .waitForFunction(
        'document.documentElement.getAttribute("data-paginated") === "1"',
        undefined,
        {
          timeout: 10_000,
        },
      )
      .catch((err: unknown) => {
        logger.warn({ err }, 'pdf: pagination did not signal completion in time; rendering as-is');
      });
  }
  await page.emulateMedia({ media: 'print' });
  const hasChrome = !!(opts.headerHtml || opts.footerHtml);
  if (opts.edgeToEdge) {
    return await page.pdf({
      format: opts.format ?? 'Letter',
      landscape: !!opts.landscape,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
  }
  return await page.pdf({
    format: opts.format ?? 'Letter',
    landscape: !!opts.landscape,
    printBackground: true,
    displayHeaderFooter: hasChrome,
    ...(opts.headerHtml ? { headerTemplate: opts.headerHtml } : {}),
    ...(opts.footerHtml ? { footerTemplate: opts.footerHtml } : {}),
    margin: {
      top: opts.marginTop ?? (hasChrome ? '0.7in' : '0.5in'),
      bottom: opts.marginBottom ?? (hasChrome ? '0.6in' : '0.5in'),
      left: '0.45in',
      right: '0.45in',
    },
  });
}

/** Close every browser still open. Called on shutdown; safe to call twice. */
export async function closeRenderer(): Promise<void> {
  await Promise.all(Array.from(openBrowsers, (b) => closeBrowser(b)));
}
