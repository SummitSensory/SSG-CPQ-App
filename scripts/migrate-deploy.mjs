#!/usr/bin/env node
/**
 * Apply pending migrations during the build.
 *
 * Three things this does that `prisma migrate deploy` on its own does not, each
 * because of a real failure:
 *
 * 1. **Uses the direct connection, explicitly.** Neon's pooled endpoint (the host
 *    with `-pooler` in it) cannot hold a Postgres advisory lock, and
 *    `migrate deploy` takes one before it does anything. Through the pooler it
 *    waits ten seconds and fails with `P1002` — which reads like the database is
 *    down when in fact the wrong endpoint was used. If DIRECT_URL is missing or
 *    still points at the pooler, this says so in words rather than timing out.
 *
 * 2. **Retries.** A Neon compute that has scaled to zero takes a few seconds to
 *    wake, and the first connection of a build is exactly when that happens. A
 *    transient cold start must not fail a deploy.
 *
 * 3. **Fails the build when migrations genuinely cannot apply.** This is the point
 *    of running them here at all: deploying code whose schema has not been applied
 *    breaks every query against the affected tables, not just the new feature.
 *    Better a red build than a live 500.
 *
 * Skipped entirely when there is no database URL, so a build without database
 * access (a preview with no branch database, a local `vercel build`) still succeeds.
 */

import { execSync } from 'node:child_process';

const ATTEMPTS = 4;
const BACKOFF_MS = [2000, 5000, 10000];

/** The pooled host cannot hold advisory locks; the direct one can. */
function isPooled(url) {
  try {
    return new URL(url).hostname.includes('-pooler');
  } catch {
    return false;
  }
}

function main() {
  const direct = process.env.DIRECT_URL;
  const pooled = process.env.DATABASE_URL;

  if (!direct && !pooled) {
    console.log('migrate: no DATABASE_URL or DIRECT_URL — skipping migrations.');
    return;
  }

  // Prisma reads directUrl from the schema, but migrate falls back to `url` when
  // DIRECT_URL is unset — which is how a pooled connection ends up holding the lock.
  // Passing it as DATABASE_URL for this one command removes the ambiguity.
  const url = direct ?? pooled;

  if (isPooled(url)) {
    console.error(
      [
        '',
        'migrate: the connection string points at a POOLED endpoint (-pooler).',
        '',
        'Prisma takes a Postgres advisory lock before applying migrations, and the',
        'pooler cannot hold one — this fails as P1002 "reached but timed out" after',
        '10 seconds, which looks like an outage but is not.',
        '',
        'Fix: set DIRECT_URL in Vercel to the UNPOOLED Neon connection string',
        '(the same host without "-pooler"), for Production and Preview both.',
        'Leave DATABASE_URL on the pooled endpoint — the running app wants that one.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log(
    `migrate: applying pending migrations via ${direct ? 'DIRECT_URL' : 'DATABASE_URL'}.`,
  );

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      execSync('prisma migrate deploy', {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      });
      console.log('migrate: up to date.');
      // Did the migrations actually produce the schema the code expects? Reported,
      // not enforced: the deploy has already applied everything it was given, and
      // failing here would block a release over a diff that may be a deliberate
      // manual change. Silence, though, is how drift survives for weeks.
      try {
        execSync('node scripts/schema-drift-check.mjs --warn', {
          stdio: 'inherit',
          env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
        });
      } catch {
        console.log('migrate: drift check could not run.');
      }
      return;
    } catch {
      const wait = BACKOFF_MS[attempt - 1];
      if (attempt === ATTEMPTS || wait === undefined) {
        console.error(
          [
            '',
            `migrate: failed after ${ATTEMPTS} attempts. Failing the build deliberately.`,
            '',
            'Deploying code whose migrations have not run breaks every query against the',
            'affected tables — including screens unrelated to the change. A red build is',
            'the cheaper outcome.',
            '',
            'If the database is genuinely down, retry the deployment once it is back.',
            'If a previous run left the migration lock held, wait a minute and retry.',
            '',
          ].join('\n'),
        );
        process.exit(1);
      }
      // Almost always a Neon compute waking from zero.
      console.log(`migrate: attempt ${attempt} failed, retrying in ${wait}ms.`);
      execSync(`node -e "setTimeout(()=>{}, ${wait})"`);
    }
  }
}

main();
