/**
 * Align ProductSourcing with Sku.manufacturer where the two disagree.
 *
 * The integrity report found 7 parts where the two vendor records name different
 * companies — the tracking-rail hardware says `Goldberg Brothers` on `Sku` and
 * `Productive Tool Products` on `ProductSourcing`.
 *
 * Which one is right
 * ------------------
 * `Sku.manufacturer` is. Three independent reasons, none of them a guess:
 *
 *  1. The Bill of Materials already reads `Sku` as the override, so `Goldberg Brothers`
 *     is who these parts are ALREADY being ordered from. Whatever the intent once was,
 *     that is the operating reality, and changing it would change purchasing behaviour
 *     rather than correct a record.
 *
 *  2. `Goldberg Brothers` is one of the manufacturers carrying a full address, contact
 *     and payment terms. `Productive Tool Products` is one of the nine with none of
 *     those — the signature of a row created as a side effect of a typed name rather
 *     than set up as a vendor.
 *
 *  3. `ProductSourcing` is the record nothing reads at ordering time, so it is the one
 *     that goes stale unnoticed.
 *
 * So this makes the quiet record agree with the one that is actually in force. It changes
 * nothing about who you buy from, which is exactly why it is safe: it removes a
 * disagreement instead of picking a new winner.
 *
 * DRY RUN BY DEFAULT. It prints what it would do and exits. Pass --commit to write.
 *
 *   npx tsx --env-file=.env prisma/align-vendor-sourcing.ts
 *   npx tsx --env-file=.env prisma/align-vendor-sourcing.ts --commit
 *
 * Anything it cannot resolve safely it skips and reports, rather than guessing — a part
 * whose `Sku.manufacturer` names a vendor that does not exist is left alone, because
 * creating that vendor is the very mistake this whole thread has been about.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const key = (v: unknown): string => (v == null ? '' : String(v)).trim().toLowerCase();

async function main() {
  const [skus, manufacturers, sourcing] = await Promise.all([
    prisma.sku.findMany({ select: { part: true, manufacturer: true } }),
    prisma.manufacturer.findMany({
      select: {
        id: true,
        name: true,
        addressLine1: true,
        contactEmail: true,
        paymentTerms: true,
      },
    }),
    prisma.productSourcing.findMany({
      select: {
        id: true,
        manufacturerId: true,
        product: { select: { id: true, sku: true } },
      },
    }),
  ]);

  const mfrByName = new Map(manufacturers.map((m) => [key(m.name), m]));
  const mfrById = new Map(manufacturers.map((m) => [m.id, m]));
  const skuByPart = new Map(skus.map((s) => [key(s.part), s]));

  interface Row {
    part: string;
    from: string;
    to: string;
    sourcingId: string;
    toId: string;
    fromBare: boolean;
  }
  const fix: Row[] = [];
  const skipped: { part: string; why: string }[] = [];

  for (const row of sourcing) {
    if (!row.product?.sku) continue;
    const sku = skuByPart.get(key(row.product.sku));
    if (!sku) continue;
    const want = (sku.manufacturer ?? '').trim();
    if (!want) continue;

    const current = mfrById.get(row.manufacturerId);
    if (current && key(current.name) === key(want)) continue;

    const target = mfrByName.get(key(want));
    if (!target) {
      // Left alone on purpose. Creating the vendor here would be the exact mistake the
      // rest of this work removed.
      skipped.push({
        part: row.product.sku,
        why: `Sku says “${want}”, which is not a manufacturer on record`,
      });
      continue;
    }
    const from = current?.name ?? '(none)';
    const bare =
      !!current && !current.addressLine1 && !current.contactEmail && !current.paymentTerms;
    fix.push({
      part: row.product.sku,
      from,
      to: target.name,
      sourcingId: row.id,
      toId: target.id,
      fromBare: bare,
    });
  }

  console.log('');
  console.log(COMMIT ? 'ALIGNING VENDOR SOURCING' : 'ALIGNING VENDOR SOURCING — DRY RUN');
  console.log('='.repeat(78));
  console.log('Making the quiet record (ProductSourcing) agree with the one the Bill of');
  console.log('Materials already reads (Sku.manufacturer). Purchasing behaviour does not');
  console.log('change; only the record that nothing reads at ordering time.');
  console.log('');

  if (!fix.length) {
    console.log('Nothing to align. Every ProductSourcing row already agrees with its Sku.');
  } else {
    console.log(`${fix.length} part(s) to align:`);
    console.log('');
    for (const f of fix) {
      const note = f.fromBare ? '   [old vendor has no address/terms]' : '';
      console.log(`   ${f.part.padEnd(20)} ${f.from}  ->  ${f.to}${note}`);
    }
  }
  console.log('');

  if (skipped.length) {
    console.log('SKIPPED — not resolvable without creating a vendor:');
    for (const s of skipped) console.log(`   ${s.part.padEnd(20)} ${s.why}`);
    console.log('');
    console.log('   Add those vendors under Catalog → Manufacturers, with their address');
    console.log('   and payment terms, then run this again.');
    console.log('');
  }

  if (!COMMIT) {
    console.log('='.repeat(78));
    console.log('Nothing was changed. Re-run with --commit to apply.');
    console.log('');
    return;
  }

  let done = 0;
  for (const f of fix) {
    await prisma.productSourcing.update({
      where: { id: f.sourcingId },
      data: { manufacturerId: f.toId },
    });
    done++;
  }

  console.log('='.repeat(78));
  console.log(`${done} sourcing row(s) updated.`);
  console.log('Re-run prisma/report-catalog-integrity.ts — section 3 should now be empty.');
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
