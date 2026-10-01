import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Production 2026-10-01 00:19: a refused render's /tmp report read
 * `core.chromium.114 941 MB, core.chromium.150 908 MB, … core.chromium.182 133 MB`.
 * The serverless host lets a crashing Chromium dump its whole memory into /tmp, and
 * one dump filled the 512 MB disk for every render after it. Chromium is now started
 * through a launcher that turns core dumps off, and any dump already in /tmp is
 * removed before a launch.
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
const launchedWith: string[] = [];
vi.mock('playwright-core', () => ({
  chromium: {
    launch: vi.fn(async (o: { executablePath: string }) => {
      launchedWith.push(o.executablePath);
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

// One temp directory for the whole file: the launcher is written once per process,
// when Chromium is first resolved, exactly as it is on a warm serverless container.
beforeAll(() => {
  fakeTmp = mkdtempSync(join(tmpdir(), 'pdf-core-dumps-'));
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = fakeTmp;
});
afterAll(async () => {
  await closeRenderer();
  for (const [k, v] of Object.entries(savedTmpEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(fakeTmp, { recursive: true, force: true });
});

describe('Chromium core dumps on the serverless host', () => {
  it('starts Chromium through a launcher that switches core dumps off', async () => {
    await renderPdf('<html><body>x</body></html>');
    const launcher = join(fakeTmp, 'chromium-nocore.sh');
    expect(launchedWith[0]).toBe(launcher);
    const script = readFileSync(launcher, 'utf8');
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('\nulimit -c 0\n');
    // exec, so the launcher becomes Chromium and Playwright's pipes stay attached.
    expect(script).toContain(`exec '${join(fakeTmp, 'chromium')}' "$@"`);
  });

  it('removes core dumps left in /tmp, whatever their age, before launching', async () => {
    for (const n of ['core', 'core.4242', 'core.chromium.114']) {
      writeFileSync(join(fakeTmp, n), Buffer.alloc(64 * 1024));
    }
    // Not dumps: a directory named core, and files that only start with the word.
    mkdirSync(join(fakeTmp, 'core.dir.7'));
    writeFileSync(join(fakeTmp, 'core-notes.txt'), 'keep');
    writeFileSync(join(fakeTmp, 'corefile'), 'keep');

    await renderPdf('<html><body>x</body></html>');

    expect(existsSync(join(fakeTmp, 'core'))).toBe(false);
    expect(existsSync(join(fakeTmp, 'core.4242'))).toBe(false);
    expect(existsSync(join(fakeTmp, 'core.chromium.114'))).toBe(false);
    expect(existsSync(join(fakeTmp, 'core.dir.7'))).toBe(true);
    expect(existsSync(join(fakeTmp, 'core-notes.txt'))).toBe(true);
    expect(existsSync(join(fakeTmp, 'corefile'))).toBe(true);
    // The launcher itself is not swept.
    expect(existsSync(join(fakeTmp, 'chromium-nocore.sh'))).toBe(true);
  });
});
