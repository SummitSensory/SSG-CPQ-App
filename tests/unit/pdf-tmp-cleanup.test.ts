import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Production 2026-09-28: `browserType.launch: ENOSPC: no space left on device, mkdtemp
 * '/tmp/playwright_chromiumdev_profile-…'`. Vercel's /tmp is 512 MB for the life of the
 * warm container; every relaunch after a reclaimed browser left the dead browser's
 * profile behind, and the downloaded chromium pack was never deleted. Save PDF failed,
 * fell back to the browser print dialog, and the rep got a 76%-scaled PDF.
 *
 * `vi.mock` (hoisted), for the reason tests/unit/pdf-pagination-wait.test.ts gives.
 */
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const mockEnv: { CHROMIUM_PACK_URL?: string } = {};
vi.mock('../../src/config/env.js', () => ({
  get env() {
    return mockEnv;
  },
}));
vi.mock('@sparticuz/chromium-min', () => ({
  default: {
    executablePath: vi.fn(async () => join(tmpdir(), 'chromium')),
    args: ['--no-sandbox', '--disk-cache-size=33554432', '--single-process'],
  },
}));
const launchArgs: string[][] = [];
vi.mock('playwright-core', () => ({
  chromium: {
    launch: vi.fn(async (o: { args: string[] }) => {
      launchArgs.push(o.args);
      return {
        newPage: async () => ({
          setContent: async () => undefined,
          emulateMedia: async () => undefined,
          pdf: async () => Buffer.from('pdf'),
          close: async () => undefined,
          waitForFunction: async () => undefined,
        }),
        close: async () => undefined,
        isConnected: () => true,
      };
    }),
  },
}));

const { renderPdf, closeRenderer } = await import('../../src/render/pdf.js');

const savedTmpEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
let fakeTmp: string;

beforeEach(async () => {
  await closeRenderer();
  launchArgs.length = 0;
  fakeTmp = mkdtempSync(join(tmpdir(), 'pdf-tmp-cleanup-'));
  // os.tmpdir() reads these on every call: TMPDIR on Linux/macOS, TMP/TEMP on Windows.
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = fakeTmp;
  mockEnv.CHROMIUM_PACK_URL = 'https://example.test/chromium-pack.tar';
});
afterEach(async () => {
  await closeRenderer();
  for (const [k, v] of Object.entries(savedTmpEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(fakeTmp, { recursive: true, force: true });
});

describe('renderPdf on the serverless host', () => {
  it("clears dead browsers' profiles and the spent pack before launching", async () => {
    for (const d of [
      'playwright_chromiumdev_profile-aaaa',
      'playwright_chromiumdev_profile-bbbb',
      'playwright-artifacts-cccc',
      'chromium-pack',
    ]) {
      mkdirSync(join(fakeTmp, d));
      writeFileSync(join(fakeTmp, d, 'Cache'), 'x'.repeat(1024));
    }
    writeFileSync(join(fakeTmp, 'chromium'), 'binary');
    writeFileSync(join(fakeTmp, 'unrelated.txt'), 'keep me');

    await renderPdf('<html><body>x</body></html>');

    expect(existsSync(join(fakeTmp, 'playwright_chromiumdev_profile-aaaa'))).toBe(false);
    expect(existsSync(join(fakeTmp, 'playwright_chromiumdev_profile-bbbb'))).toBe(false);
    expect(existsSync(join(fakeTmp, 'playwright-artifacts-cccc'))).toBe(false);
    expect(existsSync(join(fakeTmp, 'chromium-pack'))).toBe(false);
    // The unpacked browser and anything that is not Chromium's own leftovers stay.
    expect(existsSync(join(fakeTmp, 'chromium'))).toBe(true);
    expect(existsSync(join(fakeTmp, 'unrelated.txt'))).toBe(true);
  });

  it('caps the per-profile disk cache instead of the pack default of 32 MB', async () => {
    await renderPdf('<html><body>x</body></html>');
    expect(launchArgs[0]).toContain('--disk-cache-size=1048576');
    expect(launchArgs[0]).not.toContain('--disk-cache-size=33554432');
    expect(launchArgs[0]).toContain('--single-process');
  });

  it('leaves the temp directory alone when not on the serverless host', async () => {
    delete mockEnv.CHROMIUM_PACK_URL;
    mkdirSync(join(fakeTmp, 'playwright_chromiumdev_profile-local'));
    await renderPdf('<html><body>x</body></html>');
    expect(existsSync(join(fakeTmp, 'playwright_chromiumdev_profile-local'))).toBe(true);
  });
});
