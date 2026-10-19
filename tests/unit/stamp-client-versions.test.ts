import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * vercel.json caches any script URL carrying `?v=` for a year, immutable. That is only
 * safe because scripts/stamp-client-versions.mjs rewrites every tag's `?v=` to the
 * deploy's commit during the Vercel build. These pin both halves: the stamp covers
 * every tag (or the build fails), it never touches the file outside Vercel, and the
 * long cache applies only to URLs that carry the stamp.
 */

const root = join(__dirname, '..', '..');
const script = join(root, 'scripts', 'stamp-client-versions.mjs');

function run(env: Record<string, string | undefined>, html: string) {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), html);
  const res = spawnSync(process.execPath, [script], {
    cwd: dir,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  return { status: res.status, html: readFileSync(join(dir, 'public', 'index.html'), 'utf8') };
}

describe('stamp-client-versions', () => {
  it('stamps every script tag in the real index.html with the commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-real-'));
    mkdirSync(join(dir, 'public'));
    copyFileSync(join(root, 'public', 'index.html'), join(dir, 'public', 'index.html'));
    const res = spawnSync(process.execPath, [script], {
      cwd: dir,
      env: { PATH: process.env.PATH, VERCEL: '1', VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890' },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    const out = readFileSync(join(dir, 'public', 'index.html'), 'utf8');
    const srcs = [...out.matchAll(/<script src="(\/[^"]+\.js[^"]*)"/g)].map((m) => m[1]!);
    expect(srcs.length).toBeGreaterThan(10);
    for (const src of srcs) expect(src).toMatch(/\?v=abcdef123456$/);
  });

  it('adds a stamp to a tag that had none', () => {
    const r = run(
      { VERCEL: '1', VERCEL_GIT_COMMIT_SHA: '0123456789ab' },
      '<script src="/a.js?v=7"></script><script src="/b.js"></script>',
    );
    expect(r.status).toBe(0);
    expect(r.html).toBe(
      '<script src="/a.js?v=0123456789ab"></script><script src="/b.js?v=0123456789ab"></script>',
    );
  });

  it('leaves index.html alone outside a Vercel build', () => {
    const html = '<script src="/a.js?v=7"></script>';
    const r = run({ VERCEL: undefined }, html);
    expect(r.status).toBe(0);
    expect(r.html).toBe(html);
  });

  it('fails the build when the commit is unknown', () => {
    const r = run({ VERCEL: '1' }, '<script src="/a.js?v=7"></script>');
    expect(r.status).toBe(1);
  });

  it('vercel.json gives the year-long cache only to URLs with ?v=', () => {
    const cfg = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as {
      buildCommand: string;
      headers: Array<{
        source: string;
        has?: Array<{ type: string; key: string }>;
        headers: Array<{ key: string; value: string }>;
      }>;
    };
    const rule = cfg.headers.find((h) => /immutable/.test(h.headers[0]?.value ?? ''));
    expect(rule).toBeTruthy();
    expect(rule!.has).toEqual([{ type: 'query', key: 'v' }]);
    expect(cfg.buildCommand).toContain('node scripts/stamp-client-versions.mjs');
  });
});
