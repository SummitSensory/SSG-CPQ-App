/**
 * Set packaging bag numbers from prisma/packaging-bags.csv.
 *
 * Two columns, header included:
 *
 *   part,bag
 *   6820H-LQ,Bag 1
 *   6820H-LR,Bag 1
 *   TRH2005,Bag 4
 *
 * A blank bag clears the label. A part that is not in the catalog is reported
 * and skipped — nothing is created, so a typo cannot invent a SKU. Re-running
 * is safe: rows that already match are counted as unchanged.
 *
 *   pnpm db:bags            # apply
 *   pnpm db:bags --dry-run  # report only
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const FILE = new URL('./packaging-bags.csv', import.meta.url);

/** Minimal CSV read: two columns, optional quotes, blank lines ignored. */
function parse(text: string): Array<{ part: string; bag: string }> {
  const rows: Array<{ part: string; bag: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [];
    const [a, b] = cells.map((c) =>
      c.replace(/,$/, '').trim().replace(/^"|"$/g, '').replace(/""/g, '"'),
    );
    if (!a) continue;
    if (/^part$/i.test(a)) continue; // header
    rows.push({ part: a, bag: (b ?? '').trim() });
  }
  return rows;
}

async function main() {
  const rows = parse(readFileSync(FILE, 'utf8'));
  if (!rows.length) {
    console.log('packaging-bags.csv has no rows. Nothing to do.');
    return;
  }

  const existing = await prisma.sku.findMany({
    where: { part: { in: rows.map((r) => r.part) } },
    select: { part: true, packagingBag: true },
  });
  const bagByPart = new Map(existing.map((s) => [s.part, s.packagingBag ?? '']));

  const unknown = rows.filter((r) => !bagByPart.has(r.part));
  const changed = rows.filter((r) => bagByPart.has(r.part) && bagByPart.get(r.part) !== r.bag);
  const same = rows.length - unknown.length - changed.length;

  console.log(
    `\n${rows.length} row(s): ${changed.length} to change, ${same} already correct, ${unknown.length} not in the catalog.`,
  );
  for (const r of changed) {
    console.log(
      `  ${r.part.padEnd(16)} ${(bagByPart.get(r.part) || '—').padEnd(12)} →  ${r.bag || '(cleared)'}`,
    );
  }
  for (const u of unknown) console.warn(`  ${u.part}: no such part — skipped`);

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing written.\n');
    return;
  }

  for (const r of changed) {
    await prisma.sku.update({ where: { part: r.part }, data: { packagingBag: r.bag || null } });
  }
  console.log(`\nApplied. ${changed.length} part(s) updated.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
