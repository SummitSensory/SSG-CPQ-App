import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

/**
 * Reference-document PDF pages, rasterized to PNGs.
 *
 * The proposal preview overlay and the browser's own Print / Save-PDF are pure
 * client-side HTML with no PDF-page-merging capability — unlike the emailed/e-signed
 * copy, which appends a reference document's real PDF pages via pdf-lib (see
 * src/lib/pdfMerge.ts). To show a W9 or certificate of insurance in that HTML preview,
 * each of its pages has to become an image instead.
 *
 * Deliberately a SEPARATE headless-Chromium browser instance from render/pdf.ts,
 * not a shared one, even though both lazily launch the same playwright-core +
 * @sparticuz/chromium-min stack: renderPdf's browser is on the path of every
 * customer-facing PDF this app produces (the BOM, the financing sheet, the DocuSeal
 * package, the proposal PDF itself) across a dozen call sites. A bug or a hung page in
 * this file's much rarer, best-effort rasterization must never be able to leave that
 * shared browser in a bad state — see discardBrowser's own comment on how easy that is
 * to get subtly wrong on a serverless host.
 *
 * The rasterizer itself is pdf.js, run INSIDE the headless page rather than in this
 * Node process — pdf.js needs a real Canvas 2D implementation to paint a page onto,
 * which Node does not have without a native `canvas`/`@napi-rs/canvas` dependency this
 * repo does not carry (and does not want: this Vercel deployment already avoids native
 * add-ons other than argon2, and @sparticuz/chromium-min was chosen specifically to
 * dodge Vercel's serverless bundle-size cap). The already-installed headless Chromium
 * supplies that Canvas for free, so pdf.js's own browser bundle is loaded into the page
 * as a blob URL and driven from there — no new native dependency, no second renderer to
 * keep in sync, and no network fetch at render time (pdf.js's own worker script is
 * inlined the same way, via the documented `globalThis.pdfjsWorker` hook, so it runs on
 * the page's main thread instead of spawning a real Worker).
 */

type Browser = {
  newPage: () => Promise<Page>;
  close: () => Promise<void>;
  isConnected: () => boolean;
};
type Page = {
  // A real function reference, not a string: Playwright ships a STRING pageFunction
  // to the page as a bare expression and does not apply `arg` to it (confirmed against
  // playwright-core directly — passing a string function source together with an arg
  // silently evaluates to undefined instead of calling it). A function reference is
  // shipped by its own `.toString()` and correctly invoked with `arg` in the page.
  evaluate: (fn: (arg: unknown) => unknown, arg?: unknown) => Promise<unknown>;
  close: () => Promise<void>;
};

let browserPromise: Promise<Browser> | null = null;

/** True when the optional rendering dependencies are installed. */
export async function pdfRasterAvailable(): Promise<boolean> {
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

/** Same reasoning as render/pdf.ts's discardBrowser: isConnected() lies on a reclaimed serverless container. */
function discardBrowser(): void {
  const stale = browserPromise;
  browserPromise = null;
  void stale?.then((b) => b.close().catch(() => undefined)).catch(() => undefined);
}

/** pdf.js's own browser bundle and worker source, read once per warm container. */
let pdfjsSourcesPromise: Promise<{ lib: string; worker: string }> | null = null;
function pdfjsSources(): Promise<{ lib: string; worker: string }> {
  if (!pdfjsSourcesPromise) {
    pdfjsSourcesPromise = (async () => {
      const require = createRequire(import.meta.url);
      const [lib, worker] = await Promise.all([
        readFile(require.resolve('pdfjs-dist/build/pdf.mjs'), 'utf8'),
        readFile(require.resolve('pdfjs-dist/build/pdf.worker.mjs'), 'utf8'),
      ]);
      return { lib, worker };
    })();
  }
  return pdfjsSourcesPromise;
}

export interface RasterizedPage {
  width: number;
  height: number;
  png: Buffer;
}

interface RasterResult {
  numPages: number;
  pages: Array<{ width: number; height: number; dataUrl: string }>;
}

/**
 * Runs INSIDE the headless page — written as a string, for the same reason
 * render/pdf.ts's waitForFunction is a string: this file has no DOM lib (it is a
 * server-side module) and the expression below runs in the PAGE, not here. Turned
 * into a real function via `new Function` just before the `page.evaluate` call —
 * Playwright ships a bare string pageFunction to the page as an unapplied
 * expression and does NOT invoke it with `arg`, so a string has to become a real
 * function reference first (see `rasterizeFn` below).
 *
 * Loads pdf.js's browser bundle and worker via blob URLs and dynamic `import()`
 * (the documented no-bundler technique), points pdf.js at the worker via
 * `globalThis.pdfjsWorker` so it runs in-page rather than spawning a real Worker
 * (see this file's own doc comment), then renders every page of the PDF onto a
 * canvas and reads it back as a PNG data URL.
 */
const RASTERIZE_FN = `async (arg) => {
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  var libUrl = URL.createObjectURL(new Blob([arg.pdfSrc], { type: 'text/javascript' }));
  var workerUrl = URL.createObjectURL(new Blob([arg.workerSrc], { type: 'text/javascript' }));
  try {
    var pdfjsLib = await import(/* webpackIgnore: true */ libUrl);
    var pdfjsWorker = await import(/* webpackIgnore: true */ workerUrl);
    globalThis.pdfjsWorker = pdfjsWorker;
    var loadingTask = pdfjsLib.getDocument({ data: b64ToBytes(arg.pdfBase64), isEvalSupported: false });
    var doc = await loadingTask.promise;
    var pages = [];
    for (var i = 1; i <= doc.numPages; i++) {
      var page = await doc.getPage(i);
      var viewport = page.getViewport({ scale: arg.scale });
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      var ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;
      pages.push({ width: canvas.width, height: canvas.height, dataUrl: canvas.toDataURL('image/png') });
      page.cleanup();
    }
    await loadingTask.destroy();
    return { numPages: doc.numPages, pages: pages };
  } finally {
    URL.revokeObjectURL(libUrl);
    URL.revokeObjectURL(workerUrl);
  }
}`;

/**
 * `RASTERIZE_FN` compiled to a real function once, in THIS Node process — not run
 * here (this process has no `document`/`Blob`/`atob`), only turned from a string into
 * a function value so Playwright will actually call it with `arg` in the page. See
 * RASTERIZE_FN's own comment.
 */
const rasterizeFn = new Function(`return (${RASTERIZE_FN})`)() as (
  arg: unknown,
) => Promise<RasterResult>;

/**
 * Rasterize every page of a PDF to a PNG, at a fixed scale (2 = 144 DPI — a standard
 * 8.5in x 11in page comes out roughly 1224 x 1584px, sharp enough to print and small
 * enough to keep the cached blob and the preview payload reasonable).
 *
 * A malformed or unusual PDF (one relying on a non-embedded font pdf.js cannot
 * substitute without network-fetched cmap/standard-font data, which this renderer
 * deliberately never fetches — see the doc comment above) throws; the caller
 * (routes/referenceDocuments.ts) catches this per-document and skips it rather than
 * failing the whole proposal preview, the same tolerance appendPdfDocuments applies
 * to a reference document that turns out to be corrupt.
 */
export async function rasterizePdfPages(bytes: Buffer, scale = 2): Promise<RasterizedPage[]> {
  if (!(await pdfRasterAvailable())) {
    throw new Error(
      'PDF rasterization is not installed on this deployment — run: pnpm add playwright-core @sparticuz/chromium-min',
    );
  }
  const { lib, worker } = await pdfjsSources();
  const pdfBase64 = bytes.toString('base64');

  let page: Page;
  try {
    page = await (await getBrowser()).newPage();
  } catch (err) {
    logger.warn({ err }, 'pdfRaster: cached browser was dead, relaunching');
    discardBrowser();
    page = await (await getBrowser()).newPage();
  }
  try {
    const result = (await page.evaluate(rasterizeFn, {
      pdfSrc: lib,
      workerSrc: worker,
      pdfBase64,
      scale,
    })) as RasterResult;
    return result.pages.map((p) => ({
      width: p.width,
      height: p.height,
      png: Buffer.from(p.dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'),
    }));
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Release the cached browser. Safe to call twice; mirrors render/pdf.ts's closeRenderer. */
export async function closeRasterRenderer(): Promise<void> {
  const b = browserPromise ? await browserPromise.catch(() => null) : null;
  browserPromise = null;
  if (b)
    await b
      .close()
      .catch((e: unknown) => logger.warn({ err: e }, 'pdfRaster: browser close failed'));
}
