import { setting, defaultSettings, type FormulaSettings } from './formulaSettings.js';

/**
 * Adventure Series floor padding (mat) pricing.
 *
 * The mat is sized off the frame footprint: a fixed overage is added to EACH side of
 * the frame, the resulting rectangle is converted to square feet, and the pad is
 * priced per square foot by thickness. Sell price is the cost times the mat markup.
 *
 *   mat inches   = (lengthFt × 12 + overage) × (widthFt × 12 + overage)
 *   square feet  = square inches ÷ 144
 *   cost         = square feet × cost/sq ft (by thickness)
 *   sell price   = cost × markup multiplier
 *
 * Worked example at the standard numbers (8' × 8', 3.25"): 110" × 110" = 12,100 sq in
 * ÷ 144 = 84.03 sq ft × $11.78 = $989.85 cost → × 1.4 = $1,385.79 sell.
 *
 * All four numbers are editable under Administration → Formulas → Business numbers →
 * Mat pricing, behind a typed confirmation. The constants below are the defaults that
 * reproduce the published price list, used whenever no settings are supplied.
 */

export type MatThickness = '3.25' | '2';

/** Inches added to each side of the frame footprint to get the mat footprint. */
export const MAT_OVERAGE_IN = 14;

/** Vendor cost per square foot, by pad thickness. */
export const MAT_COST_PER_SQFT: Record<MatThickness, number> = { '3.25': 11.78, '2': 7.65 };

/** Sell price = cost × this (140% markup). Reproduces the published mat price list. */
export const MAT_MARKUP_MULTIPLIER = 1.4;

/**
 * Fixed head of the mat part number.
 *
 * Deliberately R-SSG and not R-SSA. No catalog row exists under either prefix — the
 * mat line is synthesized at price time and nothing joins on this string — so
 * renaming it would change the part number printed on proposals already accepted,
 * for no matching benefit. The QuickBooks item map keys off this prefix; see
 * src/integrations/quickbooks/synthesizedItems.ts.
 */
export const MAT_SKU_PREFIX = 'R-SSG';

/**
 * The mat vendor. Every Adventure floor pad is a Resilite pad, so the supplying
 * vendor is a property of the family rather than something a catalog row has to
 * carry — there are no catalog rows for mats (see MAT_SKU_PREFIX above).
 *
 * Match this string to the Manufacturer record name exactly, or the vendor's
 * address block on the BOM comes out blank: the BOM looks its vendor up by name.
 */
export const MAT_VENDOR = 'Resilite';

/**
 * Pad weight per square foot, by thickness. Null means "not on record" — the
 * procurement line then leaves weight alone and behaves exactly as it did before
 * mats resolved at all, rather than asserting a made-up shipping weight. Fill both
 * in and mat weight starts flowing onto BOMs and freight requests with no other
 * change.
 */
export const MAT_WEIGHT_PER_SQFT: Record<MatThickness, number | null> = {
  '3.25': null,
  '2': null,
};

/** The settings key holding the cost per square foot for a given thickness. */
const COST_KEY: Record<MatThickness, string> = {
  '3.25': 'matCostPerSqFt325',
  '2': 'matCostPerSqFt2',
};

/** R-SSG-{LL}{WW}CLM[-2] — the number matSku() generates. */
const MAT_SKU_RE = /^R-SSG-(\d{2})(\d{2})CLM(-2)?$/i;

/** What a procurement line needs to know about a mat that has no catalog row. */
export interface MatProcurementRef {
  vendor: string;
  unitCostMinor: number;
  /** Null while MAT_WEIGHT_PER_SQFT has no rate for this thickness. */
  unitWeightLbs: number | null;
}

/**
 * The dimensions and thickness encoded in a mat part number, or null when the
 * string is not one. The inverse of matSku().
 */
export function parseMatSku(
  sku: string | null | undefined,
): { lengthFt: number; widthFt: number; thickness: MatThickness } | null {
  const m = MAT_SKU_RE.exec(String(sku ?? '').trim());
  if (!m) return null;
  return {
    lengthFt: Number(m[1]),
    widthFt: Number(m[2]),
    thickness: m[3] ? '2' : '3.25',
  };
}

/**
 * Vendor, cost and weight for a mat line, derived from its part number.
 *
 * The mat is priced, not stocked: cost is recomputed from the same business numbers
 * the proposal quoted from rather than read off a catalog row, so purchasing sees
 * the figure the deal was priced on. Returns null for any part number that is not
 * a mat, which is how callers tell mats apart from everything else.
 */
export function matProcurementRef(
  sku: string | null | undefined,
  s: FormulaSettings = defaultSettings(),
): MatProcurementRef | null {
  const parsed = parseMatSku(sku);
  if (!parsed) return null;
  const quote = computeFloorPadding(parsed.lengthFt, parsed.widthFt, parsed.thickness, s);
  const rate = MAT_WEIGHT_PER_SQFT[parsed.thickness];
  return {
    vendor: MAT_VENDOR,
    unitCostMinor: quote.costMinor,
    unitWeightLbs: rate == null ? null : Math.round(quote.squareFeet * rate * 1000) / 1000,
  };
}

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
  /** The overage per side used for this quote, in inches. */
  overageIn: number;
  /** The markup multiplier used for this quote. */
  markup: number;
  description: string;
  /** Human-readable derivation, for the logic trace. */
  formula: string;
}

const pad2 = (v: number): string => String(Math.max(0, Math.round(v))).padStart(2, '0');

/**
 * Mat part number: {R-SSG}-{LLWW}{CLM}[-2]
 * e.g. 8' × 8' 3.25" → R-SSG-0808CLM; the same frame in 2" → R-SSG-0808CLM-2.
 *
 * Not settings-driven: the convention is fixed, and changing it would put part
 * numbers on new proposals that disagree with every one already quoted.
 */
export function matSku(lengthFt: number, widthFt: number, thickness: MatThickness): string {
  return `${MAT_SKU_PREFIX}-${pad2(lengthFt)}${pad2(widthFt)}CLM${thickness === '2' ? '-2' : ''}`;
}

/**
 * Price one floor pad from the frame footprint and the chosen thickness.
 *
 * `s` is the business-numbers record (Administration → Formulas). Omitted, the
 * published defaults above apply, so an existing caller keeps its behaviour.
 */
export function computeFloorPadding(
  lengthFt: number,
  widthFt: number,
  thickness: MatThickness = '3.25',
  s: FormulaSettings = defaultSettings(),
): MatQuote {
  const th: MatThickness = thickness === '2' ? '2' : '3.25';
  const L = Number(lengthFt) || 0;
  const W = Number(widthFt) || 0;
  const overage = setting(s, 'matOverageIn');
  const markup = setting(s, 'matMarkupMultiplier');
  const rate = setting(s, COST_KEY[th]);
  const matLengthIn = L * 12 + overage;
  const matWidthIn = W * 12 + overage;
  const squareInches = matLengthIn * matWidthIn;
  const sqFtExact = squareInches / 144;
  const costMinor = Math.round(sqFtExact * rate * 100);
  const priceMinor = Math.round(costMinor * markup);
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
    overageIn: overage,
    markup,
    description: `Adventure Floor Mat System (${L}' x ${W}' x ${th}")`,
    formula:
      `(${L}'×12+${overage}) × (${W}'×12+${overage}) = ${matLengthIn}" × ${matWidthIn}" = ` +
      `${squareInches.toLocaleString('en-US')} sq in ÷ 144 = ${(Math.round(sqFtExact * 100) / 100).toFixed(2)} sq ft ` +
      `× $${rate.toFixed(2)}/sq ft = $${(costMinor / 100).toFixed(2)} cost × ${markup} = $${(priceMinor / 100).toFixed(2)}`,
  };
}
