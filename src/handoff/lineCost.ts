/**
 * A Bill of Materials line's extended cost — the one place it is worked out.
 *
 * Almost every line costs `unitCostMinor × quantity`. A processing-supplier line whose
 * Repackaging Service Fee is charged once per order (`costPerOrder`) costs
 * `unitCostMinor` flat, whatever the quantity. Every total — the sheet, the section
 * header, the purchase order, the vendor-invoice comparison, cost refresh and the
 * drift report — reads a line's cost through here, so the two cases cannot disagree.
 */

export interface CostedLine {
  unitCostMinor?: number | null;
  quantity?: number | null;
  costPerOrder?: boolean | null;
}

/** How many times the unit cost is charged: the quantity, or once for a flat fee. */
export function costMultiplier(l: Pick<CostedLine, 'quantity' | 'costPerOrder'>): number {
  const qty = Number(l.quantity) || 0;
  if (l.costPerOrder) return qty > 0 ? 1 : 0;
  return qty;
}

/** unitCostMinor × quantity, or unitCostMinor alone on a per-order line. */
export function lineExtendedCostMinor(l: CostedLine): number {
  return Math.round((Number(l.unitCostMinor) || 0) * costMultiplier(l));
}
