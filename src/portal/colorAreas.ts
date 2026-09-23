import { prisma } from '../lib/prisma.js';
import { UNASSIGNED } from '../handoff/bomSections.js';

/**
 * Portal colour areas → Bill of Materials lines.
 *
 * The portal answers colours by AREA, as
 *   { "selections": { "<group>": { "<area>": { "brand": "cardinal", "code": "T009-BL01" } } } }
 * e.g. structure_frame_paint.legs, adventure_mat.zip_line, slide.slide_color. The
 * Bill of Materials carries one colour per part line. PortalColorAreaMapping (kept
 * in Administration → Orders → Portal colour areas) says which catalog parts each
 * area paints.
 *
 * The file is split into pure pieces (labels, brand resolution, the plan of what
 * to write) and one function that loads the order and writes the plan. The plan is
 * where every rule lives — frozen vendors, conflicts, idempotency — so it can be
 * tested without a database.
 */

/** One area the customer answered. */
export interface ColorAreaPick {
  /** "<group>.<area>" — the PortalColorAreaMapping key. */
  areaKey: string;
  group: string;
  area: string;
  brand: string;
  code: string;
}

/** A part two areas both claim, with different colours. Left alone, never guessed. */
export interface ColorConflict {
  sku: string;
  /** The areas that disagree, with what each asked for ("structure_frame_paint.legs: cardinal T009-BL01"). */
  areas: string[];
}

/** What applying a reviewed selection did. */
export interface ColorApplyResult {
  /** Procurement lines whose colour was set. */
  linesUpdated: number;
  /** Areas with a pick but no parts mapped in Administration — listed, never skipped silently. */
  unmappedAreas: string[];
  /** Areas whose mapped parts are not on this order. */
  noMatchingLines: string[];
  /** Vendors whose sheet is already submitted, and so were left alone. */
  skippedVendors: string[];
  /**
   * Parts claimed by two or more areas with DIFFERENT picks. Their lines are left
   * exactly as they were: which area "wins" is a question about the equipment only a
   * person can answer, and a wrong colour on a vendor sheet costs a repaint.
   * Optional so a result recorded before this field existed still reads.
   */
  conflicts?: ColorConflict[];
  /** Lines the picks matched that already carried exactly that colour — a re-review. */
  linesAlreadyCurrent?: number;
}

/** Every area the customer answered, in a stable order. Tolerates any shape. */
export function colorAreasOf(answers: unknown): ColorAreaPick[] {
  const sel =
    answers && typeof answers === 'object'
      ? (answers as { selections?: unknown }).selections
      : null;
  if (!sel || typeof sel !== 'object') return [];
  const out: ColorAreaPick[] = [];
  for (const [group, areas] of Object.entries(sel as Record<string, unknown>)) {
    if (!areas || typeof areas !== 'object') continue;
    for (const [area, pick] of Object.entries(areas as Record<string, unknown>)) {
      const p = (pick ?? {}) as { brand?: unknown; code?: unknown };
      const code = String(p.code ?? '').trim();
      if (!code) continue;
      out.push({
        areaKey: `${group}.${area}`,
        group,
        area,
        brand: String(p.brand ?? '').trim(),
        code,
      });
    }
  }
  return out.sort((a, b) => a.areaKey.localeCompare(b.areaKey));
}

// --------------------------------------------------------------- pure helpers

/**
 * The portal's area keys are "<group>.<area>" with snake_case halves. Validated on
 * the mapping route so a typo'd key — which no answer will ever carry — cannot be
 * saved and then silently match nothing.
 */
export const AREA_KEY_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function isAreaKey(key: string): boolean {
  return AREA_KEY_RE.test(key);
}

function humanizePart(s: string): string {
  const words = s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/**
 * "structure_frame_paint.legs" → "Structure frame paint — Legs". Sentence case, not
 * title case: the halves are the portal's own phrases and read as phrases.
 */
export function areaLabel(areaKey: string): string {
  const dot = areaKey.indexOf('.');
  if (dot < 0) return humanizePart(areaKey);
  const group = humanizePart(areaKey.slice(0, dot));
  const area = humanizePart(areaKey.slice(dot + 1));
  return [group, area].filter(Boolean).join(' — ');
}

/**
 * Part numbers as an admin typed them: trimmed, blanks dropped, and de-duplicated
 * case-insensitively (the first spelling wins). Case-insensitive because the BOM
 * matches part numbers that way, so "h-1000" and "H-1000" are one part.
 */
export function normalizeSkus(skus: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of skus) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    const k = s.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export interface ManagedBrand {
  id: string;
  name: string;
}

/**
 * The managed powder brand a portal pick names, if any. The portal writes brands in
 * lower case ("cardinal"); the managed list is spelled properly ("Cardinal"). Anything
 * that is not on the list — "vinyl", "plastic" — is a material, not a powder brand,
 * and gets null.
 */
export function resolvePowderBrand(
  brand: string,
  managed: readonly ManagedBrand[],
): ManagedBrand | null {
  const b = brand.trim().toLowerCase();
  if (!b) return null;
  return managed.find((m) => m.name.trim().toLowerCase() === b) ?? null;
}

/** A powder colour from a vendor chart, used only to print the colour's name. */
export interface PowderChartColor {
  /** The chart owner's name — matched against the powder brand. */
  vendor: string;
  vendorCode: string;
  name: string;
}

/** What one line's colour columns should hold. */
export interface LineColor {
  powderBrandId: string | null;
  powderColorCode: string | null;
  powderColor: string | null;
}

/**
 * The three colour columns for one pick.
 *
 * A managed powder brand sets brand + code, and the printed text is composed the way
 * the BOM's own colour tools compose it — brand then code ("Cardinal T009-BL01") —
 * with the colour's name between them when the brand's chart has that code
 * ("Cardinal White Hammer T012-WH260"), because the shop reads names and the vendor
 * reads codes.
 *
 * Any other brand is a material colour ("vinyl" + "Lime"), which the powder brand
 * list cannot hold: it prints as "Vinyl Lime" and brand/code are cleared, so a line
 * that was powder-coated before does not keep a stale brand beside the new text.
 */
export function lineColorFor(
  pick: Pick<ColorAreaPick, 'brand' | 'code'>,
  managed: readonly ManagedBrand[],
  chart: readonly PowderChartColor[],
): LineColor {
  const code = pick.code.trim();
  const brand = resolvePowderBrand(pick.brand, managed);
  if (brand) {
    const b = brand.name.trim().toLowerCase();
    const c = code.toLowerCase();
    const named = chart.find(
      (x) => x.vendor.trim().toLowerCase() === b && x.vendorCode.trim().toLowerCase() === c,
    );
    const name = named && named.name.trim().toLowerCase() !== c ? named.name.trim() : '';
    return {
      powderBrandId: brand.id,
      powderColorCode: code || null,
      powderColor: [brand.name, name, code].filter(Boolean).join(' ') || null,
    };
  }
  const material = pick.brand.trim();
  const materialLabel = material ? material.charAt(0).toUpperCase() + material.slice(1) : '';
  return {
    powderBrandId: null,
    powderColorCode: null,
    powderColor: [materialLabel, code].filter(Boolean).join(' ') || null,
  };
}

/** The slice of a procurement line the plan reads. */
export interface PlanLine {
  id: string;
  sku: string | null;
  vendor: string | null;
  isHardwareComponent: boolean;
  powderBrandId: string | null;
  powderColorCode: string | null;
  powderColor: string | null;
}

export interface ColorPlanUpdate {
  lineId: string;
  sku: string;
  areaKey: string;
  from: LineColor;
  to: LineColor;
}

export interface ColorPlan {
  updates: ColorPlanUpdate[];
  result: ColorApplyResult;
}

const pickSig = (p: ColorAreaPick) => `${p.brand.toLowerCase()}|${p.code.toLowerCase()}`;
const vendorOf = (v: string | null) => (v && v.trim()) || UNASSIGNED;
const sameColor = (a: LineColor, b: LineColor) =>
  a.powderBrandId === b.powderBrandId &&
  a.powderColorCode === b.powderColorCode &&
  a.powderColor === b.powderColor;

/**
 * Decide what applying the picks would write, without writing it.
 *
 *   - An area with no mapped parts → unmappedAreas.
 *   - An area whose mapped parts are on no (non-hardware) line → noMatchingLines.
 *     Exploded kit fasteners are skipped: they are hardware, never painted to a
 *     customer's colour, and they share the kit's part-number family.
 *   - A line in a SUBMITTED vendor section → untouched, vendor → skippedVendors.
 *     That sheet is with the vendor; changing it here would make our copy disagree
 *     with theirs.
 *   - A line two areas claim with different picks → untouched, → conflicts. Two
 *     areas agreeing on the same pick is not a conflict.
 *   - A line already carrying exactly the colour → no write (linesAlreadyCurrent),
 *     which is what makes a second review of the same answers change nothing.
 */
export function planColorApplication(input: {
  picks: readonly ColorAreaPick[];
  /** areaKey → mapped part numbers. */
  mapping: ReadonlyMap<string, readonly string[]>;
  lines: readonly PlanLine[];
  submittedVendors: ReadonlySet<string>;
  brands: readonly ManagedBrand[];
  chart: readonly PowderChartColor[];
}): ColorPlan {
  const { picks, mapping, lines, submittedVendors, brands, chart } = input;
  const result: ColorApplyResult = {
    linesUpdated: 0,
    unmappedAreas: [],
    noMatchingLines: [],
    skippedVendors: [],
    conflicts: [],
    linesAlreadyCurrent: 0,
  };

  // Non-hardware lines by part number, case-insensitively.
  const bySku = new Map<string, PlanLine[]>();
  for (const l of lines) {
    const s = (l.sku || '').trim().toUpperCase();
    if (!s || l.isHardwareComponent) continue;
    const list = bySku.get(s) ?? [];
    list.push(l);
    bySku.set(s, list);
  }

  // Every pick that claims each line.
  const claims = new Map<string, { line: PlanLine; picks: ColorAreaPick[] }>();
  for (const pick of picks) {
    const skus = mapping.get(pick.areaKey) ?? [];
    if (!skus.length) {
      result.unmappedAreas.push(pick.areaKey);
      continue;
    }
    let matched = false;
    for (const sku of skus) {
      for (const line of bySku.get(sku.trim().toUpperCase()) ?? []) {
        matched = true;
        const c = claims.get(line.id) ?? { line, picks: [] };
        if (!c.picks.some((p) => p.areaKey === pick.areaKey)) c.picks.push(pick);
        claims.set(line.id, c);
      }
    }
    if (!matched) result.noMatchingLines.push(pick.areaKey);
  }

  const skipped = new Set<string>();
  const conflictBySku = new Map<string, Set<string>>();
  const updates: ColorPlanUpdate[] = [];
  for (const { line, picks: linePicks } of claims.values()) {
    const vendor = vendorOf(line.vendor);
    if (submittedVendors.has(vendor)) {
      skipped.add(vendor);
      continue;
    }
    const distinct = new Set(linePicks.map(pickSig));
    const sku = (line.sku || '').trim();
    if (distinct.size > 1) {
      const set = conflictBySku.get(sku.toUpperCase()) ?? new Set<string>();
      for (const p of linePicks)
        set.add(`${p.areaKey}: ${[p.brand, p.code].filter(Boolean).join(' ')}`);
      conflictBySku.set(sku.toUpperCase(), set);
      continue;
    }
    const pick = linePicks[0]!;
    const to = lineColorFor(pick, brands, chart);
    const from: LineColor = {
      powderBrandId: line.powderBrandId,
      powderColorCode: line.powderColorCode,
      powderColor: line.powderColor,
    };
    if (sameColor(from, to)) {
      result.linesAlreadyCurrent = (result.linesAlreadyCurrent ?? 0) + 1;
      continue;
    }
    updates.push({ lineId: line.id, sku, areaKey: pick.areaKey, from, to });
  }

  // Conflicts are reported under the part number as the line carries it.
  const skuSpelling = new Map<string, string>();
  for (const l of lines) {
    const s = (l.sku || '').trim();
    if (s && !skuSpelling.has(s.toUpperCase())) skuSpelling.set(s.toUpperCase(), s);
  }
  result.conflicts = [...conflictBySku.entries()]
    .map(([k, areas]) => ({ sku: skuSpelling.get(k) ?? k, areas: [...areas].sort() }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
  result.skippedVendors = [...skipped].sort();
  result.linesUpdated = updates.length;
  return { updates, result };
}

// ------------------------------------------------------------------- the write

/**
 * Apply a reviewed colour selection to the order's procurement lines through the
 * area mapping. Called from reviewPortalItem before the review is recorded, so if
 * this throws the review is not recorded either.
 *
 * A reviewed pick OVERWRITES a colour already on the line (the apply-colour tool on
 * the BOM does not, unless asked). Reviewing the customer's answers is the act of
 * accepting them, and a customer who resubmits must be able to change a colour they
 * gave before. What was there is kept in the order event, so nothing is lost.
 */
export async function applyColorPicksToOrder(
  orderId: string,
  answers: unknown,
  actorId: string,
): Promise<ColorApplyResult> {
  const picks = colorAreasOf(answers);
  if (!picks.length) {
    return {
      linesUpdated: 0,
      unmappedAreas: [],
      noMatchingLines: [],
      skippedVendors: [],
      conflicts: [],
      linesAlreadyCurrent: 0,
    };
  }

  const [mappings, lines, sections, brands, chartRows] = await Promise.all([
    prisma.portalColorAreaMapping.findMany({
      where: { areaKey: { in: [...new Set(picks.map((p) => p.areaKey))] } },
      select: { areaKey: true, sku: true },
    }),
    prisma.procurementLine.findMany({
      where: { orderId },
      select: {
        id: true,
        sku: true,
        vendor: true,
        isHardwareComponent: true,
        powderBrandId: true,
        powderColorCode: true,
        powderColor: true,
      },
    }),
    prisma.bomVendorSection.findMany({
      where: { orderId, status: 'SUBMITTED' },
      select: { vendor: true },
    }),
    prisma.powderColorBrand.findMany({ select: { id: true, name: true } }),
    // Powder charts only, and only for the colour's printed name — a vinyl chart's
    // "Lime" is not a powder code.
    prisma.vendorColor.findMany({
      where: { vendorCode: { not: null }, palette: { finishType: 'POWDER_COAT' } },
      select: {
        name: true,
        vendorCode: true,
        palette: { select: { manufacturer: { select: { name: true } } } },
      },
    }),
  ]);

  const mapping = new Map<string, string[]>();
  for (const m of mappings) {
    const list = mapping.get(m.areaKey) ?? [];
    list.push(m.sku);
    mapping.set(m.areaKey, list);
  }
  const chart: PowderChartColor[] = chartRows.map((c) => ({
    vendor: c.palette.manufacturer.name,
    vendorCode: c.vendorCode ?? '',
    name: c.name,
  }));

  const { updates, result } = planColorApplication({
    picks,
    mapping,
    lines,
    submittedVendors: new Set(sections.map((s) => vendorOf(s.vendor))),
    brands,
    chart,
  });

  if (updates.length) {
    await prisma.$transaction([
      ...updates.map((u) => prisma.procurementLine.update({ where: { id: u.lineId }, data: u.to })),
      prisma.orderEvent.create({
        data: {
          orderId,
          action: 'bom.colors.portal-review',
          actorId,
          detail: {
            linesUpdated: result.linesUpdated,
            changes: updates.map((u) => ({
              sku: u.sku,
              area: u.areaKey,
              from: u.from.powderColor,
              to: u.to.powderColor,
            })),
            unmappedAreas: result.unmappedAreas,
            noMatchingLines: result.noMatchingLines,
            skippedVendors: result.skippedVendors,
            conflicts: result.conflicts ?? [],
          } as object,
        },
      }),
    ]);
  }
  return result;
}
