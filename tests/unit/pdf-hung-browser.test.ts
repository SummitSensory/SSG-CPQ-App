import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A cached Chromium the platform reclaimed while the container was frozen does not
 * always throw — sometimes it just never answers. Production 2026-09-24/26: a Save PDF
 * and three monday-file uploads, each a later request on an already-warm container,
 * waited out the function's whole 180 s and died with a 504. renderPdf must turn that
 * hang into a bounded wait and one retry on a fresh browser — and must NOT retry a
 * failure on a browser it has only just launched.
 *
 * `vi.mock` (hoisted), for the reason tests/unit/pdf-pagination-wait.test.ts gives.
 */
const never = <T>() => new Promise<T>(() => undefined);

function makePage(pdf: () => Promise<Buffer>) {
  return {
    setContent: vi.fn().mockResolvedValue(undefined),
    emulateMedia: vi.fn().mockResolvedValue(undefined),
    pdf: vi.fn(pdf),
    close: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
  };
}
function makeBrowser(newPage: () => Promise<unknown>) {
  return {
    newPage: vi.fn(newPage),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
  };
}

const launched: Array<ReturnType<typeof makeBrowser>> = [];
let nextBrowser: () => ReturnType<typeof makeBrowser>;
vi.mock('playwright-core', () => ({
  chromium: {
    launch: vi.fn(async () => {
      const b = nextBrowser();
      launched.push(b);
      return b;
    }),
  },
}));

const { renderPdf, closeRenderer, setRenderLimitsForTests } =
  await import('../../src/render/pdf.js');

const good = () => makeBrowser(async () => makePage(async () => Buffer.from('fresh-pdf')));

beforeEach(async () => {
  await closeRenderer();
  launched.length = 0;
  nextBrowser = good;
  // The production limits scaled down 1000x (10 s -> 10 ms, 45 s -> 45 ms): the same
  // code paths, exercised with real timers in milliseconds.
  setRenderLimitsForTests({ launchMs: 500, newPageMs: 10, renderMs: 45 });
});
afterEach(() => setRenderLimitsForTests(null));

/** Render once so the next call is handed the cached (reused) browser. */
async function warmWith(browser: ReturnType<typeof makeBrowser>) {
  nextBrowser = () => browser;
  await renderPdf('<p>first</p>');
  nextBrowser = good;
}

describe('renderPdf on a hung browser', () => {
  it('a reused browser that never opens a page is replaced within seconds, not 180', async () => {
    let calls = 0;
    const stale = makeBrowser(async () => {
      calls += 1;
      return calls === 1 ? makePage(async () => Buffer.from('warm-pdf')) : never();
    });
    await warmWith(stale);

    const out = renderPdf('<p>second</p>');
    await expect(out).resolves.toEqual(Buffer.from('fresh-pdf'));
    expect(launched).toHaveLength(2);
  });

  it('a render that hangs on a reused browser is retried once on a fresh one', async () => {
    let n = 0;
    const stale = makeBrowser(async () =>
      makePage(async () => (++n === 1 ? Buffer.from('warm-pdf') : never<Buffer>())),
    );
    await warmWith(stale);

    const out = renderPdf('<p>second</p>');
    await expect(out).resolves.toEqual(Buffer.from('fresh-pdf'));
    expect(launched).toHaveLength(2);
  });

  it('does not retry a failure on a browser it has just launched', async () => {
    nextBrowser = () =>
      makeBrowser(async () => makePage(async () => Promise.reject(new Error('document broken'))));
    await expect(renderPdf('<p>x</p>')).rejects.toThrow('document broken');
    expect(launched).toHaveLength(1);
  });

  it('gives up with an error, not a 180-second hang, when a fresh browser hangs too', async () => {
    nextBrowser = () => makeBrowser(async () => makePage(() => never<Buffer>()));
    const out = renderPdf('<p>x</p>');
    const settled = expect(out).rejects.toThrow(/took over 45 ms/);
    await settled;
  });
});
