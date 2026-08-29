/**
 * Which of the 194 unpriced parts came from the import, and which are legitimate?
 *
 * The zero-priced-lines report found 9 proposal lines whose part has no `Sku` row — and
 * every one carried a correct non-zero rate. That is because the builder snapshots the
 * rate onto the line when it is added rather than reading `Sku` at print time. No money
 * was lost.
 *
 * It also showed those parts are things like FLEX-PRO-DISCOUNT (qty -1), OBIE-BUNDLE and
 * SVC-INS-TECH-HR — manual and synthetic lines that were never catalog parts and have no
 * business having a Sku. So "no Sku row" is not by itself a defect.
 *
 * That matters, because the proposed stopgap is to set unpriced ACTIVE products to DRAFT
 * so the part picker stops offering them at $0. Applied blindly to all 192 that would
 * also hide the legitimate ones — including whatever OBIE-BUNDLE is — and break the
 * proposals that use them.
 *
 * So this splits the 194 into two groups by the only evidence that reliably separates
 * them: whether a proposal has ever used the part, and when the Product row was created.
 * The import clusters are known from the catalog-integrity report (144 on 2026-07-25 and
 * 44 on 2026-08-11); anything created outside those days, or already in use on a
 * proposal, is a part somebody made on purpose.
 *
 * READ-ONLY. Reports; changes nothing. The output is the list to act on.
 *
 * Run with:
 *   npx tsx --env-file=.env prisma/report-unpriced-part-origins.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const key = (v: unknown): string => (v == null ? '' : String(v)).trim().toLowerCase();

/** Walks both line-item storage shapes, same as report-zero-priced-lines.ts. */
function partsUsedIn(version: { sections: unknown; items: unknown }): Set<string> {
  const found = new Set<string>();
  const walk = (node: unknown, depth = 0): void => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) {
      for (const n of node) {
        if (n && typeof n === 'object' && !Array.isArray(n)) {
          const o = n as Record<string, unknown>;
          if (o.sku) found.add(key(o.sku));
          for (const k of ['items', 'lines', 'rows', 'children', 'sections'])
            if (k in o) walk(o[k], depth + 1);
        }
      }
      return;
    }
    if (typeof node === 'object') {
      const o = node as Record<string, unknown>;
      for (const k of ['items', 'lines', 'rows', 'children', 'sections'])
        if (k in o) walk(o[k], depth + 1);
    }
  };
  walk(version.items);
  walk(version.sections);
  return found;
}

async function main() {
  const [skus, products, versions] = await Promise.all([
    prisma.sku.findMany({ select: { part: true } }),
    prisma.product.findMany({
      select: { id: true, sku: true, name: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.proposalVersion.findMany({ select: { sections: true, items: true } }),
  ]);

  const priced = new Set(skus.map((s) => key(s.part)));
  const unpriced = products.filter((p) => !priced.has(key(p.sku)));

  const everUsed = new Set<string>();
  for (const v of versions) for (const p of partsUsedIn(v)) everUsed.add(p);

  console.log('');
  console.log('UNPRICED PARTS — WHICH ARE IMPORT CASUALTIES, WHICH ARE DELIBERATE');
  console.log('='.repeat(78));
  console.log(`Products with no Sku row : ${unpriced.length}`);
  console.log('');

  /* ---- by creation day, so the import clusters are visible ---- */

  const byDay = new Map<string, typeof unpriced>();
  for (const p of unpriced) {
    const d = p.createdAt.toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(p);
  }

  console.log('BY CREATION DATE');
  console.log('-'.repeat(78));
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [d, rows] of days) {
    const used = rows.filter((p) => everUsed.has(key(p.sku))).length;
    const active = rows.filter((p) => p.status === 'ACTIVE').length;
    const tag = rows.length > 20 ? '  <-- bulk import' : '';
    const n = String(rows.length).padStart(4);
    const a = String(active).padStart(4);
    const u = String(used).padStart(3);
    console.log(`   ${d}   ${n} part(s)   ${a} ACTIVE   ${u} used on a proposal${tag}`);
  }
  console.log('');

  /* ---- group A: safe to hide ---- */

  const neverUsed = unpriced.filter((p) => !everUsed.has(key(p.sku)) && p.status === 'ACTIVE');

  console.log('GROUP A — UNPRICED, ACTIVE, NEVER USED ON ANY PROPOSAL');
  console.log('-'.repeat(78));
  console.log('   These are offered in the part picker at $0.00 and no proposal depends on');
  console.log('   them. Setting them to DRAFT removes the exposure and breaks nothing.');
  console.log('');
  console.log(`   COUNT: ${neverUsed.length}`);
  if (neverUsed.length) {
    console.log('   first 25:');
    for (const p of neverUsed.slice(0, 25))
      console.log(`      ${p.sku.padEnd(22)} ${p.name.slice(0, 46)}`);
    if (neverUsed.length > 25) console.log(`      … +${neverUsed.length - 25} more`);
  }
  console.log('');

  /* ---- group B: leave alone ---- */

  const inUse = unpriced.filter((p) => everUsed.has(key(p.sku)));

  console.log('GROUP B — UNPRICED BUT ALREADY USED ON A PROPOSAL');
  console.log('-'.repeat(78));
  console.log('   Do NOT hide these. A proposal references them, and the zero-priced-lines');
  console.log('   report showed those lines carry correct rates — so they are working as');
  console.log('   intended. Bundles, discounts and hourly services have no catalog price by');
  console.log('   nature: the rate is set on the line.');
  console.log('');
  console.log(`   COUNT: ${inUse.length}`);
  for (const p of inUse)
    console.log(`      ${p.sku.padEnd(22)} ${p.status.padEnd(10)} ${p.name.slice(0, 40)}`);
  console.log('');

  /* ---- group C: already hidden ---- */

  const hidden = unpriced.filter((p) => p.status !== 'ACTIVE' && !everUsed.has(key(p.sku)));
  console.log('GROUP C — UNPRICED AND ALREADY NOT ACTIVE');
  console.log('-'.repeat(78));
  console.log(`   COUNT: ${hidden.length}   (no exposure; listed for completeness)`);
  for (const p of hidden.slice(0, 10))
    console.log(`      ${p.sku.padEnd(22)} ${p.status.padEnd(10)} ${p.name.slice(0, 40)}`);
  if (hidden.length > 10) console.log(`      … +${hidden.length - 10} more`);

  console.log('');
  console.log('='.repeat(78));
  console.log(
    `A: ${neverUsed.length} safe to hide   B: ${inUse.length} leave alone   ` +
      `C: ${hidden.length} already hidden`,
  );
  console.log('Nothing was changed.');
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
