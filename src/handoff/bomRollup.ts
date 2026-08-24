/**
 * Hardware roll-up.
 *
 * A few fasteners are quoted on the PROPOSAL as their own line — the customer is
 * buying a zip line fixed eye bolt, and calling it that is the point. The BOM is a
 * purchasing document, and the shop buys one bin of eye bolts: the same part under
 * two proposal names has to reach the vendor as one Hardware line with one
 * quantity, or they order twice.
 *
 * So this file holds the only two rules that make that true, and nothing else
 * decides them:
 *
 *   1. FORCED_HARDWARE — parts the BOM files under Hardware even though no
 *      hardware RULE produced them (they came off the proposal, not the H-1000
 *      kit expansion).
 *   2. ROLLUP_TO — variant part number -> the part it is bought as. Lines that
 *      collapse to the same part, for the same vendor, print as one line.
 *
 * Nothing here touches the proposal. Proposal line items are a separate table and
 * are never rolled up: the customer keeps seeing both eye bolts, priced as quoted.
 */

/** Variant part number -> the part number it is purchased as. */
export const ROLLUP_TO: Readonly<Record<string, string>> = {
  '6820H-LP-ZP': '6820H-LP',
};

/** Parts filed under Hardware on the BOM regardless of how they got on the order. */
export const FORCED_HARDWARE: ReadonlySet<string> = new Set(['6820H-LP', '6820H-LP-ZP']);

const norm = (sku: unknown): string =>
  String(sku ?? '')
    .trim()
    .toUpperCase();

/** The part a SKU is bought as. Returns the SKU itself when it has no variant rule. */
export function rollupPart(sku: unknown): string {
  const k = norm(sku);
  return ROLLUP_TO[k] ?? String(sku ?? '').trim();
}

/** True when the BOM should file this part under Hardware. */
export function isRollupHardwarePart(sku: unknown): boolean {
  return FORCED_HARDWARE.has(norm(sku));
}

/** True when this SKU collapses into a different part number on the BOM. */
export function isRolledVariant(sku: unknown): boolean {
  return norm(sku) in ROLLUP_TO;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);
const vendorKey = (v: unknown): string =>
  (String(v ?? '').trim() || 'Unassigned vendor').toLowerCase();

/**
 * Group key: vendor + purchased part. Two lines only ever merge when the same
 * vendor is being asked for the same part — a part bought from two vendors stays
 * two lines, because it is two purchase orders.
 */
const groupKey = (line: { sku?: unknown; vendor?: unknown }): string =>
  `${vendorKey(line.vendor)}::${norm(rollupPart(line.sku))}`;

/** "6820H-LP-ZP x2" — what the merged line says it swallowed. */
const rolledNote = (parts: Array<{ sku: string; quantity: number }>): string =>
  parts.map((p) => `${p.sku} x${p.quantity}`).join(', ');

interface ProcLineLike {
  sku?: string | null;
  name?: string;
  vendor?: string | null;
  quantity?: unknown;
  unitCostMinor?: number | null;
  isHardwareComponent?: boolean;
  vendorNotes?: string | null;
  [k: string]: unknown;
}

/**
 * Collapse rolled-up variants in a list of procurement lines.
 *
 * The surviving line is the FIRST of its group in the incoming order, so whatever
 * sort the caller applied still holds. It takes the purchased part number, the
 * summed quantity, and a note naming the variants folded into it. Unit cost is
 * recomputed from the summed extension, so a variant priced differently to the base
 * part cannot silently change what the sheet adds up to.
 */
export function rollUpProcurementLines<T extends ProcLineLike>(lines: T[]): T[] {
  if (!lines.some((l) => isRolledVariant(l.sku))) return lines;

  const out: T[] = [];
  const byKey = new Map<
    string,
    { line: T; qty: number; extMinor: number; folded: Array<{ sku: string; quantity: number }> }
  >();

  for (const line of lines) {
    const qty = num(line.quantity);
    const ext = num(line.unitCostMinor) * qty;
    const rolls = isRolledVariant(line.sku) || Object.values(ROLLUP_TO).includes(norm(line.sku));
    if (!rolls) {
      out.push(line);
      continue;
    }
    const key = groupKey(line);
    const seen = byKey.get(key);
    if (!seen) {
      const merged = { ...line, sku: rollupPart(line.sku), isHardwareComponent: true } as T;
      const entry = {
        line: merged,
        qty,
        extMinor: ext,
        folded: [] as Array<{ sku: string; quantity: number }>,
      };
      if (isRolledVariant(line.sku)) entry.folded.push({ sku: String(line.sku), quantity: qty });
      byKey.set(key, entry);
      out.push(merged);
      continue;
    }
    seen.qty += qty;
    seen.extMinor += ext;
    seen.folded.push({ sku: String(line.sku ?? ''), quantity: qty });
    // The base part's own name wins over a variant's — the vendor knows the part by it.
    if (!isRolledVariant(line.sku) && line.name) (seen.line as ProcLineLike).name = line.name;
    const l = seen.line as ProcLineLike;
    l.quantity = seen.qty;
    l.unitCostMinor = seen.qty ? Math.round(seen.extMinor / seen.qty) : num(line.unitCostMinor);
    const note = `Includes ${rolledNote(seen.folded)}`;
    l.rolledUpNote = note;
    l.rolledUpSkus = seen.folded.map((f) => f.sku);
    const base = String(l.vendorNotes ?? '')
      .split(' · ')
      .filter((x) => x && !x.startsWith('Includes '))
      .join(' · ');
    l.vendorNotes = [base, note].filter(Boolean).join(' · ');
  }
  return out;
}

interface BomLineLike {
  sku: string;
  lineNo: string;
  vendorSku: string;
  name: string;
  quantity: number;
  unitCostMinor: number;
  extendedCostMinor: number;
  unitWeightLbs: number;
  extendedWeightLbs: number;
  vendor: string;
  vendorNotes: string;
  isHardware: boolean;
  treeOrder: number;
  [k: string]: unknown;
}

/**
 * The same collapse for built BOM lines, where the extensions are already computed
 * and the weight has to be summed too.
 */
export function rollUpBomLines<T extends BomLineLike>(lines: T[]): T[] {
  if (!lines.some((l) => isRolledVariant(l.sku))) return lines;

  const out: T[] = [];
  const byKey = new Map<string, { line: T; folded: Array<{ sku: string; quantity: number }> }>();

  for (const line of lines) {
    const rolls = isRolledVariant(line.sku) || Object.values(ROLLUP_TO).includes(norm(line.sku));
    if (!rolls) {
      out.push(line);
      continue;
    }
    const key = groupKey(line);
    const seen = byKey.get(key);
    if (!seen) {
      const part = rollupPart(line.sku);
      const merged = {
        ...line,
        sku: part,
        lineNo: line.vendorSku || part || '—',
        isHardware: true,
      } as T;
      const entry = { line: merged, folded: [] as Array<{ sku: string; quantity: number }> };
      if (isRolledVariant(line.sku)) entry.folded.push({ sku: line.sku, quantity: line.quantity });
      byKey.set(key, entry);
      out.push(merged);
      continue;
    }
    const m = seen.line as BomLineLike;
    seen.folded.push({ sku: line.sku, quantity: line.quantity });
    if (!isRolledVariant(line.sku) && line.name) m.name = line.name;
    m.quantity += line.quantity;
    m.extendedCostMinor += line.extendedCostMinor;
    m.extendedWeightLbs = Math.round((m.extendedWeightLbs + line.extendedWeightLbs) * 1000) / 1000;
    m.unitCostMinor = m.quantity ? Math.round(m.extendedCostMinor / m.quantity) : m.unitCostMinor;
    if (!m.unitWeightLbs) m.unitWeightLbs = line.unitWeightLbs;
    const note = `Includes ${rolledNote(seen.folded)}`;
    const base = m.vendorNotes
      .split(' · ')
      .filter((x) => x && !x.startsWith('Includes '))
      .join(' · ');
    m.vendorNotes = [base, note].filter(Boolean).join(' · ');
    // Merged rows belong in the Hardware block, sorted with the rest of it.
    m.isHardware = true;
  }
  return out;
}
