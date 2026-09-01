#!/usr/bin/env node
/**
 * Write the next migration, from the difference between the database and the schema.
 *
 * The workflow this replaces: edit prisma/schema.prisma, then hand-write DDL into a
 * numbered folder from memory, hoping it matches what Prisma will expect. That has
 * worked for seventy-two migrations and it is one typo away from schema drift that
 * nothing catches until a screen 500s.
 *
 * What this does instead:
 *
 *   1. Asks Prisma for the exact SQL that would bring the database up to the schema
 *      file — the same diff `migrate dev` would generate, without the shadow database
 *      this repo cannot use.
 *   2. Writes it to prisma/migrations/<next-number>_<name>/migration.sql, with a
 *      header in the house style.
 *   3. Prints the two commands that apply it and record it.
 *
 * It does NOT touch the database. Nothing is applied until you run what it prints,
 * so you get to read the SQL first — which is the point.
 *
 *   pnpm db:new reporting_and_goals
 *
 * Guarding: Prisma's output is not idempotent (plain CREATE TABLE, ADD COLUMN). The
 * house convention is guarded SQL, because migrate-deploy.mjs runs on every deploy
 * and a half-applied migration must be repairable by running it again. `--guard`
 * rewrites the common statements into their IF NOT EXISTS forms. It is deliberately
 * conservative: anything it does not recognise is left alone and flagged in a comment
 * for you to guard by hand.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const repoRoot = repo;
const migrationsDir = join(repo, 'prisma', 'migrations');

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

const args = process.argv.slice(2).filter((a) => a !== '--guard');
const guard = process.argv.includes('--guard');
const rawName = args[0];

if (!rawName) {
  console.error('Usage: pnpm db:new <name> [--guard]');
  console.error('   e.g. pnpm db:new customer_tags');
  process.exit(1);
}

const name = rawName
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_|_$/g, '');

/** The next number in sequence, from the folders that already exist. */
function nextNumber() {
  const nums = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => Number((e.name.match(/^(\d+)_/) ?? [])[1]))
    .filter((n) => Number.isFinite(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return String(max + 1).padStart(4, '0');
}

/**
 * Rewrite Prisma's plain DDL into the guarded forms this repo uses.
 *
 * Only the four statement shapes that make up the overwhelming majority of real
 * migrations here. Everything else passes through untouched and gets a comment, so
 * an unguarded statement is visible rather than silently shipped.
 */
function guardSql(sql) {
  const unguarded = [];
  const out = sql
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (/^CREATE TABLE "/.test(t))
        return line.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ');
      if (/^CREATE (UNIQUE )?INDEX "/.test(t)) {
        return line.replace(/^(\s*CREATE (?:UNIQUE )?INDEX )/, '$1IF NOT EXISTS ');
      }
      if (/^ALTER TABLE ".*" ADD COLUMN /.test(t)) {
        return line.replace(' ADD COLUMN ', ' ADD COLUMN IF NOT EXISTS ');
      }
      if (/^CREATE TYPE "/.test(t)) {
        const type = (t.match(/^CREATE TYPE "([^"]+)"/) ?? [])[1];
        return [
          'DO $$',
          'BEGIN',
          `  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${type}') THEN`,
          `  ${line.trim()}`,
          '  END IF;',
          'END $$;',
        ].join('\n');
      }
      if (/^(ALTER TABLE|DROP|CREATE)/.test(t)) unguarded.push(t.slice(0, 90));
      return line;
    })
    .join('\n');

  if (!unguarded.length) return out;
  return (
    out +
    '\n\n-- NOT GUARDED — make these safe to re-run before deploying:\n' +
    unguarded.map((u) => `--   ${u}`).join('\n') +
    '\n'
  );
}

function main() {
  loadDotEnv();
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('No DATABASE_URL or DIRECT_URL, and no .env file with one.');
    console.error('Run this from the repo root, or set DIRECT_URL in the environment.');
    process.exit(1);
  }

  let sql;
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
        cwd: repo,
        encoding: 'utf8',
        // npx is a .cmd on Windows; execFileSync cannot launch it without a shell.
        shell: process.platform === 'win32',
        env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    console.error('Could not diff the schema against the database.');
    console.error(String(err.stderr || err.message || err).trim());
    process.exit(1);
  }

  const meaningful = sql
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('--'))
    .join('\n')
    .trim();

  if (!meaningful) {
    console.log('Nothing to do — the database already matches prisma/schema.prisma.');
    console.log('Edit prisma/schema.prisma first, then run this again.');
    return;
  }

  const number = nextNumber();
  const folder = join(migrationsDir, `${number}_${name}`);
  const file = join(folder, 'migration.sql');
  if (existsSync(file)) {
    console.error(`${file} already exists. Pick another name.`);
    process.exit(1);
  }

  const body = guard ? guardSql(sql) : sql;
  const header = [
    `-- ${number}_${name}`,
    '--',
    '-- Generated from the difference between prisma/schema.prisma and the database.',
    '-- Read it before applying: this file is the record of what changed and why, so',
    '-- replace this line with a sentence explaining the change in business terms.',
    '--',
    guard
      ? '-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on'
      : '-- NOT GUARDED. migrate-deploy.mjs runs on every deploy and a half-applied',
    guard
      ? '-- every deploy and a half-applied migration must be repairable by running it again.'
      : '-- migration must be repairable by running it again — consider --guard.',
    '',
    '',
  ].join('\n');

  mkdirSync(folder, { recursive: true });
  writeFileSync(file, header + body.trimEnd() + '\n', 'utf8');

  console.log(`Wrote prisma/migrations/${number}_${name}/migration.sql`);
  console.log('');
  console.log('Read it, write the header sentence, then apply and record it:');
  console.log('');
  console.log(
    `  npx prisma db execute --file prisma/migrations/${number}_${name}/migration.sql --schema prisma/schema.prisma`,
  );
  console.log(`  npx prisma migrate resolve --applied ${number}_${name}`);
  console.log('  npx prisma generate');
  console.log('  node scripts/schema-drift-check.mjs');
  console.log('');
  console.log('The last command should report no drift. If it does not, the migration');
  console.log('did not do what the schema expects — fix it before committing.');
}

main();
