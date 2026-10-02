import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * One browser per render (see acquirePage in src/render/pdf.ts): the serverless
 * Chromium runs `--single-process`, where closing a page kills the whole browser, so a
 * cached one was dead after every render — and one request closing a page could take
 * down another's print (`Page.printToPDF: Printing failed`, production 2026-09-29).
 * These pin the contract: every render gets its own browser, it is closed afterwards,
 * a Chromium failure is retried once, and nothing waits out the function's 180 s.
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
function makeBrowser(newPage: () => Promise<ReturnType<typeof makePage>>) {
  const pages: Array<ReturnType<typeof makePage>> = [];
  return {
    pages,
    newPage: vi.fn(async () => {
      const p = await newPage();
      pages.push(p);
      return p;
    }),
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

const { renderPdf, acquirePage, warmRenderer, closeRenderer, setRenderLimitsForTests } =
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

describe('renderPdf browser lifecycle', () => {
  it('gives every render its own browser and closes it — never the page on its own', async () => {
    await expect(renderPdf('<p>one</p>')).resolves.toEqual(Buffer.from('fresh-pdf'));
    await expect(renderPdf('<p>two</p>')).resolves.toEqual(Buffer.from('fresh-pdf'));
    expect(launched).toHaveLength(2);
    for (const b of launched) {
      expect(b.close).toHaveBeenCalledTimes(1);
      // Closing a page is what crashes a single-process Chromium.
      expect(b.pages[0]?.close).not.toHaveBeenCalled();
    }
  });

  it('keeps concurrent renders on separate browsers', async () => {
    let release: (() => void) | undefined;
    // A generous launch limit: this test is about which browser each render uses,
    // not launch timeouts, and two fake launches on a busy CI runner overran 500ms.
    setRenderLimitsForTests({ launchMs: 5_000, newPageMs: 10, renderMs: 5_000 });
    const gate = new Promise<void>((r) => (release = r));
    nextBrowser = () =>
      makeBrowser(async () =>
        makePage(async () => {
          await gate;
          return Buffer.from('slow-pdf');
        }),
      );
    const a = renderPdf('<p>a</p>');
    const b = renderPdf('<p>b</p>');
    await vi.waitFor(() => expect(launched).toHaveLength(2));
    // One finishing (and closing its browser) must not touch the other's.
    expect(launched[0]?.close).not.toHaveBeenCalled();
    expect(launched[1]?.close).not.toHaveBeenCalled();
    release?.();
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
  });

  it('retries a Chromium failure once, on another fresh browser', async () => {
    let n = 0;
    nextBrowser = () =>
      makeBrowser(async () =>
        makePage(async () =>
          ++n === 1
            ? Promise.reject(
                new Error('page.pdf: Protocol error (Page.printToPDF): Printing failed'),
              )
            : Buffer.from('retried-pdf'),
        ),
      );
    await expect(renderPdf('<p>x</p>')).resolves.toEqual(Buffer.from('retried-pdf'));
    expect(launched).toHaveLength(2);
    expect(launched[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('reports a failure that repeats instead of retrying forever', async () => {
    nextBrowser = () =>
      makeBrowser(async () => makePage(async () => Promise.reject(new Error('document broken'))));
    await expect(renderPdf('<p>x</p>')).rejects.toThrow('document broken');
    expect(launched).toHaveLength(2);
  });

  it('gives up with an error, not a 180-second hang, and does not retry a timeout', async () => {
    nextBrowser = () => makeBrowser(async () => makePage(() => never<Buffer>()));
    await expect(renderPdf('<p>x</p>')).rejects.toThrow(/took over 45 ms/);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('closes a browser that never opens a page, within the limit', async () => {
    nextBrowser = () => makeBrowser(() => never());
    await expect(acquirePage()).rejects.toThrow(/opening a page took over 10 ms/);
    expect(launched[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('warm-up prepares Chromium without leaving a browser running', async () => {
    const out = await warmRenderer();
    expect(out.ok).toBe(true);
    expect(launched).toHaveLength(0);
  });
});
