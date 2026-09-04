import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
 *   2. **The browser is reused across invocations.** Cold start dominates the
 *      cost (~2-4s), so the instance is cached on the module for the life of the
 *      warm serverless container.
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
type Page = {
  setContent: (html: string, opts?: Record<string, unknown>) => Promise<void>;
  emulateMedia: (opts: Record<string, unknown>) => Promise<void>;
  pdf: (opts: Record<string, unknown>) => Promise<Buffer>;
  close: () => Promise<void>;
};

let browserPromise: Promise<Browser> | null = null;

/** True when the renderer's optional dependencies are installed. */
export async function pdfAvailable(): Promise<boolean> {
  try {
    await import('playwright-core');
    return true;
  } catch {
    return false;
  }
}

async function launch(): Promise<Browser> {
  const { chromium } = (await import('playwright-core')) as unknown as {
    chromium: { launch: (o: Record<string, unknown>) => Promise<Browser> };
  };

  // Locally, Playwright's own Chromium is on the machine and no pack is needed.
  // On a serverless host the pack has to be fetched and unpacked to /tmp first.
  let executablePath: string | undefined;
  let args: string[] = ['--no-sandbox', '--disable-dev-shm-usage'];
  if (env.CHROMIUM_PACK_URL) {
    const mod = (await import('@sparticuz/chromium-min')) as unknown as {
      default: { executablePath: (url: string) => Promise<string>; args: string[] };
    };
    const sparticuz = mod.default;
    executablePath = await sparticuz.executablePath(env.CHROMIUM_PACK_URL);
    args = sparticuz.args;
  }

  return chromium.launch({ args, ...(executablePath ? { executablePath } : {}), headless: true });
}

async function getBrowser(): Promise<Browser> {
  const existing = browserPromise ? await browserPromise.catch(() => null) : null;
  if (existing && existing.isConnected()) return existing;
  browserPromise = launch();
  return browserPromise;
}

/**
 * Throw the cached browser away.
 *
 * `isConnected()` is not a liveness check on a serverless host. The container is
 * frozen between invocations and Chromium is a child process of it: when the platform
 * reclaims that process, the remote-debugging pipe is not closed in a way Playwright
 * notices, so `isConnected()` keeps answering true for a browser that is gone. The
 * failure then lands on the first call that actually talks to it —
 * `browser.newPage(): Target page, context or browser has been closed` — which is
 * what a user sees as a PDF export that fails once, apparently at random, and works on
 * the retry they do by hand.
 */
function discardBrowser(): void {
  const stale = browserPromise;
  browserPromise = null;
  // Best effort, and never awaited: the process is usually already gone, and waiting
  // on a close that cannot complete would add the timeout to the retry.
  void stale?.then((b) => b.close().catch(() => undefined)).catch(() => undefined);
}

/**
 * A handful of proposal templates reference a small, fixed set of images by a
 * plain relative path — `<img src="logo.png">` — because that resolves fine in
 * a real browser tab, against the app's own origin. It does not resolve here:
 * `page.setContent()` gives the page no base URL at all, so every one of these
 * came out as a broken image (or, worse, silent blank space) in every
 * server-rendered document — the monday upload, the DocuSeal signing package,
 * anything routed through this file. Embedded as data URIs before Chromium
 * ever sees the markup instead, matching the "self-contained" rule above.
 *
 * Read once per warm container and cached — these are static app assets, not
 * anything that changes between requests.
 */
const INLINE_ASSET_PATHS: Record<string, string> = {
  'logo.png': 'logo.png',
  'proposal/engineer-of-record-badge.png': 'proposal/engineer-of-record-badge.png',
};
let inlineAssetsPromise: Promise<Record<string, string>> | null = null;

function loadInlineAssets(): Promise<Record<string, string>> {
  if (!inlineAssetsPromise) {
    inlineAssetsPromise = Promise.all(
      Object.entries(INLINE_ASSET_PATHS).map(async ([key, relPath]) => {
        const buf = await readFile(join(process.cwd(), 'public', relPath));
        return [key, `data:image/png;base64,${buf.toString('base64')}`] as const;
      }),
    ).then((entries) => Object.fromEntries(entries));
  }
  return inlineAssetsPromise;
}

export async function inlineKnownAssets(html: string): Promise<string> {
  let assets: Record<string, string>;
  try {
    assets = await loadInlineAssets();
  } catch (err) {
    // Missing on disk would be a deploy problem, not a reason to fail every
    // render — the document goes out exactly as it would have before this
    // existed, with the same broken image it always had.
    logger.warn({ err }, 'pdf: could not load inline assets, leaving image sources as-is');
    return html;
  }
  let out = html;
  for (const [relPath, dataUri] of Object.entries(assets)) {
    out = out.split(`src="${relPath}"`).join(`src="${dataUri}"`);
    out = out.split(`src='${relPath}'`).join(`src='${dataUri}'`);
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
   * One retry on a fresh browser.
   *
   * The first attempt may be handed a cached browser whose process the platform has
   * since reclaimed (see discardBrowser). That is not a real failure and it is not
   * worth showing anyone: the second attempt launches cold and succeeds. A cold start
   * is a few seconds, which is why the cache exists at all, so this pays that cost
   * only when it has to.
   *
   * Deliberately once. If a freshly launched browser cannot open a page, something is
   * actually wrong — the chromium pack is missing, or the function is out of memory —
   * and looping would turn a clear error into a timeout.
   */
  let page: Page;
  try {
    page = await (await getBrowser()).newPage();
  } catch (err) {
    logger.warn({ err }, 'pdf: cached browser was dead, relaunching');
    discardBrowser();
    page = await (await getBrowser()).newPage();
  }
  try {
    // 'domcontentloaded' rather than 'networkidle': the document is self-contained,
    // so waiting on the network only adds the timeout to every render.
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
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
  } finally {
    // Close the page but keep the browser: the next export in this container skips
    // the cold start entirely.
    await page.close().catch(() => undefined);
  }
}

/** Release the cached browser. Called on shutdown; safe to call twice. */
export async function closeRenderer(): Promise<void> {
  const b = browserPromise ? await browserPromise.catch(() => null) : null;
  browserPromise = null;
  if (b)
    await b.close().catch((e: unknown) => logger.warn({ err: e }, 'pdf: browser close failed'));
}
