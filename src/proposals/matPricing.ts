/**
 * Adventure Series floor padding (mat) pricing.
 *
 * The mat is sized off the frame footprint: 14" is added to EACH side of the
 * frame, the resulting rectangle is converted to square feet, and the pad is
 * priced per square foot by thickness. Sell price is the cost times the standard
 * mat multiplier (140% markup — cost × 1.4).
 *
 *   mat inches   = (lengthFt × 12 + 14) × (widthFt × 12 + 14)
 *   square feet  = square inches ÷ 144
 *   cost         = square feet × cost/sq ft (by thickness)
 *   sell price   = cost × MAT_MARKUP_MULTIPLIER
 *
 * Worked example (8' × 8', 3.25"): 110" × 110" = 12,100 sq in ÷ 144 = 84.03 sq ft
 * × $11.78 = $989.85 cost → × 1.4 = $1,385.79 sell.
 */

export type MatThickness = '3.25' | '2';

/** Inches added to each side of the frame footprint to get the mat footprint. */
export const MAT_OVERAGE_IN = 14;

/** Vendor cost per square foot, by pad thickness. */
export const MAT_COST_PER_SQFT: Record<MatThickness, number> = { '3.25': 11.78, '2': 7.65 };

/** Sell price = cost × this (140% markup). Reproduces the published mat price list. */
export const MAT_MARKUP_MULTIPLIER = 1.4;

/** Fixed head of the mat part number. */
export const MAT_SKU_PREFIX = 'R-SSG';

export interface MatQuote {
  sku: string;
  thickness: MatThickness;
  lengthFt: number;
  widthFt: number;
  matLengthIn: number;
  matWidthIn: number;
  squareInches: number;
  /** Rounded to 2 dp, as quoted. */
  squareFeet: number;
  costPerSqFtMinor: number;
  costMinor: number;
  priceMinor: number;
  description: string;
  /** Human-readable derivation, for the logic trace. */
  formula: string;
}

const pad2 = (v: number): string => String(Math.max(0, Math.round(v))).padStart(2, '0');

/**
 * Mat part number: {R-SSG}-{LLWW}{CLM}[-2]
 * e.g. 8' × 8' 3.25" → R-SSG-0808CLM; the same frame in 2" → R-SSG-0808CLM-2.
 */
export function matSku(lengthFt: number, widthFt: number, thickness: MatThickness): string {
  return `${MAT_SKU_PREFIX}-${pad2(lengthFt)}${pad2(widthFt)}CLM${thickness === '2' ? '-2' : ''}`;
}

/** Price one floor pad from the frame footprint and the chosen thickness. */
export function computeFloorPadding(lengthFt: number, widthFt: number, thickness: MatThickness = '3.25'): MatQuote {
  const th: MatThickness = thickness === '2' ? '2' : '3.25';
  const L = Number(lengthFt) || 0;
  const W = Number(widthFt) || 0;
  const matLengthIn = L * 12 + MAT_OVERAGE_IN;
  const matWidthIn = W * 12 + MAT_OVERAGE_IN;
  const squareInches = matLengthIn * matWidthIn;
  const sqFtExact = squareInches / 144;
  const rate = MAT_COST_PER_SQFT[th];
  const costMinor = Math.round(sqFtExact * rate * 100);
  const priceMinor = Math.round(costMinor * MAT_MARKUP_MULTIPLIER);
  return {
    sku: matSku(L, W, th),
    thickness: th,
    lengthFt: L,
    widthFt: W,
    matLengthIn,
    matWidthIn,
    squareInches,
    squareFeet: Math.round(sqFtExact * 100) / 100,
    costPerSqFtMinor: Math.round(rate * 100),
    costMinor,
    priceMinor,
    description: `Adventure Floor Mat System (${L}' x ${W}' x ${th}")`,
    formula:
      `(${L}'×12+${MAT_OVERAGE_IN}) × (${W}'×12+${MAT_OVERAGE_IN}) = ${matLengthIn}" × ${matWidthIn}" = ` +
      `${squareInches.toLocaleString('en-US')} sq in ÷ 144 = ${(Math.round(sqFtExact * 100) / 100).toFixed(2)} sq ft ` +
      `× $${rate.toFixed(2)}/sq ft = $${(costMinor / 100).toFixed(2)} cost × ${MAT_MARKUP_MULTIPLIER} = $${(priceMinor / 100).toFixed(2)}`,
  };
}
