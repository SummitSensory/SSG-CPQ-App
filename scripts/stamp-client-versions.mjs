#!/usr/bin/env node
/**
 * Stamp every client script tag in public/index.html with the deploy's commit.
 *
 * Runs in the Vercel build only. vercel.json gives a script URL that carries `?v=` a
 * year-long immutable cache, so the browser stops re-asking for ~2 MB of JavaScript on
 * every page load. That is only safe if `?v=` changes whenever the file does — and the
 * hand-kept numbers in index.html do not: app.js changes in nearly every commit, its
 * tag far less often. Stamped with the commit, every deploy is a new URL for every
 * script, and an unchanged URL is guaranteed to be unchanged code.
 *
 * Refuses to run outside a Vercel build: it rewrites a committed file, and doing that
 * on a developer's machine would leave index.html dirty in the working tree.
 *
 * Fails the build (exit 1) rather than deploy half-stamped: if any local script tag is
 * left without the stamp, an immutable cache could pin a stale script for a year.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (!process.env.VERCEL) {
  console.log('stamp-client-versions: not a Vercel build, index.html left as committed');
  process.exit(0);
}

const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 12);
if (!/^[0-9a-f]{7,12}$/.test(sha)) {
  console.error('stamp-client-versions: VERCEL_GIT_COMMIT_SHA is missing; refusing to deploy');
  process.exit(1);
}

const file = join(process.cwd(), 'public', 'index.html');
const html = readFileSync(file, 'utf8');
const tag = /(<script src="\/[^"?]+\.js)(\?v=[^"]*)?"/g;
let count = 0;
const stamped = html.replace(tag, (_m, src) => {
  count++;
  return `${src}?v=${sha}"`;
});
const unstamped = [...stamped.matchAll(/<script src="(\/[^"]+\.js[^"]*)"/g)]
  .map((m) => m[1])
  .filter((src) => !src.endsWith(`?v=${sha}`));
if (!count || unstamped.length) {
  console.error(
    `stamp-client-versions: ${count} tag(s) stamped, unstamped: ${unstamped.join(', ') || 'none found'}`,
  );
  process.exit(1);
}
writeFileSync(file, stamped);
console.log(`stamp-client-versions: ${count} script tags stamped ?v=${sha}`);
