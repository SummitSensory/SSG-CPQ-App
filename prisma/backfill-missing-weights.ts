/**
 * Default every missing catalog weight to zero.
 *
 * 277 products carry no weight on record. Left null they read as "unknown",
 * which made the builder flag lines, understate the shipment total in an
 * unpredictable way, and send a missing-weight count to monday with every
 * freight request. Zero is the decision: a blank weight now means 0 lb, the
 * warnings go away, and a real weight can still be typed in later.
 *
 * Idempotent — only null rows are selected, so a second run finds nothing.
 *
 * Run with:  pnpm db:backfill:weights
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const missing = await prisma.product.count({ where: { weightOz: null } });
  console.log(`Products with no weight on record: ${missing}`);

  const { count } = await prisma.product.updateMany({
    where: { weightOz: null },
    data: { weightOz: 0 },
  });
  console.log(`Set weightOz = 0 on ${count} product${count === 1 ? '' : 's'}.`);

  // Sku.weightLbs is non-null with a 0 default, so nothing to backfill there —
  // reported only so the run shows how much of the catalog still weighs nothing.
  const zeroSkus = await prisma.sku.count({ where: { weightLbs: 0 } });
  const totalSkus = await prisma.sku.count();
  console.log(`SKUs at 0 lb: ${zeroSkus} of ${totalSkus}.`);

  const left = await prisma.product.count({ where: { weightOz: null } });
  console.log(left === 0 ? 'Done. No product is missing a weight.' : `WARNING: ${left} still null.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
