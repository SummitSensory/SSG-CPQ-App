#!/usr/bin/env node
/**
 * Does the database still match prisma/schema.prisma?
 *
 * This repo cannot use `prisma migrate dev` — the shadow database replays history
 * from the start and fails at 0001_init, because 0000_baseline already created the
 * same types. Migrations are therefore hand-written (see docs/database-migrations.md),
 * and hand-written SQL can disagree with the schema file. Nothing used to check.
 *
 * That disagreement is the dangerous part, not the messy history. A column declared
 * in schema.prisma but missing from the database does not fail at build time; it
 * fails at runtime, as a 500 from whichever screen touches it, possibly weeks later
 * and possibly for one customer.
 *
 * So: ask Prisma to diff the LIVE database against the schema file. Empty diff means
 * they agree. Anything else is printed as the exact SQL that would be needed to
 * reconcile them, which is also the SQL your missing migration should contain.
 *
 *   node scripts/schema-drift-check.mjs          report, exit 1 on drift
 *   node scripts/schema-drift-check.mjs --warn   report, always exit 0
 *
 * Uses the DIRECT (unpooled) connection for the same reason migrate-deploy.mjs does.
 * Skipped when there is no database URL, so a laptop offline or a build without
 * database access does not fail on this.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const warnOnly = process.argv.includes('--warn');

/**
 * Read .env when the connection string is not already in the environment.
 *
 * The other db scripts get it from `tsx --env-file=.env`; plain node does not, and
 * hard-coding `node --env-file=.env` into the package script breaks the Vercel build,
 * where the variables are real environment variables and no .env file exists. So:
 * use what is in the environment, and fall back to the file only if it is there.
 */
function loadDotEnv() {
  if (process.env.DIRECT_URL || process.env.DATABASE_URL) return;
  for (const name of ['.env.local', '.env']) {
    const path = join(repoRoot, name);
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line
        .slice(0, eq)
        .trim()
        .replace(/^export\s+/, '');
      let value = line.slice(eq + 1).trim();
      // Quoted values may legitimately contain '#', so only strip a comment from
      // unquoted ones — a Neon URL with a query string must survive intact.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else {
        const hash = value.indexOf(' #');
        if (hash !== -1) value = value.slice(0, hash).trim();
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    if (process.env.DIRECT_URL || process.env.DATABASE_URL) return;
  }
}

function main() {
  loadDotEnv();
  const direct = process.env.DIRECT_URL;
  const pooled = process.env.DATABASE_URL;
  const url = direct ?? pooled;

  if (!url) {
    console.log('drift: no DATABASE_URL or DIRECT_URL — skipping.');
    return;
  }

  let sql = '';
  try {
    sql = execFileSync(
      'npx',
      [
        'prisma',
        'migrate',
        'diff',
        '--from-schema-datasource',
        'prisma/schema.prisma',
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--script',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    // Could not reach the database, or Prisma itself failed. Not drift — say so
    // rather than reporting a clean result we did not establish.
    console.error('drift: could not compare schema to database.');
    console.error(String(err.stderr || err.message || err).trim());
    process.exit(warnOnly ? 0 : 1);
  }

  // Prisma prints this comment and nothing else when the two already agree.
  const meaningful = sql
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('--'))
    .join('\n')
    .trim();

  if (!meaningful) {
    console.log('drift: none — the database matches prisma/schema.prisma.');
    return;
  }

  console.error('');
  console.error('drift: the database does NOT match prisma/schema.prisma.');
  console.error('');
  console.error('The SQL below is what it would take to bring the database in line.');
  console.error('That is also, almost always, the migration that was never written.');
  console.error('');
  console.error('  1. Put it in a new migration:  pnpm db:new <name>');
  console.error('  2. Apply it:                   see the commands that command prints');
  console.error('');
  console.error('If instead the SCHEMA is the thing that is wrong, fix schema.prisma.');
  console.error('Do not resolve this by editing an already-applied migration — Prisma');
  console.error('stores a checksum per migration and will refuse to deploy after that.');
  console.error('');
  console.error('---------------------------------------------------------------');
  console.error(sql.trim());
  console.error('---------------------------------------------------------------');
  console.error('');

  process.exit(warnOnly ? 0 : 1);
}

main();
