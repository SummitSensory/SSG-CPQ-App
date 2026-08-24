import { PrismaClient } from '@prisma/client';

/**
 * Carry a corrected vendor name onto orders that were locked under the old one.
 *
 * An accepted order stores its vendor as a NAME, not a reference — the snapshot is
 * what keeps a sheet sent months ago honest. Renaming the manufacturer therefore does
 * not reach the orders already in flight, and until this runs those orders keep
 * printing the old spelling.
 *
 * Renaming a manufacturer from now on carries itself (routes/manufacturers.ts). This
 * script is for the strings that were already written.
 *
 *   pnpm tsx --env-file=.env prisma/fix-vendor-name.ts "Mazello" "Mazzella"
 *   pnpm tsx --env-file=.env prisma/fix-vendor-name.ts "Mazello" "Mazzella" --apply
 *
 * Without --apply it only reports what it would touch.
 */

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const [from, to] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const apply = process.argv.includes('--apply');

  if (!from || !to) {
    console.error('Usage: fix-vendor-name.ts "<old name>" "<new name>" [--apply]');
    process.exit(1);
  }

  const manufacturer = await prisma.manufacturer.findFirst({
    where: { name: { equals: to, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!manufacturer) {
    console.error(
      `No manufacturer is named "${to}". Fix the spelling in Administration first, then run this.`,
    );
    process.exit(1);
  }

  const [lines, freeIssue, sections, skus] = await Promise.all([
    prisma.procurementLine.count({ where: { vendor: from } }),
    prisma.procurementLine.count({ where: { purchaseVendor: from } }),
    prisma.bomVendorSection.findMany({
      where: { vendor: from },
      select: { id: true, orderId: true },
    }),
    prisma.sku.count({ where: { manufacturer: from } }),
  ]);

  // A section is unique per (order, vendor). Where an order somehow already has one
  // under the correct name, the old section is left alone — it carries its own
  // questions, answers and send history, and discarding that silently is worse than a
  // duplicate name to sort out by hand.
  const clashing = new Set(
    (
      await prisma.bomVendorSection.findMany({
        where: { vendor: manufacturer.name, orderId: { in: sections.map((s) => s.orderId) } },
        select: { orderId: true },
      })
    ).map((s) => s.orderId),
  );
  const renameable = sections.filter((s) => !clashing.has(s.orderId));

  console.log(`"${from}" -> "${manufacturer.name}"`);
  console.log(`  order lines            ${lines}`);
  console.log(`  free-issue source      ${freeIssue}`);
  console.log(
    `  BOM sections           ${renameable.length}${clashing.size ? ` (${clashing.size} left alone — the order already has a section under the new name)` : ''}`,
  );
  console.log(`  catalog SKUs           ${skus}`);

  if (!apply) {
    console.log('\nNothing written. Re-run with --apply to make these changes.');
    return;
  }

  await prisma.$transaction([
    prisma.procurementLine.updateMany({
      where: { vendor: from },
      data: { vendor: manufacturer.name },
    }),
    prisma.procurementLine.updateMany({
      where: { purchaseVendor: from },
      data: { purchaseVendor: manufacturer.name },
    }),
    prisma.sku.updateMany({
      where: { manufacturer: from },
      data: { manufacturer: manufacturer.name },
    }),
    ...renameable.map((s) =>
      prisma.bomVendorSection.update({ where: { id: s.id }, data: { vendor: manufacturer.name } }),
    ),
  ]);

  console.log('\nDone. Reload the order page to see it.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
