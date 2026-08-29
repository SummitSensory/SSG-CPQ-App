/**
 * Make the primary sourcing row agree with the vendor a part is actually ordered from.
 *
 * WHAT THIS SCRIPT USED TO DO, AND WHY IT WAS WRONG
 * ------------------------------------------------
 * The first version treated `ProductSourcing` as one vendor per part and tried to
 * reassign the row's `manufacturerId` from the stale vendor to the one on
 * `Sku.manufacturer`. It failed on `@@unique([productId, manufacturerId])` — because both
 * rows already existed.
 *
 * That constraint is the model telling you something: `ProductSourcing` is a
 * MANY-TO-MANY with an `isPrimary` flag. A part legitimately lists several vendors, one
 * preferred. The tracking-rail hardware lists both Goldberg Brothers and Productive Tool
 * Products, which is what a second source is for. There was no disagreement to repair;
 * the check had collapsed a list to a single value and compared against whichever row the
 * database happened to return last.
 *
 * So the useful job is narrower and safer: make the vendor on `Sku.manufacturer` — the
 * one the Bill of Materials orders from — the SOLE primary among a part's existing
 * sources. Nothing is created, nothing is deleted, no vendor association changes. Only
 * which of a part's existing sources is preferred.
 *
 * "Sole" matters. `isPrimary` is `@default(true)`, so a part with two sources usually has
 * both flagged, and an earlier version of this script checked only whether the right one
 * was primary — found that it was, and reported nothing to do while the integrity check
 * went on flagging the same seven parts.
 *
 * A part whose `Sku.manufacturer` is not a listed source at all is REPORTED, not fixed.
 * Adding a vendor to a part is a purchasing decision, and after getting this model wrong
 * twice I am not going to make it in a loop.
 *
 * DRY RUN BY DEFAULT.
 *
 *   npx tsx --env-file=.env prisma/align-vendor-sourcing.ts
 *   npx tsx --env-file=.env prisma/align-vendor-sourcing.ts --commit
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const key = (v: unknown): string => (v == null ? '' : String(v)).trim().toLowerCase();

async function main() {
  const [skus, sourcing] = await Promise.all([
    prisma.sku.findMany({ select: { part: true, manufacturer: true } }),
    prisma.productSourcing.findMany({
      select: {
        id: true,
        isPrimary: true,
        manufacturer: { select: { name: true } },
        product: { select: { id: true, sku: true } },
      },
    }),
  ]);

  const skuByPart = new Map(skus.map((s) => [key(s.part), s]));

  /** Every sourcing row for a part, so the primary flag can be judged in context. */
  const rowsByPart = new Map<string, typeof sourcing>();
  for (const r of sourcing) {
    if (!r.product?.sku) continue;
    const k = key(r.product.sku);
    if (!rowsByPart.has(k)) rowsByPart.set(k, []);
    rowsByPart.get(k)!.push(r);
  }

  interface Repromote {
    part: string;
    to: string;
    toId: string;
    from: string | null;
    demote: { id: string; name: string }[];
  }
  const repromote: Repromote[] = [];
  const notSourced: { part: string; named: string; listed: string[] }[] = [];

  for (const [k, rows] of rowsByPart) {
    const sku = skuByPart.get(k);
    const named = (sku?.manufacturer ?? '').trim();
    if (!named) continue;

    const match = rows.find((r) => key(r.manufacturer?.name) === key(named));
    if (!match) {
      notSourced.push({
        part: rows[0]!.product!.sku,
        named,
        listed: rows.map((r) => r.manufacturer?.name ?? '?'),
      });
      continue;
    }
    /*
     * Not "is the match primary" — "is the match the ONLY primary".
     *
     * `isPrimary` is `@default(true)`, so a part with two sources typically has BOTH
     * flagged. The previous version checked `match.isPrimary` and skipped, which is why
     * it reported nothing to do while the check was still flagging seven parts: Goldberg
     * Brothers was primary, and so was Productive Tool Products.
     */
    const primaries = rows.filter((r) => r.isPrimary);
    const alreadySolePrimary = primaries.length === 1 && primaries[0]!.id === match.id;
    if (alreadySolePrimary) continue;

    repromote.push({
      part: rows[0]!.product!.sku,
      to: match.manufacturer?.name ?? named,
      toId: match.id,
      from:
        primaries.length > 1
          ? `${primaries.length} rows flagged primary`
          : (primaries[0]?.manufacturer?.name ?? null),
      demote: primaries
        .filter((r) => r.id !== match.id)
        .map((r) => ({ id: r.id, name: r.manufacturer?.name ?? '?' })),
    });
  }

  console.log('');
  console.log(COMMIT ? 'ALIGNING PRIMARY SOURCE' : 'ALIGNING PRIMARY SOURCE — DRY RUN');
  console.log('='.repeat(78));
  console.log('A part can list several vendors, one marked primary. Where the vendor the');
  console.log('Bill of Materials orders from is listed but not primary, mark it primary.');
  console.log('No vendor association is added, removed or changed.');
  console.log('');

  if (!repromote.length) {
    console.log('Nothing to change. Every part is already primary-sourced from the vendor');
    console.log('its priced record names.');
  } else {
    console.log(`${repromote.length} part(s) to re-flag:`);
    console.log('');
    for (const r of repromote) {
      console.log(`   ${r.part.padEnd(20)} primary: ${r.from ?? '(none)'}  ->  ${r.to}`);
    }
  }
  console.log('');

  if (notSourced.length) {
    console.log(`REPORTED, NOT CHANGED — ${notSourced.length} part(s):`);
    console.log('   Ordered from a vendor that is not among the part\u2019s listed sources.');
    console.log('   Adding a vendor to a part is a purchasing decision, so this asks rather');
    console.log('   than acts. Add the source on the product, or correct the priced record.');
    console.log('');
    for (const n of notSourced) {
      const listed = n.listed.join(', ');
      console.log(`   ${n.part.padEnd(20)} orders from “${n.named}”; listed: ${listed}`);
    }
    console.log('');
  }

  if (!COMMIT) {
    console.log('='.repeat(78));
    console.log('Nothing was changed. Re-run with --commit to apply.');
    console.log('');
    return;
  }

  let done = 0;
  for (const r of repromote) {
    // Demote first, so the pair never both hold isPrimary — cheap here, and it keeps the
    // intermediate state honest if the run is interrupted.
    for (const d of r.demote) {
      await prisma.productSourcing.update({
        where: { id: d.id },
        data: { isPrimary: false },
      });
    }
    await prisma.productSourcing.update({
      where: { id: r.toId },
      data: { isPrimary: true },
    });
    done++;
  }

  console.log('='.repeat(78));
  console.log(`${done} part(s) re-flagged.`);
  console.log('Verify with: pnpm db:check:integrity');
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
