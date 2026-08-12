/**
 * Vendor part numbers for parts we number differently to our supplier.
 *
 * The Adventure floor mat is the only case today, and the only difference is the
 * prefix. Internally the line carries the number the pricing engine generates —
 * R-SSG-{LLWW}CLM[-2], see matPricing.ts — because that number is on proposals
 * already accepted and must not move. The mat vendor orders the same pad as
 * R-SSA-…, so the BOM, which is a purchasing document, prints theirs.
 *
 * The digits are identical: both number the pad length then width, each padded to
 * two digits.
 *
 * Nothing joins on the result — it is printed, never matched — so a part number this
 * cannot translate simply keeps its internal number rather than failing.
 */

/** R-SSG-{length}{width}CLM, optionally -2 for the 2" pad. */
const MAT_RE = /^R-SSG-(\d{2}\d{2}CLM(?:-2)?)$/i;

/** Vendor prefix for the Adventure mat family. */
const MAT_VENDOR_PREFIX = 'R-SSA';

/**
 * The vendor's number for a part, or null when we and the vendor agree — which is
 * every part but the mats. Callers print the internal number when this is null.
 */
export function vendorPartFor(sku: string | null | undefined): string | null {
  const s = String(sku ?? '')
    .trim()
    .toUpperCase();
  if (!s) return null;

  const mat = MAT_RE.exec(s);
  if (mat) return `${MAT_VENDOR_PREFIX}-${mat[1]}`;

  return null;
}
