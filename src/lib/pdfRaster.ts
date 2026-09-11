import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { logger } from './logger.js';
import { acquirePage, type Route } from '../render/pdf.js';

/**
 * Rasterize a PDF's pages to PNG images, once, so a reference document (a W9, a
 * certificate of insurance — arbitrary page count and content, uploaded by an
 * admin) can be shown as ordinary image "sheets" in the client-side proposal
 * preview and print pipeline (public/app.js's `paginateProposalArea` /
 * `proposalStandaloneHtml`). That pipeline is pure HTML with no mechanism of its
 * own for merging real PDF pages — unlike the email/e-sign/monday paths, which
 * merge the actual PDF via lib/pdfMerge.ts — so the only way to make a reference
 * document appear there at all is to turn its pages into images ahead of time.
 * See proposals/referenceDocumentPages.ts for the once-per-document cache this
 * feeds.
 *
 * Runs pdf.js (`pdfjs-dist`) INSIDE the same headless Chromium already used for
 * HTML → PDF rendering (render/pdf.ts's shared browser, via `acquirePage`),
 * rather than either of the two more obvious options:
 *
 *   - Chromium's own built-in PDF viewer cannot be used: Playwright's bundled
 *     Chromium ships with it disabled (a direct navigation to any PDF URL — even
 *     a local `file://` one — always fires a "Download is starting" event
 *     instead of rendering, confirmed empirically against this exact Chromium
 *     build). There is no supported way to turn it back on from Playwright.
 *   - A native rasterizer (`pdf-to-png`/`sharp`+`poppler`/node `canvas`) would
 *     add a compiled binary dependency, which this repo has deliberately avoided
 *     everywhere else a PDF is touched (pdf-lib and Chromium are both pure
 *     JS/already-required-binary).
 *
 * pdf.js instead draws each page onto a real `<canvas>` element inside the page,
 * so `canvas.toDataURL()` is a plain, deterministic PNG export with no plugin or
 * native module involved — just JavaScript, which headless Chromium already runs
 * perfectly well.
 *
 * pdf.js's own two files (`pdf.mjs`, the ES module entry point, and
 * `pdf.worker.mjs`, which it loads as a Web Worker) are served to the page via
 * Playwright request interception rather than a real network fetch or a
 * `file://` navigation: an ES module `import` from a `file://` origin is blocked
 * by the same CORS rule that blocks any cross-origin module import (the page's
 * origin there is the literal string `null`) — confirmed empirically — and this
 * function must not depend on the app's own dev/prod server being reachable from
 * inside its own render step (this can run mid-request, before any response has
 * gone out). Routing every request on a fake HTTPS origin to in-memory file
 * content sidesteps both problems: nothing here ever touches the real network.
 */

const require = createRequire(import.meta.url);
const ORIGIN = 'https://ssg-reference-doc-raster.invalid';

interface LibFiles {
  pdfMjs: string;
  workerMjs: string;
}

let libFilesPromise: Promise<LibFiles> | null = null;

function loadLibFiles(): Promise<LibFiles> {
  if (!libFilesPromise) {
    libFilesPromise = (async () => {
      const pdfMjsPath = require.resolve('pdfjs-dist/build/pdf.mjs');
      const workerMjsPath = require.resolve('pdfjs-dist/build/pdf.worker.mjs');
      const [pdfMjs, workerMjs] = await Promise.all([
        readFile(pdfMjsPath, 'utf8'),
        readFile(workerMjsPath, 'utf8'),
      ]);
      return { pdfMjs, workerMjs };
    })();
  }
  return libFilesPromise;
}

function harnessHtml(): string {
  return (
    '<!doctype html><html><body><script type="module">\n' +
    `  import * as pdfjsLib from '${ORIGIN}/pdf.mjs';\n` +
    `  pdfjsLib.GlobalWorkerOptions.workerSrc = '${ORIGIN}/pdf.worker.mjs';\n` +
    '  window.__pdfjsLib = pdfjsLib;\n' +
    '  window.__pdfjsReady = true;\n' +
    '</script></body></html>'
  );
}

export interface RasterPage {
  /** CSS pixels at the render scale used below — already reflects the source PDF page's own aspect ratio. */
  width: number;
  height: number;
  /** `data:image/png;base64,...` */
  dataUri: string;
}

/**
 * The script actually run inside the headless page, as a STRING — same
 * convention render/pdf.ts's `waitForFunction` call uses and for the same
 * reason (see the comment on `Page.evaluate` in render/pdf.ts): this module has
 * no DOM lib, `window`/`document`/`atob`/`canvas` are not real identifiers here,
 * and the code only ever runs on the OTHER side of the CDP connection. The
 * arguments are JSON-embedded directly into the string rather than passed as a
 * separate `evaluate` parameter, which keeps this file's `Page.evaluate` down to
 * the single-string form pdf.ts already declares.
 */
function renderAllPagesScript(args: { base64: string; scale: number }): string {
  return `(async () => {
    var args = ${JSON.stringify(args)};
    var pdfjsLib = window.__pdfjsLib;
    var bin = atob(args.base64);
    var data = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    var doc = await pdfjsLib.getDocument({ data: data }).promise;
    var out = [];
    for (var n = 1; n <= doc.numPages; n++) {
      var page = await doc.getPage(n);
      var viewport = page.getViewport({ scale: args.scale });
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      var ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;
      out.push({ width: canvas.width, height: canvas.height, dataUri: canvas.toDataURL('image/png') });
    }
    return out;
  })()`;
}

/**
 * Render every page of a PDF to a PNG.
 *
 * `scale` is CSS pixels per PDF point (72 per inch) — the default of 2 renders at
 * 192dpi, sharp enough to read and print, without the multi-megabyte-per-page
 * cost of going much higher. A Letter page (612x792pt) comes out 1224x1584px.
 *
 * Throws on a corrupt or unreadable PDF — the caller (referenceDocumentPages.ts)
 * decides whether that should drop the whole document from a proposal preview
 * (the same "silently drop it" rule resolveReferenceDocuments already applies to
 * a retired document) rather than failing the preview outright.
 */
export async function rasterizePdfPages(bytes: Buffer, scale = 2): Promise<RasterPage[]> {
  const { pdfMjs, workerMjs } = await loadLibFiles();
  const page = await acquirePage();
  try {
    await page.route(`${ORIGIN}/*`, (route: Route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/harness.html`) {
        return route.fulfill({ status: 200, contentType: 'text/html', body: harnessHtml() });
      }
      if (url === `${ORIGIN}/pdf.mjs`) {
        return route.fulfill({ status: 200, contentType: 'text/javascript', body: pdfMjs });
      }
      if (url === `${ORIGIN}/pdf.worker.mjs`) {
        return route.fulfill({ status: 200, contentType: 'text/javascript', body: workerMjs });
      }
      return route.abort();
    });
    await page.goto(`${ORIGIN}/harness.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__pdfjsReady === true', undefined, { timeout: 10_000 });
    return await page.evaluate<RasterPage[]>(
      renderAllPagesScript({ base64: bytes.toString('base64'), scale }),
    );
  } catch (err) {
    logger.error({ err }, 'pdfRaster: could not rasterize a reference document');
    throw err;
  } finally {
    await page.close().catch(() => undefined);
  }
}
