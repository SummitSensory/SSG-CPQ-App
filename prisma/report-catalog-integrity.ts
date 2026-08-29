/**
 * Vendor-name integrity report.
 *
 * Which parts name a manufacturer that does not exist, and which vendor records exist
 * only because somebody mistyped a name.
 *
 * Why this is needed before the catalog gets a manufacturer dropdown
 * -----------------------------------------------------------------
 * Vendor identity is recorded in two places for every part:
 *
 *   - `Sku.manufacturer`, a plain string, free-typed today, and
 *   - `ProductSourcing` → `Manufacturer.name`, a real relation.
 *
 * Nothing has ever constrained the string. Worse, `PATCH /catalog/items/:part` does
 * this when the typed name matches nothing:
 *
 *     let mfr = await prisma.manufacturer.findFirst({ where: { name } });
 *     if (!mfr) mfr = await prisma.manufacturer.create({ data: { name, slug } });
 *
 * — so a typo does not merely sit in a field. It CREATES a Manufacturer row with no
 * address, no contact, no payment terms and none of the Bill of Materials email
 * defaults, which then appears in the vendor list looking as legitimate as the real
 * ones. The part is sourced from a vendor that does not exist, and the first anyone
 * knows is a purchase order with nowhere to send it.
 *
 * The consequences are already on record in this repo: `src/handoff/vendorResolution.ts`
 * was written because vendor identity lived in two places and only one was being read
 * (freight requests were silently dropped); `prisma/fix-vendor-name.ts` and
 * `prisma/resync-order-vendors.ts` are both repair scripts; and `bomSections.ts` carries
 * an 'Unassigned vendor' fallback for lines the catalog cannot attribute.
 *
 * Turning the field into a dropdown is a small change, but a dropdown cannot represent a
 * value that is not in its list. If an existing part names "Reslite" and the list holds
 * "Resilite", a naive <select> shows the blank option — and the next save writes that
 * blank, converting a visible typo into a missing vendor, silently. So the existing bad
 * values have to be known first, which is what this prints.
 *
 * READ-ONLY. Counts and names; repairs nothing. An orphaned name might be a typo, or a
 * vendor genuinely not yet set up, and only a person can tell which.
 *
 * Run with:
 *   npx tsx --env-file=.env prisma/report-catalog-integrity.ts
 *
 * Optionally add to package.json scripts:
 *   "db:report:vendors": "tsx --env-file=.env prisma/report-catalog-integrity.ts"
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Trimmed and lower-cased — the same key `vendorResolution.ts` matches on. */
const key = (v: unknown): string => (v == null ? '' : String(v)).trim().toLowerCase();

async function main() {
  const [manufacturers, skus, sourcing, products] = await Promise.all([
    prisma.manufacturer.findMany({
      select: {
        id: true,
        name: true,
        isActive: true,
        addressLine1: true,
        contactEmail: true,
        paymentTerms: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.sku.findMany({
      select: { part: true, description: true, manufacturer: true, active: true },
      orderBy: { part: 'asc' },
    }),
    prisma.productSourcing.findMany({
      select: {
        manufacturerId: true,
        product: { select: { sku: true } },
      },
    }),
    prisma.product.findMany({
      select: { sku: true, name: true, status: true, createdAt: true },
      orderBy: { sku: 'asc' },
    }),
  ]);

  const byKey = new Map(manufacturers.map((m) => [key(m.name), m]));

  console.log('');
  console.log('VENDOR-NAME INTEGRITY REPORT');
  console.log('='.repeat(78));
  console.log(`Manufacturers on record : ${manufacturers.length}`);
  console.log(`Sku rows                : ${skus.length}`);
  console.log('');

  /* ---- 1. parts naming a manufacturer that does not exist ---- */

  const orphaned = new Map<string, { name: string; parts: string[] }>();
  let named = 0;
  let blank = 0;
  for (const s of skus) {
    const raw = (s.manufacturer ?? '').trim();
    if (!raw) {
      blank++;
      continue;
    }
    named++;
    if (byKey.has(key(raw))) continue;
    const k = key(raw);
    if (!orphaned.has(k)) orphaned.set(k, { name: raw, parts: [] });
    orphaned.get(k)!.parts.push(s.part);
  }

  console.log('1. PARTS WHOSE MANUFACTURER DOES NOT EXIST');
  console.log('-'.repeat(78));
  console.log(`   Sku rows naming a manufacturer : ${named}`);
  console.log(`   Sku rows naming none           : ${blank}`);
  if (!orphaned.size) {
    console.log('   No orphaned names. Every Sku.manufacturer matches a Manufacturer row.');
  } else {
    const rows = [...orphaned.values()].sort((a, b) => b.parts.length - a.parts.length);
    const affected = rows.reduce((n, r) => n + r.parts.length, 0);
    console.log(`   ORPHANED NAMES: ${rows.length}, across ${affected} parts`);
    console.log('');
    for (const r of rows) {
      // Nearest existing name by a cheap prefix/containment test — enough to make a
      // likely typo obvious without pretending to be a spell-checker.
      const k = key(r.name);
      const near = manufacturers
        .filter((m) => {
          const mk = key(m.name);
          return (
            mk.startsWith(k.slice(0, 4)) ||
            k.startsWith(mk.slice(0, 4)) ||
            mk.includes(k) ||
            k.includes(mk)
          );
        })
        .map((m) => m.name);
      console.log(`   “${r.name}”  — ${r.parts.length} part(s)`);
      const shown = r.parts.slice(0, 12).join(', ');
      const more = r.parts.length > 12 ? ` … +${r.parts.length - 12} more` : '';
      console.log(`      parts : ${shown}${more}`);
      if (near.length) console.log(`      did you mean: ${near.join(', ')}`);
    }
  }
  console.log('');

  /* ---- 2. manufacturer records that look like they were created by a typo ---- */

  const byId = new Map(manufacturers.map((m) => [m.id, m]));
  const usedBySku = new Set(skus.map((s) => key(s.manufacturer)).filter(Boolean));
  const usedBySourcing = new Set(
    sourcing.map((r) => key(byId.get(r.manufacturerId)?.name)).filter(Boolean),
  );

  console.log('2. MANUFACTURER RECORDS WITH NO VENDOR-OF-RECORD DETAIL');
  console.log('-'.repeat(78));
  console.log('   A real vendor has somewhere to send a purchase order. These have none,');
  console.log('   which is what a row created by a mistyped name looks like.');
  console.log('');
  const bare = manufacturers.filter((m) => !m.addressLine1 && !m.contactEmail && !m.paymentTerms);
  if (!bare.length) {
    console.log('   None. Every manufacturer carries at least an address, an email or terms.');
  } else {
    for (const m of bare) {
      const skuUse = usedBySku.has(key(m.name));
      const srcUse = usedBySourcing.has(key(m.name));
      const where = [skuUse && 'Sku', srcUse && 'sourcing'].filter(Boolean).join(' + ');
      const use = where ? `IN USE (${where})` : 'unused';
      console.log(`   ${m.name}${m.isActive ? '' : ' [inactive]'}  — ${use}`);
    }
    console.log('');
    console.log(
      `   ${bare.length} of ${manufacturers.length} manufacturers have no address, email or terms.`,
    );
    console.log('   Unused ones are safe to delete. Ones IN USE need the parts re-pointed first.');
  }
  console.log('');

  /* ---- 3. the two records disagreeing about the same part ---- */

  const sourcedVendor = new Map<string, string>();
  for (const r of sourcing) {
    const m = byId.get(r.manufacturerId);
    if (m && r.product?.sku) sourcedVendor.set(key(r.product.sku), m.name);
  }
  const conflicts: Array<{ part: string; sku: string; sourced: string }> = [];
  for (const s of skus) {
    const raw = (s.manufacturer ?? '').trim();
    const sourced = sourcedVendor.get(key(s.part));
    if (raw && sourced && key(raw) !== key(sourced))
      conflicts.push({ part: s.part, sku: raw, sourced });
  }

  console.log('3. PARTS WHERE THE TWO RECORDS DISAGREE');
  console.log('-'.repeat(78));
  console.log('   Sku.manufacturer says one vendor, ProductSourcing says another. The Bill of');
  console.log('   Materials takes Sku as the override, so the Sku value is what gets ordered');
  console.log('   from — but the catalog screen can show either.');
  console.log('');
  if (!conflicts.length) {
    console.log('   None. Where both records name a vendor, they agree.');
  } else {
    for (const c of conflicts) {
      console.log(`   ${c.part.padEnd(20)} Sku: ${c.sku.padEnd(24)} sourcing: ${c.sourced}`);
    }
    console.log('');
    console.log(`   ${conflicts.length} part(s) disagree.`);
  }

  console.log('');

  /* ---- 4. half-created parts ---- */

  const skuByPart = new Map(skus.map((s) => [key(s.part), s]));
  const productBySku = new Map(products.map((p) => [key(p.sku), p]));
  const productOnly = products.filter((p) => !skuByPart.has(key(p.sku)));
  const skuOnly = skus.filter((s) => !productBySku.has(key(s.part)));

  console.log('4. PARTS THAT EXIST AS ONLY HALF OF THEMSELVES');
  console.log('-'.repeat(78));
  console.log('   A part needs a row in BOTH tables to be complete. Product carries the name,');
  console.log('   category and tree placement; Sku carries the price, cost, weight and');
  console.log('   manufacturer. Neither import path creates both:');
  console.log('');
  console.log('     POST /catalog/import       -> prisma.product.create, nothing else');
  console.log('     POST /catalog/tree/import  -> prisma.product.create (status DRAFT),');
  console.log('                                   and only touches Sku to DEACTIVATE rows');
  console.log('     POST /skus/import          -> Sku rows only, no Product');
  console.log('');
  console.log('   So a product imported through the catalog or the tree workbook has no');
  console.log('   price, no cost and no manufacturer — not because the import failed, but');
  console.log('   because those fields live in a table it never wrote to.');
  console.log('');
  console.log(`   Product rows : ${products.length}`);
  console.log(`   Sku rows     : ${skus.length}`);
  console.log('');
  console.log(`   PRODUCT WITH NO SKU (no price, no cost, no manufacturer): ${productOnly.length}`);
  if (productOnly.length) {
    const draft = productOnly.filter((p) => p.status === 'DRAFT').length;
    console.log(`      of which status DRAFT: ${draft}`);
    // Grouped by import date: a bulk import lands as one cluster, which makes it easy
    // to tell "one bad import" from "years of drift".
    const byDay = new Map<string, number>();
    for (const p of productOnly) {
      const d = p.createdAt.toISOString().slice(0, 10);
      byDay.set(d, (byDay.get(d) ?? 0) + 1);
    }
    const days = [...byDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log('      created on:');
    for (const [d, n] of days) console.log(`         ${d}  ${n} part(s)`);
    console.log('      first 20:');
    for (const p of productOnly.slice(0, 20))
      console.log(`         ${p.sku.padEnd(22)} ${p.name.slice(0, 44)}`);
    if (productOnly.length > 20) console.log(`         … +${productOnly.length - 20} more`);
  }
  console.log('');
  console.log(`   SKU WITH NO PRODUCT (no category, absent from the tree): ${skuOnly.length}`);
  if (skuOnly.length) {
    console.log('      first 20:');
    for (const s of skuOnly.slice(0, 20))
      console.log(`         ${s.part.padEnd(22)} ${(s.description || '').slice(0, 44)}`);
    if (skuOnly.length > 20) console.log(`         … +${skuOnly.length - 20} more`);
  }

  console.log('');
  console.log('='.repeat(78));
  console.log('Nothing was changed. Send the output back and both the dropdown and the');
  console.log('repair can be built to cope with exactly what is here.');
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
