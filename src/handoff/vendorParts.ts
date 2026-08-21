import { prisma } from '../lib/prisma.js';

/**
 * Vendor part numbers — what our supplier calls a part we sell under our own
 * number.
 *
 * The number a customer sees and the number the vendor sells are not always the
 * same string. The Adventure floor mat is the standing example: the pricing engine
 * generates R-SSG-{LLWW}CLM at the moment a mat size is chosen (see matPricing.ts),
 * that number goes on the proposal, and Resilite call the same pad something else
 * entirely — A-3204. The vendor cannot order from our number and the customer must
 * never see theirs, so the two live side by side and each document prints the one
 * it needs: proposals ours, the Bill of Materials both.
 *
 * Three rules hold here:
 *
 *   1. **The mapping is data, not code.** It is keyed on the vendor AND our part
 *      number, so two vendors may have different numbers for the same part and
 *      neither is hard-coded. Mat numbers are generated rather than stocked, so a
 *      mapping row does not need a catalog SKU to exist — any part number that can
 *      appear on a BOM line can be mapped.
 *   2. **Nothing joins on the result.** It is printed, never matched. A part with
 *      no mapping keeps our number, which is what every part did before this
 *      existed.
 *   3. **It never reaches the customer.** Only the BOM — the screen, the PDF, the
 *      Excel sheet and the vendor email — reads it. No proposal path does.
 */

/** How a lookup key is built. Vendor and part are both matched case-insensitively. */
const keyOf = (vendor: string | null | undefined, part: string | null | undefined): string =>
  `${String(vendor ?? '')
    .trim()
    .toLowerCase()}|${String(part ?? '')
    .trim()
    .toUpperCase()}`;

/**
 * The legacy Adventure-mat rule: R-SSG-… → R-SSA-….
 *
 * Superseded by the mapping table and kept only as a fallback, so sheets printed
 * before Resilite's numbers were loaded still read the way they did. A mapping row
 * always wins. Delete this once the mat family is fully mapped.
 */
const MAT_RE = /^R-SS([GA])-(\d{4}CLM(?:-2)?)$/i;

export function legacyVendorPartFor(sku: string | null | undefined): string | null {
  const s = String(sku ?? '')
    .trim()
    .toUpperCase();
  if (!s) return null;
  const mat = MAT_RE.exec(s);
  return mat ? `R-SSA-${mat[2]}` : null;
}

/**
 * The other names a mat part answers to.
 *
 * A floor pad has had two of our numbers in circulation. The pricing engine
 * generates R-SSG-1008CLM; the prefix-swap rule above then printed R-SSA-1008CLM on
 * every Bill of Materials for months, so that is the string that got copied into
 * spreadsheets, quoted at Resilite, and — the part that matters here — pasted into
 * the "our part #" column when their numbers were finally loaded.
 *
 * Keying the mapping on only one of them means a table full of correct data silently
 * fails to resolve: the lookup misses, falls back to the prefix swap, and the BOM
 * prints R-SSA-1008CLM where it should print A-3206. That is the bug this fixes.
 *
 * So both forms are aliases of each other. Whichever one a mapping row was entered
 * under, a line carrying either resolves to the same vendor number. Nothing else in
 * the catalog is affected — the pattern only matches the generated mat family.
 */
export function partAliases(sku: string | null | undefined): string[] {
  const s = String(sku ?? '')
    .trim()
    .toUpperCase();
  if (!s) return [];
  const out = [s];
  const mat = MAT_RE.exec(s);
  if (mat) {
    for (const prefix of ['R-SSG', 'R-SSA']) {
      const alias = `${prefix}-${mat[2]}`;
      if (!out.includes(alias)) out.push(alias);
    }
  }
  return out;
}

export interface VendorPartLookup {
  /** The vendor's number for this vendor + part, or null when there isn't one. */
  get(vendor: string | null | undefined, part: string | null | undefined): string | null;
}

/**
 * Load every mapping that could apply to the given lines, in one query.
 *
 * Takes the pairs rather than a vendor because a combined BOM spans vendors, and a
 * per-line query would be one round trip per row.
 */
export async function vendorPartLookup(
  lines: Array<{ vendor?: string | null; sku?: string | null }>,
): Promise<VendorPartLookup> {
  // Every form of every part, so a mapping entered under either mat prefix is
  // fetched. One query still.
  const parts = [...new Set(lines.flatMap((l) => partAliases(l.sku)))];

  const byKey = new Map<string, string>();
  if (parts.length) {
    // `ourPart` is stored as typed but matched case-insensitively, so the lookup
    // reads every row for the parts in play and keys them itself rather than
    // relying on the database's collation.
    const rows = await prisma.vendorPartNumber.findMany({
      where: { active: true, ourPart: { in: parts, mode: 'insensitive' } },
      select: { ourPart: true, vendorPart: true, manufacturer: { select: { name: true } } },
    });
    for (const r of rows) byKey.set(keyOf(r.manufacturer.name, r.ourPart), r.vendorPart);
  }

  return {
    get(vendor, part) {
      // Try the part as given, then its aliases. A real mapping always beats the
      // prefix-swap fallback, whichever of our numbers it was filed under.
      for (const alias of partAliases(part)) {
        const mapped = byKey.get(keyOf(vendor, alias));
        if (mapped) return mapped;
      }
      return legacyVendorPartFor(part);
    },
  };
}

/** One lookup, for the rare single-line caller. */
export async function vendorPartFor(
  vendor: string | null | undefined,
  sku: string | null | undefined,
): Promise<string | null> {
  const lookup = await vendorPartLookup([{ vendor, sku }]);
  return lookup.get(vendor, sku);
}

/**
 * Parse a pasted two-column list into mapping rows.
 *
 * Accepts tab, comma or a run of two or more spaces between the columns, which
 * covers a paste out of Excel, a CSV and a copied table alike. A third column, if
 * present, is kept as the description. Blank lines and an obvious header row are
 * skipped; anything that cannot be read as two columns is reported by line number
 * rather than silently dropped.
 */
export interface ParsedVendorPart {
  ourPart: string;
  vendorPart: string;
  description: string | null;
}

export function parseVendorPartPaste(text: string): {
  rows: ParsedVendorPart[];
  errors: string[];
} {
  const rows: ParsedVendorPart[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const cells = line
        .split(/\t|,|\s{2,}/)
        .map((c) => c.trim())
        .filter(Boolean);
      const [rawOurs, rawTheirs] = cells;
      if (!rawOurs || !rawTheirs) {
        errors.push(
          `Line ${i + 1}: needs our part number and the vendor's, separated by a tab or comma.`,
        );
        return;
      }
      const ourPart = rawOurs.toUpperCase();
      // A pasted header ("Our part", "SKU", "Part #") is not a mapping.
      if (
        i === 0 &&
        /^(our )?(part|sku|item)/i.test(rawOurs) &&
        /vendor|their|supplier/i.test(rawTheirs)
      )
        return;
      if (seen.has(ourPart)) {
        errors.push(`Line ${i + 1}: ${ourPart} appears more than once in this paste.`);
        return;
      }
      seen.add(ourPart);
      rows.push({
        ourPart,
        vendorPart: rawTheirs,
        description: cells.length > 2 ? cells.slice(2).join(' ').trim() || null : null,
      });
    });

  return { rows, errors };
}
