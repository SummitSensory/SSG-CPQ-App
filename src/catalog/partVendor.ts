/**
 * A part's vendor, written to both records that hold it.
 *
 * A part's vendor lives in two places:
 *
 *   Sku.manufacturer      — a string. What the Bill of Materials reads as the override,
 *                           so it is what you actually order against.
 *   ProductSourcing       — a relation to Manufacturer. What the vendor reports, the
 *                           freight true-up and `vendorResolution.ts` read.
 *
 * Four code paths write a part's vendor, and two of them used to write only the string:
 * the product-tree workbook import and the SKU CSV import. That is how seven parts ended
 * up naming `Goldberg Brothers` on one record and `Productive Tool Products` on the other,
 * with the purchase order following one and the catalog screen showing the other.
 *
 * Rather than trust four call sites to remember, they all come through here.
 *
 * Why this is a helper and not Prisma middleware
 * ----------------------------------------------
 * Middleware on `sku.update` would catch every path automatically, including ones not
 * written yet — but it would make writing a Sku silently write a second table, which is
 * unpleasant to debug a year later and invisible at the call site. And it still would not
 * cover a raw SQL fix, a migration, or someone editing the database by hand.
 *
 * So the write path is explicit, and the GUARANTEE comes from
 * `src/catalog/partIntegrity.ts`: any drift, from any source including the three
 * middleware could never see, fails `pnpm check` and the test suite.
 */
import type { PrismaClient } from '@prisma/client';

const key = (v: unknown): string => (v == null ? '' : String(v)).trim().toLowerCase();

export interface Vendor {
  id: string;
  name: string;
}

/**
 * Every manufacturer on record, by lower-cased name.
 *
 * Loaded once per import rather than queried per row: a 3,000-row sheet would otherwise
 * make 3,000 lookups for a handful of distinct vendors.
 *
 * Inactive vendors are INCLUDED. This index answers "does this vendor exist", not "should
 * it be offered" — a part legitimately sourced from a vendor you have stopped buying from
 * must not be reported as a bad name.
 */
export async function loadVendorIndex(prisma: PrismaClient): Promise<Map<string, Vendor>> {
  const rows = await prisma.manufacturer.findMany({ select: { id: true, name: true } });
  return new Map(rows.map((m) => [key(m.name), { id: m.id, name: m.name }]));
}

/**
 * Resolve a typed name to a vendor on record, or null.
 *
 * Case-insensitive, and the STORED spelling is what comes back — so `resilite` files a
 * part under `Resilite` instead of creating a second spelling of one company.
 */
export function resolveVendor(
  index: Map<string, Vendor>,
  name: string | null | undefined,
): Vendor | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  return index.get(key(n)) ?? null;
}

/**
 * Make `ProductSourcing` agree with the vendor just written to `Sku.manufacturer`.
 *
 * A no-op when the part has no `Product` row — a priced record with no catalog record has
 * nowhere to hang a sourcing link, and that is a separate defect the integrity check
 * reports rather than something to paper over here.
 *
 * `vendor: null` removes the link, which is the correct reading of "this part has no
 * vendor" and matches what `PATCH /catalog/items/:part` does.
 */
export async function syncPartSourcing(
  prisma: PrismaClient,
  part: string,
  vendor: Vendor | null,
): Promise<'linked' | 'relinked' | 'cleared' | 'no-product' | 'unchanged'> {
  const product = await prisma.product.findUnique({
    where: { sku: part },
    select: { id: true },
  });
  if (!product) return 'no-product';

  const existing = await prisma.productSourcing.findFirst({
    where: { productId: product.id },
    select: { id: true, manufacturerId: true },
  });

  if (!vendor) {
    if (!existing) return 'unchanged';
    await prisma.productSourcing.deleteMany({ where: { productId: product.id } });
    return 'cleared';
  }
  if (!existing) {
    await prisma.productSourcing.create({
      data: { productId: product.id, manufacturerId: vendor.id },
    });
    return 'linked';
  }
  if (existing.manufacturerId === vendor.id) return 'unchanged';
  await prisma.productSourcing.update({
    where: { id: existing.id },
    data: { manufacturerId: vendor.id },
  });
  return 'relinked';
}
