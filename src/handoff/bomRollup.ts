/**
 * Hardware roll-up.
 *
 * A few fasteners are quoted on the PROPOSAL as their own line — the customer is
 * buying a zip line fixed eye bolt, and calling it that is the point. The BOM is a
 * purchasing document, and the shop buys one bin of eye bolts: the same part under
 * two proposal names has to reach the vendor as ONE Hardware line with the summed
 * quantity, or they order twice.
 *
 * Two rules live here and nowhere else:
 *
 *   1. FORCED_HARDWARE — parts the BOM files under Hardware even though no hardware
 *      RULE produced them (they came off the proposal, not the H-1000 expansion).
 *   2. ROLLUP_TO — variant part number -> the part it is purchased as. Lines that
 *      collapse to the same part, for the same vendor, print as one line.
 *
 * Nothing here touches the proposal. Proposal line items are a separate table and
 * are never rolled up: the customer keeps seeing both eye bolts, priced as quoted.
 */

/** Variant part number -> the part number it is purchased as. */
export const ROLLUP_TO: Readonly<Record<string, string>> = {
  '6820H-LP-ZP': '6820H-LP',
};

/** Parts filed under Hardware on the BOM however they got onto the order. */
export const FORCED_HARDWARE: ReadonlySet<string> = new Set(['6820H-LP', '6820H-LP-ZP']);

const norm = (sku: unknown): string =>
  String(sku ?? '')
    .trim()
    .toUpperCase();

/** Every part number a roll-up can produce, so a base line joins its own group. */
const ROLLUP_TARGETS: ReadonlySet<string> = new Set(Object.values(ROLLUP_TO).map((p) => norm(p)));

/** The part a SKU is purchased as. Returns the SKU itself when it has no rule. */
export function rollupPart(sku: unknown): string {
  return ROLLUP_TO[norm(sku)] ?? String(sku ?? '').trim();
}

/** True when the BOM should file this part under Hardware. */
export function isRollupHardwarePart(sku: unknown): boolean {
  return FORCED_HARDWARE.has(norm(sku));
}

/** True when this SKU collapses into a different part number on the BOM. */
export function isRolledVariant(sku: unknown): boolean {
  return norm(sku) in ROLLUP_TO;
}

/** True when this line takes part in a roll-up group at all — variant or base. */
function participates(sku: unknown): boolean {
  return isRolledVariant(sku) || ROLLUP_TARGETS.has(norm(sku));
}

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);
const vendorKey = (v: unknown): string =>
  (String(v ?? '').trim() || 'Unassigned vendor').toLowerCase();

/**
 * Group key: vendor + purchased part. Lines only merge when the same vendor is
 * being asked for the same part — one part bought from two vendors is two purchase
 * orders and stays two lines.
 */
const groupKey = (sku: unknown, vendor: unknown): string =>
  `${vendorKey(vendor)}::${norm(rollupPart(sku))}`;

/** "6820H-LP-ZP x2" — what the surviving line says it swallowed. */
const rolledNote = (folded: Array<{ sku: string; quantity: number }>): string =>
  `Includes ${folded.map((f) => `${f.sku} x${f.quantity}`).join(', ')}`;

/** Keeps our own note out of the vendor's, however many times this runs. */
const withNote = (existing: unknown, note: string): string =>
  [
    String(existing ?? '')
      .split(' · ')
      .filter((x) => x && !x.startsWith('Includes '))
      .join(' · '),
    note,
  ]
    .filter(Boolean)
    .join(' · ');

/** The shape a procurement line has to have to be rolled up. */
interface ProcLineLike {
  sku?: string | null;
  name?: string;
  vendor?: string | null;
  quantity?: unknown;
  unitCostMinor?: number | null;
  isHardwareComponent?: boolean;
  vendorNotes?: string | null;
}

/** What a merged line gains, so the screen can say what it is made of. */
interface RolledUp {
  quantity: unknown;
  unitCostMinor: number | null;
  vendorNotes: string | null;
  isHardwareComponent: boolean;
  name?: string;
  rolledUpFrom?: Array<{ sku: string; quantity: number }>;
  rolledUpNote?: string;
}

/**
 * Collapse rolled-up variants in a list of procurement lines.
 *
 * The surviving line is the FIRST of its group in the incoming order, so whatever
 * sort the caller applied still holds. It takes the purchased part number, the
 * summed quantity, and a note naming what was folded in. Unit cost is recomputed
 * from the summed extension, so a variant priced differently to the base part
 * cannot quietly change what the sheet adds up to.
 */
export function rollUpProcurementLines<T extends ProcLineLike>(lines: T[]): T[] {
  if (!lines.some((l) => isRolledVariant(l.sku))) return lines;

  const out: T[] = [];
  const groups = new Map<
    string,
    {
      line: RolledUp;
      qty: number;
      extMinor: number;
      folded: Array<{ sku: string; quantity: number }>;
    }
  >();

  for (const line of lines) {
    if (!participates(line.sku)) {
      out.push(line);
      continue;
    }
    const qty = num(line.quantity);
    const ext = num(line.unitCostMinor) * qty;
    const key = groupKey(line.sku, line.vendor);
    const seen = groups.get(key);

    if (!seen) {
      const merged = { ...line, sku: rollupPart(line.sku), isHardwareComponent: true };
      const folded: Array<{ sku: string; quantity: number }> = [];
      if (isRolledVariant(line.sku)) folded.push({ sku: String(line.sku ?? ''), quantity: qty });
      groups.set(key, { line: merged as unknown as RolledUp, qty, extMinor: ext, folded });
      out.push(merged as T);
      continue;
    }

    seen.qty += qty;
    seen.extMinor += ext;
    seen.folded.push({ sku: String(line.sku ?? ''), quantity: qty });
    const m = seen.line;
    // The base part's own description wins over a variant's — the vendor's bin is
    // labelled with it.
    if (!isRolledVariant(line.sku) && line.name) m.name = line.name;
    m.quantity = seen.qty;
    m.unitCostMinor = seen.qty ? Math.round(seen.extMinor / seen.qty) : num(line.unitCostMinor);
    m.rolledUpFrom = seen.folded.slice();
    m.rolledUpNote = rolledNote(seen.folded);
    m.vendorNotes = withNote(m.vendorNotes, m.rolledUpNote);
  }
  return out;
}

/** The shape of an already-built BOM line. */
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
}

/**
 * The same collapse for built BOM lines, where the extensions are already computed
 * and the weight has to be summed as well.
 */
export function rollUpBomLines<T extends BomLineLike>(lines: T[]): T[] {
  if (!lines.some((l) => isRolledVariant(l.sku))) return lines;

  const out: T[] = [];
  const groups = new Map<
    string,
    { line: BomLineLike; folded: Array<{ sku: string; quantity: number }> }
  >();

  for (const line of lines) {
    if (!participates(line.sku)) {
      out.push(line);
      continue;
    }
    const key = groupKey(line.sku, line.vendor);
    const seen = groups.get(key);

    if (!seen) {
      const part = rollupPart(line.sku);
      const merged = {
        ...line,
        sku: part,
        lineNo: line.vendorSku || part || '—',
        isHardware: true,
      };
      const folded: Array<{ sku: string; quantity: number }> = [];
      if (isRolledVariant(line.sku)) folded.push({ sku: line.sku, quantity: line.quantity });
      groups.set(key, { line: merged as BomLineLike, folded });
      out.push(merged as T);
      continue;
    }

    const m = seen.line;
    seen.folded.push({ sku: line.sku, quantity: line.quantity });
    if (!isRolledVariant(line.sku) && line.name) m.name = line.name;
    m.quantity += line.quantity;
    m.extendedCostMinor += line.extendedCostMinor;
    m.extendedWeightLbs = Math.round((m.extendedWeightLbs + line.extendedWeightLbs) * 1000) / 1000;
    m.unitCostMinor = m.quantity ? Math.round(m.extendedCostMinor / m.quantity) : m.unitCostMinor;
    if (!m.unitWeightLbs) m.unitWeightLbs = line.unitWeightLbs;
    m.vendorNotes = withNote(m.vendorNotes, rolledNote(seen.folded));
  }
  return out;
}
