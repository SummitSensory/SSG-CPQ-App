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
 * Costs are effective-dated: an identical (product, date, cost) is skipped, a
 * changed cost on the same date updates, a new date appends — history survives.
 */
import { PrismaClient } from '@prisma/client';
import seedJson from './seed-catalog.json' with { type: 'json' };
import { loadCatalogSeed, tiersInInsertOrder } from '../src/catalog/workbook-import.js';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const SEED_USER_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@summitsensory.com';

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[™®]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

async function main(): Promise<void> {
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

  // Warnings are grouped — 40 "no cost on record" lines help nobody.
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

  const seedUser = await prisma.user.findUnique({
    where: { email: SEED_USER_EMAIL },
    select: { id: true },
  });
  if (!seedUser) throw new Error(`Seed user ${SEED_USER_EMAIL} not found — run pnpm db:seed first.`);

  // ----- Product lines -----
  const lineIdByName = new Map<string, string>();
  for (const l of data.productLines) {
    const row = await prisma.productLine.upsert({
      where: { slug: l.slug },
      update: {
        name: l.name,
        description: l.description ?? null,
        sortOrder: l.sortOrder,
        isActive: l.isActive,
      },
      create: {
        name: l.name,
        slug: l.slug,
        description: l.description ?? null,
        sortOrder: l.sortOrder,
        isActive: l.isActive,
      },
      select: { id: true },
    });
    lineIdByName.set(l.name, row.id);
  }

  // ----- Manufacturers -----
  const manIdByName = new Map<string, string>();
  for (const m of data.manufacturers) {
    const payload = {
      slug: m.code ?? slugify(m.name),
      isThirdParty: m.isThirdParty,
      defaultLeadTimeDays: m.defaultLeadTimeDays ?? null,
      contactName: m.contact ?? null,
      notes: m.notes ?? null,
      isActive: m.isActive,
    };
    const row = await prisma.manufacturer.upsert({
      where: { name: m.name },
      update: payload,
      create: { name: m.name, ...payload },
      select: { id: true },
    });
    manIdByName.set(m.name, row.id);
  }

  // ----- Products -----
  // Product.categoryId is required, so every product first lands in a per-line
  // "Unfiled" bucket; the tier pass below repoints it at its real section.
  const unfiledByLine = new Map<string, string>();
  for (const [name, productLineId] of lineIdByName) {
    const slug = `unfiled-${slugify(name)}`;
    const cat = await prisma.productCategory.upsert({
      where: { slug },
      update: {},
      create: {
        name: `Unfiled — ${name}`,
        slug,
        productLineId,
        tierLevel: 1,
        sortOrder: 9999,
        isActive: false,
      },
      select: { id: true },
    });
    unfiledByLine.set(name, cat.id);
  }

  const productIdBySku = new Map<string, string>();
  for (const p of data.products) {
    const shared = {
      name: p.name,
      productLineId: lineIdByName.get(p.productLine) ?? null,
      defaultQuantity: p.defaultQuantity,
      badge: p.badge ?? null,
      lengthIn: p.lengthIn ?? null,
      widthIn: p.widthIn ?? null,
      heightIn: p.heightIn ?? null,
      thicknessIn: p.thicknessIn ?? null,
      dimensionsOverride: p.dimensionsOverride ?? null,
      showDimensions: p.showDimensions,
      weightOz: p.weightOz ?? null,
    };
    const row = await prisma.product.upsert({
      where: { sku: p.sku },
      update: shared,
      create: {
        sku: p.sku,
        status: 'ACTIVE',
        categoryId: unfiledByLine.get(p.productLine)!,
        createdById: seedUser.id,
        ...shared,
      },
      select: { id: true },
    });
    productIdBySku.set(p.sku, row.id);
  }

  // ----- Tier tree (parents first, so parentId always resolves) -----
  const tierIdBySlug = new Map<string, string>();
  for (const t of tiersInInsertOrder(data.tiers)) {
    const payload = {
      name: t.name,
      productLineId: lineIdByName.get(t.productLine) ?? null,
      tierLevel: t.tierLevel,
      defaultQuantity: t.defaultQuantity ?? null,
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

  // Point each product's categoryId at the section it sits in.
  for (const t of data.tiers) {
    if (!t.sku || !t.parentSlug) continue;
    const categoryId = tierIdBySlug.get(t.parentSlug);
    if (!categoryId) continue;
    await prisma.product.update({ where: { sku: t.sku }, data: { categoryId } });
  }

  // ----- Notes (replace-on-import: the workbook is authoritative) -----
  for (const sku of new Set(data.notes.map((n) => n.sku))) {
    await prisma.productNote.deleteMany({ where: { productId: productIdBySku.get(sku)! } });
  }
  for (const n of data.notes) {
    await prisma.productNote.create({
      data: { productId: productIdBySku.get(n.sku)!, text: n.text, sortOrder: n.sortOrder },
    });
  }

  // ----- Costs (effective-dated) -----
  let costsInserted = 0;
  for (const c of data.costs) {
    const productId = productIdBySku.get(c.sku)!;
    const effectiveDate = new Date(`${c.effectiveDate}T00:00:00.000Z`);
    const existing = await prisma.productCost.findFirst({ where: { productId, effectiveDate } });
    if (existing) {
      if (existing.unitCost !== BigInt(c.unitCostMinor)) {
        await prisma.productCost.update({
          where: { id: existing.id },
          data: { unitCost: BigInt(c.unitCostMinor) },
        });
      }
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

  // ----- Sourcing -----
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
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
