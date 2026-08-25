import { prisma } from '../lib/prisma.js';

/**
 * Which vendor supplies a SKU.
 *
 * This exists because the answer lived in two places and only one of them was
 * being read.
 *
 * A part on a proposal can be described by either of two catalog tables:
 *
 *   - `Sku`, which carries `manufacturer` as a plain string, and
 *   - `Product`, which has no manufacturer column at all — its vendor comes
 *     through the `ProductSourcing` join to `Manufacturer.name`.
 *
 * `bomBuild.ts` reads both, which is why a Bill of Materials groups every line
 * correctly. The freight modules read only `Sku`, so any part whose vendor is
 * recorded through `ProductSourcing` resolved to nothing — and the caller's
 * `if (!vendor) continue` then dropped the line without saying so. The visible
 * symptom is a Freight Requests rail listing four items when the proposal has
 * dozens, across several vendors.
 *
 * One resolver, used by the RFQ builder, the coverage report and RFQ creation, so
 * the three cannot disagree about who supplies what.
 *
 * Precedence matches `bomBuild.ts`: Product is the floor, Sku overrides it
 * wherever it carries a name. Same inputs, same answer, in both places.
 */

const s = (v: unknown): string => (v == null ? '' : String(v));

/** Trimmed, lower-cased. The map key, so lookups survive stray whitespace. */
export const skuKey = (v: unknown): string => s(v).trim().toLowerCase();

export interface VendorResolution {
  /** skuKey(part) → vendor name, as it appears on Manufacturer.name. */
  vendorBySku: Map<string, string>;
  /**
   * SKUs that matched no catalog row in either table, or matched one that names
   * no vendor. Deliberately reported rather than dropped: a part nobody can
   * attribute to a vendor is exactly the part that silently misses its freight
   * request, and the rep needs to see it. Original spelling, de-duplicated.
   */
  unresolved: string[];
}

/**
 * Resolve vendors for a set of SKUs.
 *
 * Matching is case-insensitive.
 *
 * It was exact on the trimmed value, on the reasoning that a case mismatch is a data
 * problem worth surfacing. In practice it surfaced as "no supplier is recorded" against
 * parts whose supplier is plainly recorded — the operator checks the catalog, finds the
 * manufacturer sitting there, and stops trusting the screen. A part number differing
 * only in case is the same part in every other respect, and `Sku.part` and
 * `Product.sku` are unique, so there is no ambiguity to resolve.
 */
export async function resolveVendors(rawSkus: string[]): Promise<VendorResolution> {
  const wanted = new Map<string, string>(); // key → original spelling
  for (const raw of rawSkus) {
    const k = skuKey(raw);
    if (k && !wanted.has(k)) wanted.set(k, s(raw).trim());
  }
  if (!wanted.size) return { vendorBySku: new Map(), unresolved: [] };

  const parts = [...wanted.values()];

  // `mode: 'insensitive'` needs one clause per value; the alternative is a table scan.
  // The list here is the parts on one proposal, so this stays small.
  const [skus, products] = await Promise.all([
    prisma.sku.findMany({
      where: { OR: parts.map((p) => ({ part: { equals: p, mode: 'insensitive' as const } })) },
      select: { part: true, manufacturer: true },
    }),
    prisma.product.findMany({
      where: { OR: parts.map((p) => ({ sku: { equals: p, mode: 'insensitive' as const } })) },
      select: { id: true, sku: true },
    }),
  ]);

  const productIds = products.map((p) => p.id);
  const sourcing = productIds.length
    ? await prisma.productSourcing.findMany({
        where: { productId: { in: productIds } },
        // Primary supplier first, so a part with two sourcing rows resolves to
        // the one we actually buy from.
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: { productId: true, manufacturer: { select: { name: true } } },
      })
    : [];

  const vendorByProductId = new Map<string, string>();
  for (const row of sourcing) {
    const name = row.manufacturer?.name?.trim();
    if (name && !vendorByProductId.has(row.productId)) vendorByProductId.set(row.productId, name);
  }

  const vendorBySku = new Map<string, string>();

  // Product is the floor.
  for (const p of products) {
    const vendor = vendorByProductId.get(p.id);
    if (vendor) vendorBySku.set(skuKey(p.sku), vendor);
  }
  // Sku wins where it names a vendor.
  for (const r of skus) {
    const vendor = r.manufacturer?.trim();
    if (vendor) vendorBySku.set(skuKey(r.part), vendor);
  }

  const unresolved: string[] = [];
  for (const [k, original] of wanted) if (!vendorBySku.has(k)) unresolved.push(original);

  return { vendorBySku, unresolved };
}

export interface PartDetails {
  part: string;
  name: string;
  unitCostMinor: number;
}

/**
 * Name and unit cost for one part, from either catalog table.
 *
 * `addRfqLine` used to read `Sku` alone and reject anything it did not find with
 * "not in the catalogue" — including every part that lives only in `Product`.
 * Those are exactly the parts the rail now reports as having no supplier, so the
 * advice to add them to a request by hand was advice that could not be followed.
 *
 * Precedence matches `bomBuild.ts` and `resolveVendors`: Product is the floor,
 * Sku overrides it wherever it carries a figure. Returns null when neither table
 * knows the part.
 */
export async function resolvePartDetails(rawSku: string): Promise<PartDetails | null> {
  const part = s(rawSku).trim();
  if (!part) return null;

  const [sku, product] = await Promise.all([
    prisma.sku.findUnique({
      where: { part },
      select: { part: true, description: true, unitCostMinor: true },
    }),
    prisma.product.findUnique({
      where: { sku: part },
      select: { id: true, sku: true, name: true },
    }),
  ]);
  if (!sku && !product) return null;

  let productCostMinor = 0;
  if (product) {
    const cost = await prisma.productCost.findFirst({
      where: { productId: product.id },
      orderBy: { effectiveDate: 'desc' },
      select: { unitCost: true },
    });
    if (cost) productCostMinor = Number(cost.unitCost);
  }

  return {
    part: sku?.part ?? product?.sku ?? part,
    name: sku?.description || product?.name || part,
    // A zero here means the catalog records no cost, which is a real state and
    // not an error: the vendor is being asked for freight, not for the part price.
    unitCostMinor: sku?.unitCostMinor || productCostMinor || 0,
  };
}
