/**
 * What a part really costs us on a proposal: its Unit Purchase Cost, plus the
 * Repackaging Service Fee of its Processing Service Supplier when it has one (Catalog →
 * BOM setup, the checkbox beside the part number).
 *
 * The Bill of Materials charges the two separately — the purchase on the Procurement
 * Supplier's sheet, the fee on the processing supplier's (see handoff/bomBuild.ts) — so
 * a proposal that counted only the purchase understated cost of goods and overstated
 * margin by the fee. Every place a proposal line takes its cost from the catalog reads
 * it through here:
 *
 *   * a PER_UNIT fee is folded into the unit cost (`landedUnitCostMinor`), so every
 *     existing qty × costEach total includes it without change;
 *   * a PER_ORDER fee cannot be — it does not scale with quantity — so it travels as
 *     its own figure (`perOrderFeeMinor`), which the proposal line snapshots as
 *     `processingFeeMinor` and versionTotals adds once (proposals/analytics.ts).
 *
 * Cost only. The customer's price is never touched. And like every catalog figure, the
 * proposal snapshots it when the part is added; a later change to the fee reaches new
 * lines only (CLAUDE.md, "Data model").
 *
 * The BOM side must NOT use the landed figure: a purchase line is charged the purchase
 * cost and the processing line the fee, and charging the purchase line the landed cost
 * would count the fee twice.
 */

export interface ProcessingCostFields {
  processingEnabled?: boolean | null;
  secondaryVendor?: string | null;
  secondaryVendorCostMinor?: number | null;
  processingFeeBasis?: string | null;
}

export interface ProcessingFee {
  /** Added to every unit's cost. */
  perUnitMinor: number;
  /** Charged once for the proposal line, whatever its quantity. */
  perOrderMinor: number;
}

const NONE: ProcessingFee = { perUnitMinor: 0, perOrderMinor: 0 };

/** The part's processing fee, split by how it is charged. Zero when it has none. */
export function processingFeeOf(s: ProcessingCostFields | null | undefined): ProcessingFee {
  if (!s?.processingEnabled || !(s.secondaryVendor || '').trim()) return NONE;
  const fee = Math.max(0, Math.round(Number(s.secondaryVendorCostMinor) || 0));
  if (!fee) return NONE;
  return s.processingFeeBasis === 'PER_ORDER'
    ? { perUnitMinor: 0, perOrderMinor: fee }
    : { perUnitMinor: fee, perOrderMinor: 0 };
}

/** Unit Purchase Cost plus a per-unit Repackaging Service Fee. */
export function landedUnitCostMinor(
  unitPurchaseCostMinor: number,
  s: ProcessingCostFields | null | undefined,
): number {
  return (Number(unitPurchaseCostMinor) || 0) + processingFeeOf(s).perUnitMinor;
}

/** The Prisma `select` fragment every caller needs to feed the two functions above. */
export const PROCESSING_COST_SELECT = {
  processingEnabled: true,
  secondaryVendor: true,
  secondaryVendorCostMinor: true,
  processingFeeBasis: true,
} as const;
