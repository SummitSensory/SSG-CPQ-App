/**
 * Idempotent Summit Soar catalog seed.
 *
 * Loads prisma/seed-soar.json (generated from "Soar Builder SKUs & Logic.xlsx",
 * Products tab) and writes it to BOTH catalog surfaces, because they hold different
 * halves of the truth:
 *
 *   Product / ProductCategory  — the 4-level product tree, dimensions, weight
 *   ProductCost                — effective-dated COGS
 *   ProductSourcing            — which manufacturer supplies each SKU
 *   Sku                        — the proposal-side price list the builder quotes from
 *
 * Product has no price column, so a catalog-only import leaves the Soar builder
 * quoting zero. That is why this seeder exists alongside seed-catalog.ts.
 *
 *   pnpm db:seed:soar            # apply
 *   pnpm db:seed:soar --dry-run  # validate and report only
 */
import { PrismaClient } from '@prisma/client';
import seedJson from './seed-soar.json' with { type: 'json' };
import { loadCatalogSeed, tiersInInsertOrder } from '../src/catalog/workbook-import.js';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const SEED_USER_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@summitsensory.com';

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[™®]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** Frames are K-40xx; everything else in this line is padding. */
const skuCategory = (sku: string): string => (/^K-40/.test(sku) ? 'SOAR_FRAME' : 'SOAR_PADDING');

async function main(): Promise<void> {
  const { data, report } = loadCatalogSeed(seedJson);

  console.log('\nSummit Soar catalog import');
  console.log('  source:', data.source ?? '(unknown)');
  for (const [k, v] of Object.entries(report.counts)) console.log(`  ${k}: ${v}`);

  const errors = report.issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    console.error(`\n  ${errors.length} ERROR(S) — nothing was written:`);
    for (const e of errors) console.error(`    [${e.sheet}] ${e.key}: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const warnings = report.issues.filter((i) => i.severity === 'warning');
  if (warnings.length) {
    console.warn(`\n  ${warnings.length} warning(s):`);
    for (const w of warnings) console.warn(`    [${w.sheet}] ${w.key}: ${w.message}`);
  }

  if (DRY_RUN) {
    console.log('\n  --dry-run: no database writes.\n');
    return;
  }

  const seedUser = await prisma.user.findUnique({ where: { email: SEED_USER_EMAIL }, select: { id: true } });
  if (!seedUser) throw new Error(`Seed user ${SEED_USER_EMAIL} not found — run pnpm db:seed first.`);

  const lineIdByName = new Map<string, string>();
  for (const l of data.productLines) {
    const payload = { name: l.name, description: l.description ?? null, sortOrder: l.sortOrder, isActive: l.isActive };
    const row = await prisma.productLine.upsert({
      where: { slug: l.slug }, update: payload, create: { slug: l.slug, ...payload }, select: { id: true },
    });
    lineIdByName.set(l.name, row.id);
  }

  const manIdByName = new Map<string, string>();
  for (const m of data.manufacturers) {
    const payload = {
      slug: m.code ?? slugify(m.name), isThirdParty: m.isThirdParty,
      defaultLeadTimeDays: m.defaultLeadTimeDays ?? null, contactName: m.contact ?? null,
      notes: m.notes ?? null, isActive: m.isActive,
    };
    const row = await prisma.manufacturer.upsert({
      where: { name: m.name }, update: payload, create: { name: m.name, ...payload }, select: { id: true },
    });
    manIdByName.set(m.name, row.id);
  }

  // Product.categoryId is required, so products land in a per-line "Unfiled" bucket
  // first; the tier pass below repoints each one at its real section.
  const unfiledByLine = new Map<string, string>();
  for (const [name, productLineId] of lineIdByName) {
    const slug = `unfiled-${slugify(name)}`;
    const cat = await prisma.productCategory.upsert({
      where: { slug }, update: {},
      create: { name: `Unfiled — ${name}`, slug, productLineId, tierLevel: 1, sortOrder: 9999, isActive: false },
      select: { id: true },
    });
    unfiledByLine.set(name, cat.id);
  }

  const productIdBySku = new Map<string, string>();
  for (const p of data.products) {
    const shared = {
      name: p.name, productLineId: lineIdByName.get(p.productLine) ?? null,
      defaultQuantity: p.defaultQuantity, badge: p.badge ?? null,
      lengthIn: p.lengthIn ?? null, widthIn: p.widthIn ?? null, heightIn: p.heightIn ?? null,
      thicknessIn: p.thicknessIn ?? null, dimensionsOverride: p.dimensionsOverride ?? null,
      showDimensions: p.showDimensions, weightOz: p.weightOz ?? null,
    };
    const row = await prisma.product.upsert({
      where: { sku: p.sku }, update: shared,
      create: { sku: p.sku, status: 'ACTIVE', categoryId: unfiledByLine.get(p.productLine)!, createdById: seedUser.id, ...shared },
      select: { id: true },
    });
    productIdBySku.set(p.sku, row.id);
  }

  const tierIdBySlug = new Map<string, string>();
  for (const t of tiersInInsertOrder(data.tiers)) {
    const payload = {
      name: t.name, productLineId: lineIdByName.get(t.productLine) ?? null, tierLevel: t.tierLevel,
      parentId: t.parentSlug ? (tierIdBySlug.get(t.parentSlug) ?? null) : null,
      productId: t.sku ? (productIdBySku.get(t.sku) ?? null) : null,
      sortOrder: t.sortOrder, isActive: true,
    };
    const row = await prisma.productCategory.upsert({
      where: { slug: t.slug }, update: payload, create: { slug: t.slug, ...payload }, select: { id: true },
    });
    tierIdBySlug.set(t.slug, row.id);
  }
  for (const t of data.tiers) {
    if (!t.sku || !t.parentSlug) continue;
    const categoryId = tierIdBySlug.get(t.parentSlug);
    if (categoryId) await prisma.product.update({ where: { sku: t.sku }, data: { categoryId } });
  }

  let costsInserted = 0;
  for (const c of data.costs) {
    const productId = productIdBySku.get(c.sku)!;
    const effectiveDate = new Date(`${c.effectiveDate}T00:00:00.000Z`);
    const existing = await prisma.productCost.findFirst({ where: { productId, effectiveDate } });
    if (existing) {
      if (existing.unitCost !== BigInt(c.unitCostMinor)) {
        await prisma.productCost.update({ where: { id: existing.id }, data: { unitCost: BigInt(c.unitCostMinor) } });
      }
      continue;
    }
    await prisma.productCost.create({
      data: { productId, unitCost: BigInt(c.unitCostMinor), currency: c.currency, effectiveDate, createdById: seedUser.id },
    });
    costsInserted += 1;
  }

  for (const s of data.sourcing) {
    const productId = productIdBySku.get(s.sku)!;
    const manufacturerId = manIdByName.get(s.manufacturer)!;
    const payload = {
      vendorPartNo: s.vendorPartNo ?? null, leadTimeDays: s.leadTimeDays ?? null,
      minOrderQty: s.minOrderQty ?? null, isPrimary: s.isPrimary, notes: s.notes ?? null,
    };
    await prisma.productSourcing.upsert({
      where: { productId_manufacturerId: { productId, manufacturerId } }, update: payload,
      create: { productId, manufacturerId, ...payload },
    });
  }

  // ----- Sku: the price list the proposal builder actually quotes from -----
  const costBySku = new Map<string, number>();
  for (const c of data.costs) {
    const prev = costBySku.get(c.sku);
    if (prev == null) costBySku.set(c.sku, c.unitCostMinor);
  }
  const manBySku = new Map<string, string>();
  for (const s of data.sourcing) if (s.isPrimary) manBySku.set(s.sku, s.manufacturer);

  let skusWritten = 0;
  let skusKept = 0;
  for (const p of data.products) {
    if (p.unitPriceMinor == null) {
      console.warn(`    ${p.sku}: no unit price — skipped in the Sku price list`);
      continue;
    }
    // Shared parts (the tracking-rail hardware sits in both Adventure Series and
    // Summit Flex) must keep the price already in the catalog. A workbook re-import
    // is allowed to describe a part, never to re-price one that is already selling.
    const current = await prisma.sku.findUnique({
      where: { part: p.sku },
      select: { unitPriceMinor: true, unitCostMinor: true, weightLbs: true },
    });
    const seedCost = costBySku.get(p.sku) ?? 0;
    const seedWeight = p.weightOz ? p.weightOz / 16 : 0;
    if (current && (current.unitPriceMinor !== p.unitPriceMinor || (current.unitCostMinor && current.unitCostMinor !== seedCost))) {
      console.log(`    ${p.sku}: kept catalog price ${(current.unitPriceMinor / 100).toFixed(2)} / cost ${(current.unitCostMinor / 100).toFixed(2)} (workbook said ${(p.unitPriceMinor / 100).toFixed(2)} / ${(seedCost / 100).toFixed(2)})`);
      skusKept += 1;
    }
    const payload = {
      description: p.name,
      // Catalog wins on money and weight; the workbook only fills a blank.
      unitPriceMinor: current ? current.unitPriceMinor : p.unitPriceMinor,
      unitCostMinor: current && current.unitCostMinor ? current.unitCostMinor : seedCost,
      weightLbs: current && current.weightLbs ? current.weightLbs : seedWeight,
      category: skuCategory(p.sku),
      manufacturer: manBySku.get(p.sku) ?? null,
      // The workbook's Default Qty drives the builder's pre-filled quantity.
      defaultQty: p.defaultQuantity,
      active: true,
    };
    await prisma.sku.upsert({ where: { part: p.sku }, update: payload, create: { part: p.sku, ...payload } });
    skusWritten += 1;
  }

  console.log(`\n  Applied. ${costsInserted} new cost row(s), ${skusWritten} SKU price row(s), ${skusKept} left at the catalog price.\n`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
