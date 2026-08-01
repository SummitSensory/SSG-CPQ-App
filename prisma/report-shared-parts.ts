/**
 * Shared-part price report.
 *
 * The tracking-rail hardware (TRH2005, TRN2016, TRT2001, TR2000-A07, P-2513…)
 * hangs in the tree under both Adventure Series and Summit Flex. There is one
 * product row and one Sku row per part, so there is only ever one price — this
 * report prints it, so "which price is current?" has a written answer and the
 * next workbook import can be checked against it.
 *
 * Read-only. Run with:  pnpm db:report:shared-parts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const money = (m: number | null | undefined): string => (m == null ? '—' : `$${(m / 100).toFixed(2)}`);

async function main() {
  const tiers = await prisma.productCategory.findMany({
    where: { productId: { not: null } },
    select: {
      name: true,
      productId: true,
      productLine: { select: { name: true } },
      product: { select: { sku: true, name: true } },
    },
  });

  const byProduct = new Map<string, { sku: string; name: string; lines: Set<string>; places: string[] }>();
  for (const t of tiers) {
    if (!t.product) continue;
    const e = byProduct.get(t.productId!) ?? { sku: t.product.sku, name: t.product.name, lines: new Set<string>(), places: [] };
    if (t.productLine?.name) e.lines.add(t.productLine.name);
    e.places.push(t.name);
    byProduct.set(t.productId!, e);
  }

  const shared = [...byProduct.values()].filter((e) => e.lines.size > 1).sort((a, b) => a.sku.localeCompare(b.sku));
  if (!shared.length) {
    console.log('No part sits in more than one product line.');
    return;
  }

  const skus = await prisma.sku.findMany({
    where: { part: { in: shared.map((s) => s.sku) } },
    select: { part: true, unitPriceMinor: true, unitCostMinor: true, weightLbs: true },
  });
  const bySku = new Map(skus.map((s) => [s.part, s]));

  console.log(`\n${shared.length} part(s) shared across product lines — catalog price is the one in force:\n`);
  const needsPrice: string[] = [];
  for (const s of shared) {
    const k = bySku.get(s.sku);
    if (!k || !k.unitPriceMinor) needsPrice.push(s.sku);
    console.log(`  ${s.sku.padEnd(14)} ${money(k?.unitPriceMinor)} price / ${money(k?.unitCostMinor)} cost / ${Number(k?.weightLbs ?? 0).toFixed(2)} lb`);
    console.log(`  ${''.padEnd(14)} ${s.name}`);
    console.log(`  ${''.padEnd(14)} lines: ${[...s.lines].join(', ')}\n`);
  }

  if (needsPrice.length) {
    console.log(`Quoting at $0 until a price is set: ${needsPrice.join(', ')}`);
    console.log('Set it in Catalog → item detail; every line that uses the part picks it up.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
