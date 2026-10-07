import { prisma } from '../lib/prisma.js';
import { isRollupHardwarePart } from './bomRollup.js';

/**
 * How a Bill of Materials is laid out: which order its lines print in, and which
 * heading each one prints under.
 *
 * One function decides both, and every reader of the BOM calls it — the order page,
 * the printed/emailed sheet, the Excel and CSV exports. They used to decide
 * separately: the page grouped "Hardware" by the kit flag alone and listed lines in
 * whatever order the database returned them, while the sheet grouped by the kit flag
 * OR a hardware rule and sorted by proposal position. Two people looking at the same
 * order could see two different lists.
 *
 * ORDER, highest priority first:
 *   1. ProcurementLine.bomPosition — this order's sheet was rearranged by hand.
 *   2. Sku.bomSortOrder            — the manufacturing team's preset for the part.
 *   3. proposalLineOrder           — where the part sat on the signed proposal.
 * A line with a position (1 or 2) prints ahead of every line without one; lines
 * without one keep proposal order. The sort is stable, so ties keep the order they
 * were read in rather than reshuffling on every render.
 *
 * HEADING, first match wins, and the reason is reported alongside so "why is this
 * under Hardware?" always has an answer on screen:
 *   - 'order'   ProcurementLine.bomGroup — set on this order.
 *   - 'catalog' Sku.bomGroup             — set for the part in Catalog → BOM setup.
 *   - 'kit'     the line came out of a hardware kit (H-1000) at lock time.
 *   - 'rule'    the part has a hardware quantity rule (Settings → Formulas).
 *   - 'forced'  the part is on bomRollup's FORCED_HARDWARE list.
 *   - 'none'    main list.
 * An empty heading ('') is the main list. Setting '' on a part is how a part a rule
 * calls hardware is kept in the main list.
 */

export const HARDWARE = 'Hardware';

export type HeadingReason = 'order' | 'catalog' | 'kit' | 'rule' | 'forced' | 'none';

export const HEADING_REASON_TEXT: Readonly<Record<HeadingReason, string>> = {
  order: 'Set on this order',
  catalog: 'Set for this part in Catalog → BOM setup',
  kit: 'Came out of a hardware kit (H-1000) when the order was locked',
  rule: 'Has a hardware quantity rule under Settings → Formulas',
  forced: 'Always filed under Hardware (eye-bolt roll-up)',
  none: 'Main list',
};

export interface PartLayout {
  bomSortOrder: number | null;
  bomGroup: string | null;
}

export interface LayoutTables {
  /** Upper-cased part number → its catalog preset. */
  parts: Map<string, PartLayout>;
  /** Upper-cased part numbers a hardware quantity rule produces, plus the kit itself. */
  hardwareRuleParts: Set<string>;
}

export interface LayoutLineLike {
  sku?: string | null;
  isHardwareComponent?: boolean | null;
  bomGroup?: string | null;
  bomPosition?: number | null;
  proposalLineOrder?: number | null;
}

const key = (sku: unknown): string =>
  String(sku ?? '')
    .trim()
    .toUpperCase();

/** A heading as stored: trimmed, and null when the caller meant "automatic". */
export function normalizeHeading(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v).trim().slice(0, 60);
}

export function isHardwareHeading(heading: string): boolean {
  return heading.trim().toLowerCase() === HARDWARE.toLowerCase();
}

/** The catalog presets and hardware-rule membership for a set of part numbers. */
export async function loadLayoutTables(
  skus: Array<string | null | undefined>,
): Promise<LayoutTables> {
  const wanted = [...new Set(skus.map((s) => String(s ?? '').trim()).filter(Boolean))];
  const [rows, rules] = await Promise.all([
    wanted.length
      ? prisma.sku.findMany({
          where: { part: { in: wanted, mode: 'insensitive' } },
          select: { part: true, bomSortOrder: true, bomGroup: true },
        })
      : Promise.resolve(
          [] as Array<{ part: string; bomSortOrder: number | null; bomGroup: string | null }>,
        ),
    prisma.hardwareRule.findMany({ where: { kind: 'HARDWARE' }, select: { part: true } }),
  ]);
  return {
    parts: new Map(
      rows.map((r) => [key(r.part), { bomSortOrder: r.bomSortOrder, bomGroup: r.bomGroup }]),
    ),
    hardwareRuleParts: new Set(['H-1000', ...rules.map((r) => key(r.part))]),
  };
}

/** The heading a line prints under, and why. */
export function headingOf(
  line: LayoutLineLike,
  t: LayoutTables,
): { heading: string; reason: HeadingReason } {
  const own = normalizeHeading(line.bomGroup);
  if (own !== null) return { heading: own, reason: 'order' };
  const k = key(line.sku);
  const preset = normalizeHeading(t.parts.get(k)?.bomGroup);
  if (preset !== null) return { heading: preset, reason: 'catalog' };
  if (line.isHardwareComponent) return { heading: HARDWARE, reason: 'kit' };
  if (k && t.hardwareRuleParts.has(k)) return { heading: HARDWARE, reason: 'rule' };
  if (isRollupHardwarePart(k)) return { heading: HARDWARE, reason: 'forced' };
  return { heading: '', reason: 'none' };
}

/** The line's preset position, or null when it has none and follows the proposal. */
export function sequenceOf(line: LayoutLineLike, t: LayoutTables): number | null {
  if (line.bomPosition != null) return line.bomPosition;
  return t.parts.get(key(line.sku))?.bomSortOrder ?? null;
}

/** The lines in BOM order. Never mutates the input. */
export function sortForBom<T extends LayoutLineLike>(lines: T[], t: LayoutTables): T[] {
  const inf = Number.POSITIVE_INFINITY;
  return lines
    .map((line, i) => ({
      line,
      i,
      seq: sequenceOf(line, t) ?? inf,
      prop: line.proposalLineOrder ?? inf,
    }))
    .sort((a, b) => a.seq - b.seq || a.prop - b.prop || a.i - b.i)
    .map((x) => x.line);
}

/**
 * Lines split under their headings, keeping the order they arrive in. The main list
 * (no heading) always comes first; every other heading appears where its first line
 * falls, so a team that numbers its hardware first sees Hardware first.
 */
export function groupByHeading<T>(
  lines: T[],
  headingOfLine: (l: T) => string,
): Array<{ title: string; lines: T[] }> {
  const groups = new Map<string, { title: string; lines: T[] }>();
  groups.set('', { title: '', lines: [] });
  for (const l of lines) {
    const title = headingOfLine(l).trim();
    // Case-insensitive, so "hardware" typed on one part does not open a second group.
    const k = title.toLowerCase();
    let g = groups.get(k);
    if (!g) {
      g = { title, lines: [] };
      groups.set(k, g);
    }
    g.lines.push(l);
  }
  return [...groups.values()].filter((g) => g.lines.length);
}
