/**
 * Idempotent catalog seed from the completed product workbook.
 *
 * Loads prisma/seed-catalog.json (generated from "Summit Product Workbook v3"),
 * validates it end to end, and upserts by natural key so re-running after a
 * workbook revision updates rather than duplicates.
 *
 *   pnpm db:seed:catalog            # apply
 *   pnpm db:seed:catalog --dry-run  # validate and report only
 *
 * Costs are append-only: a new unit cost for a SKU is inserted as a new
 * effective-dated row; an identical (sku, effectiveDate, unitCost) is skipped.
 */
import { PrismaClient } from '@prisma/client';
import seedJson from './seed-catalog.json' with { type: 'json' };
import { loadCatalogSeed, tiersInInsertOrder } from '../src/catalog/workbook-import.js';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const SEED_USER_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@summitsensory.com';

async function main() {
  const { data, report } = loadCatalogSeed(seedJson);

  console.log('\nCatalog workbook import');
  console.log('  source:', data.source ?? '(unknown)');
  for (const [k, v] of Object.entries(report.counts)) console.log(`  ${k}: ${v}`);

  const errors = report.issues.filter((i) => i.severity === 'error');
  const warnings = report.issues.filter((i) => i.severity === 'warning');

  if (errors.length) {
    console.error(`\n  ${errors.length} ERROR(S) — nothing was written:`);
    for (const e of errors) console.error(`    [${e.sheet}] ${e.key}: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  // Warnings are grouped: 40+ "no cost on record" lines help nobody.
  if (warnings.length) {
    const byMessage = new Map<string, string[]>();
    for (const w of warnings) {
      const list = byMessage.get(w.message) ?? [];
      list.push(w.key);
      byMessage.set(w.message, list);
    }
    console.warn(`\n  ${warnings.length} warning(s):`);
    for (const [msg, keys] of byMessage) {
      const shown = keys.slice(0, 8).join(', ');
      console.warn(`    ${msg} — ${keys.length}: ${shown}${keys.length > 8 ? ', …' : ''}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n  --dry-run: no database writes.\n');
    return;
  }

  const seedUser = await prisma.user.findUnique({ where: { email: SEED_USER_EMAIL }, select: { id: true } });
  if (!seedUser) throw new Error(`Seed user ${SEED_USER_EMAIL} not found — run the base seed first.`);

  const lineIdBySlug = new Map<string, string>();
  const lineIdByName = new Map<string, string>();
  for (const l of data.productLines) {
    const row = await prisma.productLine.upsert({
      where: { slug: l.slug },
      update: { name: l.name, description: l.description ?? null, sortOrder: l.sortOrder, isActive: l.isActive },
      create: { name: l.name, slug: l.slug, description: l.description ?? null, sortOrder: l.sortOrder, isActive: l.isActive },
      select: { id: true },
    });
    lineIdBySlug.set(l.slug, row.id);
    lineIdByName.set(l.name, row.id);
  }

  const manIdByName = new Map<string, string>();
  for (const m of data.manufacturers) {
    const row = await prisma.manufacturer.upsert({
      where: { name: m.name },
      update: { code: m.code ?? null, contact: m.contact ?? null, notes: m.notes ?? null, isActive: m.isActive },
      create: { name: m.name, code: m.code ?? null, contact: m.contact ?? null, notes: m.notes ?? null, isActive: m.isActive },
      select: { id: true },
    });
    manIdByName.set(m.name, row.id);
  }

  // Products need a category FK. Tier placements supply the real one below;
  // until then every product hangs off a per-line "Unfiled" bucket.
  const unfiledByLine = new Map<string, string>();
  for (const [name, lineId] of lineIdByName) {
    const slug = `unfiled-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const cat = await prisma.productCategory.upsert({
      where: { slug },
      update: {},
      create: { name: `Unfiled — ${name}`, slug, productLineId: lineId, tierLevel: 1, sortOrder: 9999, isActive: false },
      select: { id: true },
    });
    unfiledByLine.set(name, cat.id);
  }

  const productIdBySku = new Map<string, string>();
  for (const p of data.products) {
    const row = await prisma.product.upsert({
      where: { sku: p.sku },
      update: {
        name: p.name,
        defaultQuantity: p.defaultQuantity,
        badge: p.badge ?? null,
        lengthIn: p.lengthIn ?? null,
        widthIn: p.widthIn ?? null,
        heightIn: p.heightIn ?? null,
        thicknessIn: p.thicknessIn ?? null,
        weightOz: p.weightOz ?? null,
        showDimensions: p.showDimensions,
        dimensionsOverride: p.dimensionsOverride ?? null,
      },
      create: {
        sku: p.sku,
        name: p.name,
        status: 'ACTIVE',
        categoryId: unfiledByLine.get(p.productLine)!,
        defaultQuantity: p.defaultQuantity,
        badge: p.badge ?? null,
        lengthIn: p.lengthIn ?? null,
        widthIn: p.widthIn ?? null,
        heightIn: p.heightIn ?? null,
        thicknessIn: p.thicknessIn ?? null,
        weightOz: p.weightOz ?? null,
        showDimensions: p.showDimensions,
        dimensionsOverride: p.dimensionsOverride ?? null,
        createdById: seedUser.id,
      },
      select: { id: true },
    });
    productIdBySku.set(p.sku, row.id);
  }

  // Tier nodes, parents first.
  const tierIdBySlug = new Map<string, string>();
  for (const t of tiersInInsertOrder(data.tiers)) {
    const payload = {
      name: t.name,
      productLineId: lineIdByName.get(t.productLine)!,
      tierLevel: t.tierLevel,
      parentId: t.parentSlug ? (tierIdBySlug.get(t.parentSlug) ?? null) : null,
      productId: t.sku ? (productIdBySku.get(t.sku) ?? null) : null,
      sortOrder: t.sortOrder,
      isActive: true,
    };
    const row = await prisma.productCategory.upsert({
      where: { slug: t.slug },
      update: payload,
      create: { slug: t.slug, ...payload },
      select: { id: true },
    });
    tierIdBySlug.set(t.slug, row.id);
  }

  // Point each product's categoryId at its (deepest) tier placement.
  for (const t of data.tiers) {
    if (!t.sku) continue;
    const parentId = t.parentSlug ? tierIdBySlug.get(t.parentSlug) : undefined;
    if (!parentId) continue;
    await prisma.product.update({ where: { sku: t.sku }, data: { categoryId: parentId } });
  }

  // Notes are replace-on-import: the workbook is authoritative.
  for (const sku of new Set(data.notes.map((n) => n.sku))) {
    await prisma.productNote.deleteMany({ where: { productId: productIdBySku.get(sku)! } });
  }
  for (const n of data.notes) {
    await prisma.productNote.create({
      data: { productId: productIdBySku.get(n.sku)!, body: n.body, sortOrder: n.sortOrder, isPublic: n.isPublic },
    });
  }

  let costsInserted = 0;
  for (const c of data.costs) {
    const productId = productIdBySku.get(c.sku)!;
    const effectiveDate = new Date(`${c.effectiveDate}T00:00:00.000Z`);
    const existing = await prisma.productCost.findFirst({ where: { productId, effectiveDate } });
    if (existing) {
      if (existing.unitCost === BigInt(c.unitCostMinor)) continue;
      await prisma.productCost.update({ where: { id: existing.id }, data: { unitCost: BigInt(c.unitCostMinor) } });
      continue;
    }
    await prisma.productCost.create({
      data: {
        productId,
        unitCost: BigInt(c.unitCostMinor),
        currency: c.currency,
        effectiveDate,
        createdById: seedUser.id,
      },
    });
    costsInserted += 1;
  }

  for (const s of data.sourcing) {
    const productId = productIdBySku.get(s.sku)!;
    const manufacturerId = manIdByName.get(s.manufacturer)!;
    const payload = {
      vendorPartNo: s.vendorPartNo ?? null,
      leadTimeDays: s.leadTimeDays ?? null,
      minOrderQty: s.minOrderQty ?? null,
      isPrimary: s.isPrimary,
      notes: s.notes ?? null,
    };
    await prisma.productSourcing.upsert({
      where: { productId_manufacturerId: { productId, manufacturerId } },
      update: payload,
      create: { productId, manufacturerId, ...payload },
    });
  }

  console.log(`\n  Applied. ${costsInserted} new cost row(s).\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
