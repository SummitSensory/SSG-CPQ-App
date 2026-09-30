import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Production 2026-09-30 16:59: POST /render/proposals/document.pdf failed twice with
 * `page.pdf: Target page, context or browser has been closed`; Chromium's own log said
 * `Less than 64MB of free space in temporary directory for shared memory files: 2`.
 * The serverless pack keeps its shared memory in /tmp, so the browser died mid-print
 * and the retry died the same way. These pin what the renderer does about a full /tmp:
 * sweep every orphan when nothing is rendering, and otherwise refuse with a report of
 * what is filling it, instead of launching a browser that cannot print.
 *
 * `vi.mock` (hoisted), for the reason tests/unit/pdf-pagination-wait.test.ts gives.
 */
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  env: { CHROMIUM_PACK_URL: 'https://example.test/chromium-pack.tar' },
}));
vi.mock('@sparticuz/chromium-min', () => ({
  default: {
    executablePath: vi.fn(async () => join(tmpdir(), 'chromium')),
    args: ['--single-process'],
  },
}));

const MB = 1024 * 1024;
/** Free bytes each successive statfs of /tmp reports; the last one repeats. */
let freeQueue: number[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    statfs: vi.fn(async () => {
      const free = (freeQueue.length > 1 ? freeQueue.shift() : freeQueue[0]) ?? 400 * MB;
      return { bavail: free, bsize: 1, blocks: 512 * MB };
    }),
  };
});

let pdfImpl: () => Promise<Buffer> = async () => Buffer.from('pdf');
const launch = vi.fn(async () => ({
  newPage: async () => ({
    setContent: async () => undefined,
    emulateMedia: async () => undefined,
    pdf: () => pdfImpl(),
    close: async () => undefined,
    waitForFunction: async () => undefined,
  }),
  close: async () => undefined,
  isConnected: () => true,
}));
vi.mock('playwright-core', () => ({ chromium: { launch } }));

const { renderPdf, closeRenderer, RendererTmpFullError } = await import('../../src/render/pdf.js');

const savedTmpEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
let fakeTmp: string;

beforeEach(async () => {
  await closeRenderer();
  launch.mockClear();
  pdfImpl = async () => Buffer.from('pdf');
  freeQueue = [];
  fakeTmp = mkdtempSync(join(tmpdir(), 'pdf-tmp-full-'));
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = fakeTmp;
});
afterEach(async () => {
  await closeRenderer();
  for (const [k, v] of Object.entries(savedTmpEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(fakeTmp, { recursive: true, force: true });
});

/** A profile and a shared-memory file younger than the normal 10-minute sweep. */
function youngLeftovers(): { profile: string; shm: string } {
  const profile = join(fakeTmp, 'playwright_chromiumdev_profile-young');
  mkdirSync(profile);
  const shm = join(fakeTmp, '.org.chromium.Chromium.abc123');
  writeFileSync(shm, 'x');
  return { profile, shm };
}

describe('renderPdf when /tmp is nearly full', () => {
  it('sweeps every orphan when nothing is rendering, then renders', async () => {
    const { profile, shm } = youngLeftovers();
    // Low before the sweep, room after it.
    freeQueue = [2 * MB, 300 * MB];
    await expect(renderPdf('<p>x</p>')).resolves.toEqual(Buffer.from('pdf'));
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(shm)).toBe(false);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('leaves young leftovers alone when there is room', async () => {
    const { profile, shm } = youngLeftovers();
    freeQueue = [300 * MB];
    await renderPdf('<p>x</p>');
    expect(existsSync(profile)).toBe(true);
    expect(existsSync(shm)).toBe(true);
  });

  it('refuses without launching or retrying, and says what fills /tmp', async () => {
    writeFileSync(join(fakeTmp, 'something-big.bin'), Buffer.alloc(3 * MB));
    freeQueue = [2 * MB];
    const err = await renderPdf('<p>x</p>').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RendererTmpFullError);
    expect((err as Error).message).toMatch(/2 MB free of 512 MB/);
    expect((err as Error).message).toMatch(/something-big\.bin 3 MB/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('ends with the space report when a crash filled /tmp during the first attempt', async () => {
    pdfImpl = async () => {
      freeQueue = [2 * MB];
      throw new Error('page.pdf: Target page, context or browser has been closed');
    };
    freeQueue = [300 * MB];
    await expect(renderPdf('<p>x</p>')).rejects.toBeInstanceOf(RendererTmpFullError);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('never sweeps a young profile while another render is in progress', async () => {
    const { profile } = youngLeftovers();
    let release: (() => void) | undefined;
    pdfImpl = () =>
      new Promise<Buffer>((resolve) => {
        release = () => resolve(Buffer.from('pdf'));
      });
    freeQueue = [300 * MB];
    const first = renderPdf('<p>first</p>');
    await vi.waitFor(() => expect(release).toBeDefined());
    freeQueue = [2 * MB];
    await expect(renderPdf('<p>second</p>')).rejects.toBeInstanceOf(RendererTmpFullError);
    expect(existsSync(profile)).toBe(true);
    release?.();
    await expect(first).resolves.toEqual(Buffer.from('pdf'));
  });
});
