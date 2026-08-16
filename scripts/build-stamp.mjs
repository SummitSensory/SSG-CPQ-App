#!/usr/bin/env node
/**
 * Stamp the build.
 *
 * Runs first in the build and overwrites src/lib/buildStamp.ts, which the server imports
 * and the sidebar shows under Sign Out.
 *
 * Two decisions worth knowing:
 *
 * A generated TypeScript MODULE, not a JSON file read at runtime. A root-level JSON read
 * with readFileSync is not guaranteed to be bundled into a Vercel function — the bundler
 * traces imports, not filesystem calls — so the stamp would silently vanish in
 * production, which is the one place it matters. An import cannot be missed.
 *
 * The file is committed with nulls in it, so a fresh checkout typechecks and runs before
 * anyone has run this script. The build overwrites it; the committed version is only
 * ever what a local `pnpm dev` sees.
 *
 * The one thing the Vercel environment cannot tell us is when the build ran, and "what is
 * deployed right now" is mostly a question about time. Module load time is no substitute:
 * a function cold starts days after a deploy and would report today for last week's code.
 * The build is the only moment that knows, so that is where it is recorded.
 */
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const git = (args) => {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
};

const env = process.env;
const commit = env.VERCEL_GIT_COMMIT_SHA || git('rev-parse HEAD') || null;
const branch = env.VERCEL_GIT_COMMIT_REF || git('rev-parse --abbrev-ref HEAD') || null;
const message = env.VERCEL_GIT_COMMIT_MESSAGE || git('log -1 --pretty=%s') || null;
const author = env.VERCEL_GIT_COMMIT_AUTHOR_NAME || git('log -1 --pretty=%an') || null;

// The commit's own date, because "the date of the files that were pushed" is the commit
// date rather than the moment Vercel got round to building them. Vercel's checkout is
// shallow but still holds the tip commit, so this normally resolves; where it does not,
// the build time is the honest fallback and the client says which one it is showing.
const committedAt = git('log -1 --pretty=%cI') || null;

const info = {
  builtAt: new Date().toISOString(),
  committedAt,
  commit,
  shortCommit: commit ? commit.slice(0, 7) : null,
  branch,
  message: message ? String(message).split('\n')[0].slice(0, 200) : null,
  author,
  environment: env.VERCEL_ENV || env.NODE_ENV || 'development',
};

const body = `/**
 * GENERATED — do not edit.
 *
 * Written by scripts/build-stamp.mjs at the start of every build. The committed copy of
 * this file is the local-development placeholder; CI overwrites it. See lib/buildInfo.ts.
 */
import type { BuildInfo } from './buildInfo.js';

export const BUILD_STAMP: BuildInfo = ${JSON.stringify(info, null, 2)};
`;

const out = join(process.cwd(), 'src', 'lib', 'buildStamp.ts');
writeFileSync(out, body, 'utf8');
console.log(
  `build stamp: ${info.shortCommit ?? 'unknown'} on ${info.branch ?? '?'} — ${info.builtAt}`,
);
