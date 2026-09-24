import { prisma } from '../lib/prisma.js';
import { UNASSIGNED } from '../handoff/bomSections.js';
import {
  describePicks,
  readPicks,
  specsForLines,
  type ColorPick,
  type ResolvedColorSpec,
} from '../vendorColors/service.js';

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
 * Two refinements on "area → parts":
 *   - A mapped part may be a PATTERN with `*` (e.g. R-SSG-*CLM*), for parts whose
 *     number is generated per job — the Adventure floor padding is R-SSG-{LLWW}CLM[-2],
 *     one number per mat size, with no catalog row.
 *   - A mapped part may name a PIECE: one part number that takes a colour per piece
 *     (a Palisades or 90° Climb & Slide mat system). The piece is the slot of that
 *     part's colour spec (Administration → Manufacturers → Colours); the customer's
 *     colour is looked up on the spec's vendor chart so the vendor code prints too.
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
  /**
   * Pieces whose colour is not on the part's vendor chart ("palisades_mat.palisades_mat_2:
   * vinyl Lime — not on Resilite Vinyl"). That piece is left as it was, never guessed.
   */
  offChart?: string[];
}

/**
 * One part an area colours. `sku` may be a pattern with `*`. `piece` names which
 * piece (colour-spec slot) of a multi-piece part; null means the whole part.
 */
export interface MappedPartRef {
  sku: string;
  piece: number | null;
}

/** A mapping entry as given: a bare part number (whole part) or a part + piece. */
export type MappingEntry = string | MappedPartRef;

const toRef = (e: MappingEntry): MappedPartRef =>
  typeof e === 'string' ? { sku: e, piece: null } : { sku: e.sku, piece: e.piece ?? null };

/** Whether a mapped part number is a pattern rather than one part. */
export function isPartPattern(sku: string): boolean {
  return sku.includes('*');
}

/** Case-insensitive matcher for a mapped part number or `*` pattern. */
export function partMatcher(sku: string): (lineSku: string) => boolean {
  const t = sku.trim().toUpperCase();
  if (!isPartPattern(t)) return (x) => x.trim().toUpperCase() === t;
  const re = new RegExp(
    '^' +
      t
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
  return (x) => re.test(x.trim().toUpperCase());
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
  /** Colour-spec slot picks — only set for a multi-piece part. */
  colorPicks?: ColorPick[];
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
  /** What the line's colour-spec slots already hold (ProcurementLine.colorPicks). */
  colorPicks?: unknown;
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
  a.powderColor === b.powderColor &&
  (b.colorPicks === undefined ||
    JSON.stringify(a.colorPicks ?? []) === JSON.stringify(b.colorPicks));

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
  /** areaKey → mapped parts (a bare part number means the whole part). */
  mapping: ReadonlyMap<string, readonly MappingEntry[]>;
  lines: readonly PlanLine[];
  /** lineId → that line's colour spec, for multi-piece parts. */
  specs?: ReadonlyMap<string, ResolvedColorSpec>;
  submittedVendors: ReadonlySet<string>;
  brands: readonly ManagedBrand[];
  chart: readonly PowderChartColor[];
}): ColorPlan {
  const { picks, mapping, lines, submittedVendors, brands, chart } = input;
  const specs = input.specs ?? new Map<string, ResolvedColorSpec>();
  const offChart: string[] = [];
  const result: ColorApplyResult = {
    linesUpdated: 0,
    unmappedAreas: [],
    noMatchingLines: [],
    skippedVendors: [],
    conflicts: [],
    linesAlreadyCurrent: 0,
  };

  // Non-hardware lines with a part number.
  const paintable = lines.filter((l) => (l.sku || '').trim() && !l.isHardwareComponent);

  // Every pick that claims each line, with the piece it claims (null = whole part).
  type Claim = { pick: ColorAreaPick; piece: number | null };
  const claims = new Map<string, { line: PlanLine; picks: ColorAreaPick[]; claims: Claim[] }>();
  for (const pick of picks) {
    const refs = (mapping.get(pick.areaKey) ?? []).map(toRef);
    if (!refs.length) {
      result.unmappedAreas.push(pick.areaKey);
      continue;
    }
    let matched = false;
    for (const ref of refs) {
      const matches = partMatcher(ref.sku);
      for (const line of paintable) {
        if (!matches(line.sku as string)) continue;
        matched = true;
        const c = claims.get(line.id) ?? { line, picks: [], claims: [] };
        if (!c.picks.some((p) => p.areaKey === pick.areaKey)) {
          c.picks.push(pick);
          c.claims.push({ pick, piece: ref.piece });
        }
        claims.set(line.id, c);
      }
    }
    if (!matched) result.noMatchingLines.push(pick.areaKey);
  }

  const skipped = new Set<string>();
  const conflictBySku = new Map<string, Set<string>>();
  const updates: ColorPlanUpdate[] = [];
  for (const { line, picks: linePicks, claims: lineClaims } of claims.values()) {
    const vendor = vendorOf(line.vendor);
    if (submittedVendors.has(vendor)) {
      skipped.add(vendor);
      continue;
    }
    const sku = (line.sku || '').trim();
    const addConflict = (list: readonly ColorAreaPick[]) => {
      const set = conflictBySku.get(sku.toUpperCase()) ?? new Set<string>();
      for (const p of list) set.add(`${p.areaKey}: ${[p.brand, p.code].filter(Boolean).join(' ')}`);
      conflictBySku.set(sku.toUpperCase(), set);
    };
    const from: LineColor = {
      powderBrandId: line.powderBrandId,
      powderColorCode: line.powderColorCode,
      powderColor: line.powderColor,
      colorPicks: readPicks(line.colorPicks),
    };

    // A multi-piece part: each area colours one piece. Only two DIFFERENT picks for
    // the SAME piece conflict — or an area colouring the whole part alongside areas
    // colouring its pieces, which is ambiguous.
    if (lineClaims.some((c) => c.piece != null)) {
      if (lineClaims.some((c) => c.piece == null)) {
        addConflict(linePicks);
        continue;
      }
      const byPiece = new Map<number, ColorAreaPick[]>();
      for (const c of lineClaims) {
        const list = byPiece.get(c.piece as number) ?? [];
        list.push(c.pick);
        byPiece.set(c.piece as number, list);
      }
      const clashing = [...byPiece.values()].filter((l) => new Set(l.map(pickSig)).size > 1);
      if (clashing.length) {
        addConflict(clashing.flat());
        continue;
      }

      const spec = specs.get(line.id);
      let to: LineColor;
      if (spec) {
        // Slots of the part's colour spec, the customer's colour found on its vendor
        // chart by name or code. Slots nobody answered keep what they had.
        const bySlot = new Map<number, ColorPick>();
        for (const pk of from.colorPicks ?? []) bySlot.set(pk.slot, pk);
        for (const [slot, list] of byPiece) {
          const pick = list[0]!;
          const code = pick.code.trim().toLowerCase();
          const color =
            slot >= 1 && slot <= spec.slotCount
              ? spec.colors.find(
                  (c) =>
                    c.name.trim().toLowerCase() === code ||
                    (c.vendorCode ?? '').trim().toLowerCase() === code,
                )
              : undefined;
          if (!color) {
            offChart.push(
              `${pick.areaKey}: ${[pick.brand, pick.code].filter(Boolean).join(' ')} — ${
                slot > spec.slotCount
                  ? `${sku} takes ${spec.slotCount} colour${spec.slotCount === 1 ? '' : 's'}, not a piece ${slot}`
                  : `not on ${spec.palette.name}`
              }`,
            );
            continue;
          }
          bySlot.set(slot, {
            slot,
            colorId: color.id,
            name: color.name,
            vendorCode: color.vendorCode,
            upchargeMinor: color.upchargeMinor,
          });
        }
        const merged = [...bySlot.values()].sort((a, b) => a.slot - b.slot);
        to = {
          powderBrandId: null,
          powderColorCode: null,
          powderColor: describePicks(merged, { withVendorCode: true, spec }) || null,
          colorPicks: merged,
        };
      } else {
        // No colour spec on this part yet: still record every piece, in order, as text.
        to = {
          powderBrandId: null,
          powderColorCode: null,
          powderColor:
            [...byPiece.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(
                ([n, l]) =>
                  `Piece ${n}: ${lineColorFor(l[0]!, brands, chart).powderColor ?? l[0]!.code}`,
              )
              .join(' · ') || null,
        };
      }
      if (sameColor(from, to)) {
        result.linesAlreadyCurrent = (result.linesAlreadyCurrent ?? 0) + 1;
        continue;
      }
      updates.push({
        lineId: line.id,
        sku,
        areaKey: lineClaims
          .map((c) => c.pick.areaKey)
          .sort()
          .join(', '),
        from,
        to,
      });
      continue;
    }

    const distinct = new Set(linePicks.map(pickSig));
    if (distinct.size > 1) {
      addConflict(linePicks);
      continue;
    }
    const pick = linePicks[0]!;
    const to = lineColorFor(pick, brands, chart);
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
  result.offChart = offChart;
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
      select: { areaKey: true, sku: true, piece: true },
    }),
    prisma.procurementLine.findMany({
      where: { orderId },
      select: {
        id: true,
        productId: true,
        colorPicks: true,
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

  const mapping = new Map<string, MappedPartRef[]>();
  for (const m of mappings) {
    const list = mapping.get(m.areaKey) ?? [];
    list.push({ sku: m.sku, piece: m.piece ?? null });
    mapping.set(m.areaKey, list);
  }

  // Colour specs, only needed when some area colours a piece of a part.
  const specs = new Map<string, ResolvedColorSpec>();
  if (mappings.some((m) => m.piece != null)) {
    const byKey = await specsForLines(lines);
    for (const l of lines) {
      const spec =
        (l.productId ? byKey.get(l.productId) : undefined) ??
        byKey.get((l.sku ?? '').trim().toUpperCase());
      if (spec) specs.set(l.id, spec);
    }
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
    specs,
    submittedVendors: new Set(sections.map((s) => vendorOf(s.vendor))),
    brands,
    chart,
  });

  if (updates.length) {
    await prisma.$transaction([
      ...updates.map((u) =>
        prisma.procurementLine.update({
          where: { id: u.lineId },
          data: {
            powderBrandId: u.to.powderBrandId,
            powderColorCode: u.to.powderColorCode,
            powderColor: u.to.powderColor,
            ...(u.to.colorPicks ? { colorPicks: u.to.colorPicks as unknown as object } : {}),
          },
        }),
      ),
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
            offChart: result.offChart ?? [],
          } as object,
        },
      }),
    ]);
  }
  return result;
}
