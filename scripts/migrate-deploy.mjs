#!/usr/bin/env node
/**
 * Apply pending migrations during the build.
 *
 * Four things this does that `prisma migrate deploy` on its own does not, each
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
 * 4. **Bootstraps a genuinely empty database.** `0000_baseline` builds the whole
 *    schema from nothing, and several historical migrations then try to create
 *    (or drop and recreate) some of that same schema again — see
 *    docs/database-migrations.md. Against a database that already has history
 *    (production, staging, a developer's Neon branch) that never happens,
 *    because those migrations already ran for real, months apart, before
 *    baseline existed. But a target that starts with zero rows in
 *    `_prisma_migrations` — CI's throwaway Postgres container, or a genuinely
 *    fresh preview branch database — hits it on every run. When (and only when)
 *    migration history is empty at the start, a migration that fails with a
 *    Postgres SQLSTATE meaning "this object is already exactly what baseline
 *    built" (a duplicate create, or a drop blocked by something baseline-built
 *    still depending on it) is superseded by baseline: mark it resolved and
 *    keep going, rather than failing the build over schema baseline already
 *    built.
 *
 * Skipped entirely when there is no database URL, so a build without database
 * access (a preview with no branch database, a local `vercel build`) still succeeds.
 */

import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const ATTEMPTS = 4;
const BACKOFF_MS = [2000, 5000, 10000];
const MAX_BOOTSTRAP_RESOLUTIONS = 60; // comfortably above the current migration count

// Postgres SQLSTATE codes for "this object is already exactly what baseline
// already built" — a duplicate create, or a drop blocked because something
// baseline-built still depends on the object. Not `23505` (unique_violation):
// that is a data conflict, not a structural one, and must still fail the build.
const SUPERSEDED_BY_BASELINE_CODES = new Set([
  '42710', // duplicate_object (types, etc.)
  '42P07', // duplicate_table
  '42701', // duplicate_column
  '42723', // duplicate_function
  '42P06', // duplicate_schema
  '2BP01', // dependent_objects_still_exist — e.g. DROP TYPE blocked by a column baseline created
]);

/** Prisma prints the underlying Postgres SQLSTATE as "Database error code: XXXXX". */
function supersededByBaseline(output) {
  const match = output.match(/Database error code:\s*(\S+)/);
  return match !== null && SUPERSEDED_BY_BASELINE_CODES.has(match[1]);
}

/** The pooled host cannot hold advisory locks; the direct one can. */
function isPooled(url) {
  try {
    return new URL(url).hostname.includes('-pooler');
  } catch {
    return false;
  }
}

/** True when the target has no migration history at all — a brand-new database. */
async function isEmptyDatabase(url) {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT count(*)::int AS count FROM "_prisma_migrations"',
    );
    return rows[0].count === 0;
  } catch {
    // "_prisma_migrations" itself does not exist yet — as empty as it gets.
    return true;
  } finally {
    await prisma.$disconnect();
  }
}

/** The migration `prisma migrate deploy` is currently stuck on, per its own ledger. */
async function stuckMigrationName(url) {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 1',
    );
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * One `prisma migrate deploy`. On a database that started with no migration
 * history, a migration that fails because its objects already exist (superseded
 * by `0000_baseline`, which runs first and builds them) is marked resolved
 * instead of failing the build, and deploy resumes from the next one. Bounded so
 * a genuinely different failure still surfaces instead of looping forever.
 */
async function deploy(url, startedEmpty) {
  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };
  const resolved = [];

  for (let i = 0; i <= MAX_BOOTSTRAP_RESOLUTIONS; i++) {
    try {
      // Not `stdio: 'inherit'` here: the bootstrap check below needs the actual
      // output, not just a generic "Command failed" error. Printed manually
      // either way, so CI logs show the same thing they always have.
      const out = execSync('prisma migrate deploy', { env, encoding: 'utf8' });
      process.stdout.write(out);
      if (resolved.length) {
        console.log(
          `migrate: bootstrap resolved ${resolved.length} migration(s) already built by 0000_baseline: ${resolved.join(', ')}`,
        );
      }
      return;
    } catch (err) {
      const output = String(err.stdout ?? '') + String(err.stderr ?? '');
      process.stdout.write(output || String(err.message ?? ''));

      if (!startedEmpty || !supersededByBaseline(output) || i === MAX_BOOTSTRAP_RESOLUTIONS) {
        throw err;
      }

      const name = await stuckMigrationName(url);
      if (!name) throw err;

      console.log(
        `migrate: bootstrap — "${name}" conflicts with 0000_baseline (already built); marking resolved and continuing.`,
      );
      execSync(`prisma migrate resolve --applied ${name}`, { stdio: 'inherit', env });
      resolved.push(name);
    }
  }
}

async function main() {
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

  const startedEmpty = await isEmptyDatabase(url);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await deploy(url, startedEmpty);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
