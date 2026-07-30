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

type Browser = { newPage: () => Promise<Page>; close: () => Promise<void>; isConnected: () => boolean };
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

export interface PdfOptions {
  /** Paper size. Letter for US-facing documents, which is everything here. */
  format?: 'Letter' | 'A4';
  landscape?: boolean;
  marginTop?: string;
  marginBottom?: string;
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
    throw new Error('PDF rendering is not installed on this deployment — export as Excel, or run: pnpm add playwright-core @sparticuz/chromium-min');
  }
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // 'domcontentloaded' rather than 'networkidle': the document is self-contained,
    // so waiting on the network only adds the timeout to every render.
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.emulateMedia({ media: 'print' });
    const hasChrome = !!(opts.headerHtml || opts.footerHtml);
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
  if (b) await b.close().catch((e: unknown) => logger.warn({ err: e }, 'pdf: browser close failed'));
}
