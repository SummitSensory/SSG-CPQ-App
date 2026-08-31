/**
 * Bring Product.status in line with Sku.active for the "active-mismatch" warning
 * from check-part-integrity.ts: a part shows ACTIVE in the tree while its priced
 * record is inactive.
 *
 * catalogItems.ts already prefers sku.active over Product.status when a Sku
 * exists (`active: sku ? sku.active : product?.status === 'ACTIVE'`), so this
 * never mispriced a quote — it only made the tree/admin screen say something
 * that wasn't true.
 *
 * THE IMPORTANT DECISION: proposal usage is the evidence, not the mismatch alone.
 * -------------------------------------------------------------------------
 * repair-half-created-parts.ts established this pattern for exactly this reason:
 * a service, discount or labor line (SVC-CON-HR, FLEX-PRO-DISCOUNT, and the like)
 * legitimately has no catalog price — the rate is typed on the proposal line —
 * and marking one INACTIVE would pull it out of the part picker even though reps
 * are actively using it correctly today. 142 of the 189 mismatches are entirely
 * one category (Therapeutic Swing & Sensory Equipment Package, a physical-goods
 * package), but the rest are scattered across service/travel/labor categories
 * (Hourly Consulting, Airfare, Mileage, Rental Vehicle...) that are exactly the
 * shape repair-half-created-parts.ts warned about.
 *
 * So: a product only moves to INACTIVE if its Sku is inactive AND no proposal
 * has ever used it. If a proposal HAS used it, the mismatch is left alone and
 * reported separately — that is a human decision (was it genuinely retired
 * after being used, or is it a service line that should stay findable?), not
 * one this script gets to make.
 *
 * DRY RUN BY DEFAULT.
 *
 *   npx tsx --env-file=.env prisma/repair-active-status-mismatch.ts
 *   npx tsx --env-file=.env prisma/repair-active-status-mismatch.ts --commit
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const key = (v: unknown): string => (v == null ? '' : String(v)).trim().toLowerCase();

async function main() {
  const [products, skus, versions] = await Promise.all([
    prisma.product.findMany({
      select: { id: true, sku: true, name: true, status: true },
      orderBy: { sku: 'asc' },
    }),
    prisma.sku.findMany({ select: { part: true, active: true, category: true } }),
    prisma.proposalVersion.findMany({ select: { sections: true, items: true } }),
  ]);

  const skuByPart = new Map(skus.map((s) => [key(s.part), s]));

  /** Same walk as repair-half-created-parts.ts and the integrity reports. */
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

  const mismatched = products.filter((p) => {
    const s = skuByPart.get(key(p.sku));
    return s && p.status === 'ACTIVE' && !s.active;
  });

  console.log('');
  console.log(
    COMMIT ? 'REPAIRING ACTIVE-STATUS MISMATCHES' : 'REPAIRING ACTIVE-STATUS MISMATCHES — DRY RUN',
  );
  console.log('='.repeat(78));
  console.log(`Products: ${products.length}   priced records: ${skus.length}`);
  console.log('');

  if (!mismatched.length) {
    console.log('Nothing to do. No product is ACTIVE with an inactive priced record.');
    console.log('');
    return;
  }

  const safe = mismatched.filter((p) => !partsUsed.has(key(p.sku)));
  const inUse = mismatched.filter((p) => partsUsed.has(key(p.sku)));

  console.log(`${mismatched.length} product(s) are ACTIVE with an inactive priced record.`);
  console.log(`   never used on a proposal — safe to mark INACTIVE : ${safe.length}`);
  console.log(`   used on a proposal — left alone, reported below  : ${inUse.length}`);
  console.log('');

  const byCategory = new Map<string, number>();
  for (const p of safe) {
    const cat = skuByPart.get(key(p.sku))?.category ?? '(none)';
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
  }
  console.log('Safe set, by sku.category:');
  for (const [cat, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(4)}   ${cat}`);
  }
  console.log('');

  if (inUse.length) {
    console.log('Used on a proposal despite the mismatch — needs a human decision, not touched:');
    for (const p of inUse) {
      const cat = skuByPart.get(key(p.sku))?.category ?? '(none)';
      console.log(`   ${p.sku.padEnd(22)} ${cat.padEnd(46)} ${p.name.slice(0, 40)}`);
    }
    console.log('');
  }

  if (!COMMIT) {
    console.log('='.repeat(78));
    console.log('Nothing was changed. Re-run with --commit to apply to the safe set only.');
    console.log('');
    console.log('Verify with: npx tsx --env-file=.env prisma/check-part-integrity.ts');
    console.log('');
    return;
  }

  for (const p of safe) {
    await prisma.product.update({ where: { id: p.id }, data: { status: 'INACTIVE' } });
  }

  console.log('='.repeat(78));
  console.log(`${safe.length} product(s) marked INACTIVE. ${inUse.length} left for manual review.`);
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
