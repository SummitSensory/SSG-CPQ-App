#!/usr/bin/env node
/**
 * How much data do the reporting endpoints actually read?
 *
 * AUD-005 says three reporting paths read whole tables with no pagination, and that
 * this is fine now and will not be at 5x the data. "Fine now" and "5x" are both
 * guesses until somebody counts, so this counts: row totals, the real size of the
 * proposal JSON that buildDataset() pulls into memory, and how long the read takes
 * against the live database.
 *
 * Read-only. Nothing is written, nothing is modified.
 *
 *   node scripts/report-volumes.mjs
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Same .env fallback as the other scripts: real env vars win, file is the backup. */
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
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    if (process.env.DIRECT_URL || process.env.DATABASE_URL) return;
  }
}

loadDotEnv();
const prisma = new PrismaClient();

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

async function main() {
  console.log('');
  console.log('Row counts');
  console.log('----------');
  const counts = {
    proposals: await prisma.proposal.count(),
    'proposals (not archived)': await prisma.proposal.count({ where: { archivedAt: null } }),
    proposalVersions: await prisma.proposalVersion.count(),
    acceptedOrders: await prisma.acceptedOrder.count(),
    procurementLines: await prisma.procurementLine.count(),
    qboTransactions: await prisma.qboTransaction.count(),
    qboPayments: await prisma.qboPayment.count(),
    organizations: await prisma.organization.count(),
    skus: await prisma.sku.count(),
  };
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(26)} ${String(v).padStart(7)}`);
  }

  console.log('');
  console.log('What buildDataset() pulls into memory');
  console.log('-------------------------------------');
  const started = Date.now();
  const rows = await prisma.proposalVersion.findMany({
    select: { id: true, proposalId: true, version: true, items: true, sections: true },
  });
  const readMs = Date.now() - started;

  let total = 0;
  let biggest = { id: '', bytes: 0 };
  for (const r of rows) {
    const bytes = Buffer.byteLength(JSON.stringify({ items: r.items, sections: r.sections }));
    total += bytes;
    if (bytes > biggest.bytes) biggest = { id: `${r.proposalId} v${r.version}`, bytes };
  }

  console.log(`  versions read              ${String(rows.length).padStart(7)}`);
  console.log(`  total JSON                 ${mb(total).padStart(10)}`);
  console.log(
    `  average per version        ${kb(rows.length ? total / rows.length : 0).padStart(10)}`,
  );
  console.log(`  largest single version     ${kb(biggest.bytes).padStart(10)}  (${biggest.id})`);
  console.log(`  read time                  ${String(readMs).padStart(7)} ms`);

  console.log('');
  console.log('Verdict');
  console.log('-------');
  // The function budget is 30s (vercel.json). The read is only part of that: shaping,
  // aggregating and serialising follow, and a cold Neon compute adds a second or two.
  const projected5x = readMs * 5;
  console.log(`  read at 5x today's data    ~${projected5x} ms (linear projection)`);
  if (total > 40 * 1024 * 1024) {
    console.log('  MEMORY: over 40 MB of JSON in one function invocation — narrow the read now.');
  } else if (projected5x > 8000) {
    console.log('  SLOW: 5x would put the read alone near a third of the 30s budget.');
  } else {
    console.log('  Comfortable. Re-run this when proposal count roughly doubles.');
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
