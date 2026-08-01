/**
 * Price P-2513 (Summit Flex: Trolley Rail Rear Bracket) at $61.50.
 *
 * The part came in from the Flex worksheet with a $20.00 cost and an empty
 * price cell, so it quoted at $0.00 inside the Universal Conversion Kit. This
 * writes the price into the Sku row the builder quotes from, and creates that
 * row if the part only ever existed as a catalog Product.
 *
 * Idempotent — a price already at 6150 is left alone, and an operator's later
 * edit is never overwritten by a re-run.
 *
 * Run with:  pnpm db:price:p2513
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PART = 'P-2513';
const PRICE_MINOR = 6150;

async function main() {
  const existing = await prisma.sku.findUnique({ where: { part: PART } });

  if (existing?.unitPriceMinor) {
    console.log(`${PART} already priced at $${(existing.unitPriceMinor / 100).toFixed(2)} — left alone.`);
    return;
  }

  const product = await prisma.product.findUnique({
    where: { sku: PART },
    select: { id: true, name: true, weightOz: true },
  });
  const cost = product
    ? await prisma.productCost.findFirst({
        where: { productId: product.id },
        orderBy: { effectiveDate: 'desc' },
        select: { unitCost: true },
      })
    : null;

  const row = await prisma.sku.upsert({
    where: { part: PART },
    update: { unitPriceMinor: PRICE_MINOR },
    create: {
      part: PART,
      description: product?.name ?? 'Summit Flex: Trolley Rail Rear Bracket',
      unitPriceMinor: PRICE_MINOR,
      unitCostMinor: cost ? Number(cost.unitCost) : 2000,
      weightLbs: product?.weightOz ? Math.round((product.weightOz / 16) * 1000) / 1000 : 5,
      category: 'FLEX_HARDWARE',
      active: true,
    },
  });

  console.log(`${PART} priced at $${(row.unitPriceMinor / 100).toFixed(2)} (cost $${(row.unitCostMinor / 100).toFixed(2)}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
