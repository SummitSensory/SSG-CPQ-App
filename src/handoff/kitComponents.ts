import {
  ACCESSORY_HW_PARTS,
  hardwareRollup,
  type AdvAnswers,
} from '../proposals/adventureSeries.js';
import { metaOf } from '../proposals/analytics.js';
import { loadFormulaRules } from '../routes/formulas.js';

/**
 * The H-1000 hardware kit's fastener breakdown, for a kit line that arrived without one.
 *
 * The Bill of Materials lists every fastener on its own line because lock.ts
 * (`procurementFromItems`) replaces the kit with the `components` array the proposal
 * carries on the line. A kit line WITHOUT that array was locked as one "Hardware Kit"
 * line — the shop cannot build from it, and the vendor is sent a sheet with every
 * bolt, nut and washer bundled into a single row.
 *
 * Kit lines lose their breakdown when a proposal is started from a saved TEMPLATE:
 * "Save as template" stored only the printed fields of each line, so a template kit
 * has no `components`, and every proposal loaded from it carries the same gap into its
 * order. (Proposals from July, before the breakdown existed at all, never had one.)
 *
 * This fills the gap in two ways, most faithful first:
 *
 *   1. DESCRIPTION. An itemised kit prints its breakdown in its description —
 *      "4× Playground Handles (6820H-LAD) · 17× Titen HD Anchor (6820H-LAK) · …".
 *      That is exactly what was quoted, so when every segment reads back cleanly it
 *      is used as is.
 *   2. CONFIGURATOR. A summary description ("All mounting hardware for this structure
 *      — 450 pieces across 20 part numbers") says nothing about which pieces. The
 *      proposal keeps its configurator answers (`meta.advAnswers`), so the kit is
 *      re-evaluated against them with the proposal's own fastener lines layered over
 *      — the same call the builder makes on every change (POST
 *      /proposals/adventure-series/hardware) — and the parts that print as their own
 *      proposal lines are left out, as the generator does, so nothing is ordered twice.
 *
 * With neither, the kit line is left alone: guessing at a fastener list would put a
 * wrong order in front of a vendor, which is worse than an obviously bundled line.
 *
 * Nothing here writes to the proposal. The derived breakdown exists only on the copy
 * of the items handed to the BOM.
 */

export const HARDWARE_KIT_SKU = 'H-1000';

export interface DerivedKitComponent {
  part: string;
  name: string;
  qty: number;
}

export type KitComponentSource = 'description' | 'configurator';

export interface KitFill {
  /** The proposal line's ref, when it has one. */
  ref: string | null;
  source: KitComponentSource;
  components: DerivedKitComponent[];
}

interface RawLine {
  ref?: unknown;
  sku?: unknown;
  description?: unknown;
  quantity?: unknown;
  lineType?: unknown;
  kind?: unknown;
  optional?: unknown;
  components?: unknown;
}

const upper = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .toUpperCase();

export function isHardwareKitSku(sku: unknown): boolean {
  return upper(sku) === HARDWARE_KIT_SKU;
}

/** True when the line already carries a usable breakdown — the normal case. */
function hasComponents(line: RawLine): boolean {
  const c = line.components;
  return (
    Array.isArray(c) &&
    c.some(
      (x) =>
        !!x &&
        typeof x === 'object' &&
        String((x as { part?: unknown }).part ?? '').trim() !== '' &&
        Number((x as { qty?: unknown }).qty) > 0,
    )
  );
}

/** "4× Name (PART)" — the name may itself hold parentheses, so the LAST group is the part. */
const SEGMENT = /^(\d+)\s*[×x]\s+(.*\S)\s+\(([^\s()]+)\)$/;

/**
 * Read an itemised kit description back into its components. All-or-nothing: if any
 * segment does not read cleanly the description is not trusted, because a partial
 * list would silently drop fasteners from the order.
 */
export function parseKitDescription(description: unknown): DerivedKitComponent[] | null {
  const text = String(description ?? '').trim();
  if (!text) return null;
  const out: DerivedKitComponent[] = [];
  for (const raw of text.split(/\s+·\s+/)) {
    const seg = raw.trim();
    if (!seg) continue;
    const m = SEGMENT.exec(seg);
    if (!m) return null;
    const qty = Number(m[1]);
    const name = (m[2] ?? '').trim();
    const part = (m[3] ?? '').trim();
    if (!part || !Number.isInteger(qty) || qty <= 0) return null;
    out.push({ part, name, qty });
  }
  return out.length ? out : null;
}

/**
 * Fastener quantities the proposal carries as its own lines, keyed by part — the same
 * set the builder sends as `hwQty` (see hardwareQty() in public/app.js): non-optional
 * product lines whose part is a 6820* fastener, the kit itself excluded.
 */
export function proposalHardwareQty(items: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(items)) return out;
  for (const l of items as RawLine[]) {
    if (!l || typeof l !== 'object') continue;
    if (String(l.lineType ?? 'PRODUCT') !== 'PRODUCT' || l.optional) continue;
    const sku = upper(l.sku);
    if (!sku || sku === HARDWARE_KIT_SKU || !sku.startsWith('6820')) continue;
    const q = Number(l.quantity);
    if (!Number.isFinite(q) || q <= 0) continue;
    out[sku] = (out[sku] ?? 0) + Math.round(q);
  }
  return out;
}

/** Re-evaluate the kit from the stored configurator answers. Null when there are none. */
async function componentsFromConfigurator(
  answers: AdvAnswers | null,
  items: unknown,
): Promise<DerivedKitComponent[] | null> {
  if (!answers || typeof answers !== 'object' || !Object.keys(answers).length) return null;
  const rules = await loadFormulaRules();
  // No catalog map is passed: only part, name and quantity are needed here. Cost and
  // weight are resolved from the catalog when the BOM line is created, as for any line.
  const roll = hardwareRollup(
    answers,
    {},
    rules.hardware,
    rules.frame,
    ACCESSORY_HW_PARTS,
    proposalHardwareQty(items),
  );
  const out = roll.components
    .filter((c) => c.part && c.qty > 0)
    .map((c) => ({ part: c.part, name: c.name || c.part, qty: c.qty }));
  return out.length ? out : null;
}

/**
 * The items, with a derived `components` array on every H-1000 line that has none.
 * Returns the input untouched (same reference) when no kit line needs it, so the
 * common path costs nothing — the configurator is only consulted for a kit that has
 * neither a breakdown nor an itemised description.
 */
export async function withKitComponents(
  items: unknown,
  sections: unknown,
): Promise<{ items: unknown; filled: KitFill[] }> {
  if (!Array.isArray(items)) return { items, filled: [] };
  const needs = (items as RawLine[]).some(
    (l) => !!l && typeof l === 'object' && isHardwareKitSku(l.sku) && !hasComponents(l),
  );
  if (!needs) return { items, filled: [] };

  const answers = (metaOf(sections) as { advAnswers?: unknown }).advAnswers;
  let fromConfigurator: DerivedKitComponent[] | null | undefined;

  const filled: KitFill[] = [];
  const out: unknown[] = [];
  for (const raw of items as unknown[]) {
    const l = raw as RawLine;
    if (!l || typeof l !== 'object' || !isHardwareKitSku(l.sku) || hasComponents(l)) {
      out.push(raw);
      continue;
    }
    let source: KitComponentSource = 'description';
    let comps = parseKitDescription(l.description);
    if (!comps) {
      if (fromConfigurator === undefined)
        fromConfigurator = await componentsFromConfigurator(
          answers && typeof answers === 'object' ? (answers as AdvAnswers) : null,
          items,
        );
      comps = fromConfigurator;
      source = 'configurator';
    }
    if (!comps) {
      out.push(raw);
      continue;
    }
    filled.push({ ref: typeof l.ref === 'string' ? l.ref : null, source, components: comps });
    out.push({ ...(raw as object), components: comps.map((c) => ({ ...c })) });
  }
  return { items: out, filled };
}
