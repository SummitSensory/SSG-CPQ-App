/**
 * Give the half-created parts their missing priced record.
 *
 * 194 products have no `Sku` row, because three of the four ways to create a part write
 * only one half:
 *
 *   POST /catalog/import       -> prisma.product.create, nothing else
 *   POST /catalog/tree/import  -> prisma.product.create, and only touches Sku to
 *                                 DEACTIVATE rows
 *   POST /skus, /skus/import   -> Sku rows only, no Product
 *
 * `POST /catalog/items` writes both, and is now what the New part form uses. This script
 * is for the parts created before that existed.
 *
 * THE IMPORTANT DECISION: `active: false`
 * --------------------------------------
 * The new priced records are created INACTIVE, with a price of zero.
 *
 * A price of zero is not a guess about what the part costs — it is the honest statement
 * that nobody has told the system yet. And an inactive priced record is what stops that
 * zero reaching a customer: `GET /catalog/items` currently reports a Sku-less Product as
 * `unitPriceMinor: 0, active: true`, which is exactly why 192 ACTIVE parts sit in the
 * proposal builder's part picker at $0.00 today. Creating the record inactive removes
 * them from the picker in the same stroke as completing them.
 *
 * So this script does two things at once: it makes every part whole, and it closes the
 * $0.00 exposure — without touching the `Product` rows, so nothing disappears from the
 * catalog list or the tree, which was the complaint that started this.
 *
 * Setting a real price is what makes a part quotable again, and the tree workbook is the
 * bulk way to do it: export, fill the price columns, re-import. The importer keeps them
 * in step from now on.
 *
 * What it inherits, and why
 * -------------------------
 *   description  <- Product.name          (the same part, so the same name)
 *   category     <- Product's category    (the flat string the proposal engine groups by,
 *                                          seeded from the tree so the two agree from
 *                                          the outset rather than drifting from day one)
 *   manufacturer <- ProductSourcing       (already recorded; not inventing a vendor)
 *
 * DRY RUN BY DEFAULT.
 *
 *   npx tsx --env-file=.env prisma/repair-half-created-parts.ts
 *   npx tsx --env-file=.env prisma/repair-half-created-parts.ts --commit
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const key = (v: unknown): string => (v == null ? '' : String(v)).trim().toLowerCase();

async function main() {
  const [products, skus, sourcing, categories, versions] = await Promise.all([
    prisma.product.findMany({
      select: { id: true, sku: true, name: true, status: true, categoryId: true, createdAt: true },
      orderBy: { sku: 'asc' },
    }),
    prisma.sku.findMany({ select: { part: true } }),
    prisma.productSourcing.findMany({
      select: { product: { select: { sku: true } }, manufacturer: { select: { name: true } } },
    }),
    prisma.productCategory.findMany({ select: { id: true, name: true } }),
    // Which parts a proposal has actually used. This is the evidence that separates an
    // import casualty from a working line — see the note on `active` below.
    prisma.proposalVersion.findMany({ select: { sections: true, items: true } }),
  ]);

  const priced = new Set(skus.map((s) => key(s.part)));
  const catById = new Map(categories.map((c) => [c.id, c.name]));
  const vendorByPart = new Map<string, string>();
  for (const r of sourcing) {
    if (r.product?.sku && r.manufacturer?.name) {
      vendorByPart.set(key(r.product.sku), r.manufacturer.name);
    }
  }

  /** Walks both line-item storage shapes, same as the integrity reports. */
  const partsUsed = new Set<string>();
  const walk = (node: unknown, depth = 0): void => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) {
      for (const n of node) {
        if (n && typeof n === 'object' && !Array.isArray(n)) {
          const o = n as Record<string, unknown>;
          if (o.sku) partsUsed.add(key(o.sku));
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
  for (const v of versions) {
    walk(v.items);
    walk(v.sections);
  }

  const todo = products.filter((p) => !priced.has(key(p.sku)));

  console.log('');
  console.log(COMMIT ? 'COMPLETING HALF-CREATED PARTS' : 'COMPLETING HALF-CREATED PARTS — DRY RUN');
  console.log('='.repeat(78));
  console.log(`Products: ${products.length}   priced records: ${skus.length}`);
  console.log('');

  if (!todo.length) {
    console.log('Nothing to do. Every product already has a priced record.');
    console.log('');
    return;
  }

  const active = todo.filter((p) => p.status === 'ACTIVE');
  const withVendor = todo.filter((p) => vendorByPart.has(key(p.sku)));

  const inUse = todo.filter((p) => partsUsed.has(key(p.sku)));
  console.log(`${todo.length} product(s) have no priced record.`);
  console.log(`   ACTIVE (selectable at $0.00 today) : ${active.length}`);
  console.log(`   with a vendor already on record    : ${withVendor.length}`);
  console.log(`   already used on a proposal         : ${inUse.length}`);
  console.log('');
  console.log('Each gets a priced record at $0.00. Product rows are not touched, so nothing');
  console.log('leaves the catalog list or the tree.');
  console.log('');
  console.log('INACTIVE for the import casualties — which completes the part and removes it');
  console.log('from the proposal builder at $0.00 in one move.');
  console.log('');
  if (inUse.length) {
    console.log('ACTIVE for these, because a proposal has already used them with a correct');
    console.log('rate typed on the line. A discount, an hourly service or a bundle has no');
    console.log('catalog price by nature, and hiding it would stop reps adding it:');
    for (const p of inUse) console.log(`   ${p.sku.padEnd(22)} ${p.name.slice(0, 46)}`);
    console.log('');
  }

  const byDay = new Map<string, number>();
  for (const p of todo) {
    const d = p.createdAt.toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  console.log('By creation date:');
  for (const [d, n] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`   ${d}   ${String(n).padStart(4)} part(s)${n > 20 ? '   <-- bulk import' : ''}`);
  }
  console.log('');
  console.log('First 20:');
  for (const p of todo.slice(0, 20)) {
    const cat = p.categoryId ? (catById.get(p.categoryId) ?? '') : '';
    const mfr = vendorByPart.get(key(p.sku)) ?? '';
    console.log(`   ${p.sku.padEnd(20)} ${(cat || '(no section)').padEnd(24)} ${mfr}`);
  }
  if (todo.length > 20) console.log(`   … +${todo.length - 20} more`);
  console.log('');

  if (!COMMIT) {
    console.log('='.repeat(78));
    console.log('Nothing was changed. Re-run with --commit to apply.');
    console.log('');
    console.log('Afterwards: export the tree workbook, fill in the price columns, re-import.');
    console.log('A part with a real price and active: true is quotable again.');
    console.log('');
    return;
  }

  let made = 0,
    keptActive = 0;
  for (const p of todo) {
    const usedOnAProposal = partsUsed.has(key(p.sku));
    if (usedOnAProposal) keptActive++;
    await prisma.sku.create({
      data: {
        part: p.sku,
        description: p.name,
        category: (p.categoryId ? catById.get(p.categoryId) : '') ?? '',
        manufacturer: vendorByPart.get(key(p.sku)) ?? null,
        unitPriceMinor: 0,
        unitCostMinor: 0,
        weightLbs: 0,
        /*
         * INACTIVE for an import casualty, ACTIVE for a part a proposal has used.
         *
         * The blanket `false` this replaces would have broken working lines. Four of the
         * 194 are not import casualties at all: FLEX-PRO-DISCOUNT, SVC-CON-HR,
         * SVC-DES-SITE, SVC-INS-TECH-HR and the like — a discount at quantity -1, hourly
         * labour, a bundle. They have no catalog price BY NATURE, because the rate is
         * typed on the line, and a proposal has already used them successfully with a
         * correct rate.
         *
         * Making those inactive would pull them out of the part picker, so a rep could no
         * longer add a discount or an hour of installation to a new proposal. That is a
         * regression dressed as a repair.
         *
         * "Has a proposal used it" is the evidence, not the part number's shape: a name
         * pattern like SVC-* would have missed 8EMCC (Cocoon Swing, a real product quoted
         * at $327) and would break the day somebody names a service differently.
         */
        active: usedOnAProposal,
      },
    });
    made++;
  }

  console.log('='.repeat(78));
  console.log(
    `${made} priced record(s) created at $0.00 — ${keptActive} active, ` +
      `${made - keptActive} inactive.`,
  );
  console.log('');
  console.log('The $0.00 exposure in the proposal builder is closed. Next: export the tree');
  console.log('workbook, fill in the price columns, re-import, and set them active.');
  console.log('');
  console.log('Verify with: npx tsx --env-file=.env prisma/check-part-integrity.ts');
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
