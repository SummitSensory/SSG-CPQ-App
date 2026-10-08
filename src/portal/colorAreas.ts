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
  /**
   * Lines left as they were because they already carry a colour that differs from the
   * pick, and the pick gave no reason to replace it: on a re-review the customer did
   * not change that area (so the difference is a staff correction made since), and a
   * "re-apply reviewed colours" only ever fills blank lines.
   */
  keptStaffEdits?: string[];
  /**
   * Lines whose colour was CLEARED because, on a re-review, areas that changed now
   * disagree about them. Leaving the old colour would print a colour the customer has
   * since superseded; a blank line is caught by the colour check, a stale colour is not.
   */
  clearedLines?: string[];
  /** Areas answered at the last review that the customer no longer answers. */
  droppedAreas?: string[];
  /**
   * The step is ✅ on monday but carries no colour picks at all (Jotform, or a staff
   * "mark complete"). Nothing could be applied, and this says why.
   */
  markedCompleteWithoutColors?: boolean;
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

/**
 * Whether colour answers are the portal's UNCONFIRMED draft: the portal's snapshot
 * ({ selections, totalUpcharge, confirmedAt }) autosaves with `confirmedAt: null`
 * while the customer is still picking, and sets it only on Confirm
 * (Customer-Portal pages/api/portal/color-selection.js — the key has been in every
 * snapshot since the portal's first colour release). A ✅ beside a draft (a staff
 * "mark complete", Jotform) does not make the draft final.
 *
 * Conservative on shape: only a snapshot that HAS the key with a blank value is a
 * draft. Answers without the key (an older or foreign shape) are read as before.
 */
export function isUnconfirmedDraft(answers: unknown): boolean {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  const a = answers as Record<string, unknown>;
  if (!('selections' in a) || !('confirmedAt' in a)) return false;
  const c = a.confirmedAt;
  return c === null || (typeof c === 'string' && !c.trim());
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
  /**
   * The chart's own name, also matched against the powder brand. The Cardinal and
   * Prismatic charts are kept under the powder coater (Goldberg Brothers) as palettes
   * named for the brand, because the brand is not a vendor anyone orders from.
   */
  palette?: string;
  vendorCode: string;
  name: string;
}

/**
 * Powder-coat chart colours, optionally only those with the given codes. The one
 * place the chart is read, so the portal review, the BOM's apply-colour tool and a
 * line edited by hand all print a colour the same way.
 */
export async function loadPowderChart(codes?: readonly string[]): Promise<PowderChartColor[]> {
  const wanted = codes?.map((c) => c.trim()).filter(Boolean);
  if (codes && !wanted?.length) return [];
  // Read palette-first, and the owners' names separately: a colour row whose palette
  // is deleted between two reads then simply drops out, rather than failing the whole
  // review on a required relation that came back empty.
  const palettes = await prisma.vendorColorPalette.findMany({
    // A retired palette does not name colours: an inactive chart must not print as if
    // it were the current one.
    where: { finishType: 'POWDER_COAT', active: true },
    select: {
      name: true,
      manufacturerId: true,
      colors: {
        where: { vendorCode: wanted ? { in: wanted, mode: 'insensitive' } : { not: null } },
        select: { name: true, vendorCode: true },
      },
    },
  });
  const withColors = palettes.filter((p) => p.colors.length);
  if (!withColors.length) return [];
  const owners = await prisma.manufacturer.findMany({
    where: { id: { in: [...new Set(withColors.map((p) => p.manufacturerId))] } },
    select: { id: true, name: true },
  });
  const ownerName = new Map(owners.map((m) => [m.id, m.name]));
  return withColors.flatMap((p) =>
    p.colors.map((c) => ({
      vendor: ownerName.get(p.manufacturerId) ?? '',
      palette: p.name,
      vendorCode: c.vendorCode ?? '',
      name: c.name,
    })),
  );
}

/**
 * The printed text for a powder brand + code — "Cardinal Blue Hammer T013-BL468" when
 * the brand's chart has the code, else "Cardinal T013-BL468". Null when both are blank.
 */
export async function powderColorText(
  brandName: string | null | undefined,
  code: string | null | undefined,
): Promise<string | null> {
  const b = (brandName ?? '').trim();
  const c = (code ?? '').trim();
  if (!b) return c || null;
  const chart = c ? await loadPowderChart([c]) : [];
  return lineColorFor({ brand: b, code: c }, [{ id: '', name: b }], chart).powderColor;
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
      (x) =>
        (x.vendor.trim().toLowerCase() === b || (x.palette ?? '').trim().toLowerCase() === b) &&
        x.vendorCode.trim().toLowerCase() === c,
    );
    // A chart that repeats a name gives each copy its code — Cardinal has two "Blue 90
    // Gloss", stored as "Blue 90 Gloss (T009-BL05)". The code prints after the name
    // anyway, so the bracketed copy is dropped rather than printed twice.
    const bare = named
      ? named.name
          .trim()
          .replace(/\s*\(([^()]*)\)$/, (m, inner: string) =>
            inner.trim().toLowerCase() === c ? '' : m,
          )
      : '';
    const name = bare && bare.toLowerCase() !== c ? bare : '';
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

/**
 * Why a frame-paint pick is not on its brand's chart, or null when it is (or when it
 * is not a managed powder brand, or the brand has no chart loaded to check against —
 * then there is nothing to say). The pick is still applied as given: the portal
 * normally blocks off-chart codes, and the code is what the coater orders by, so this
 * is a warning to look, not a reason to leave the frame unpainted.
 */
export function powderOffChart(
  pick: Pick<ColorAreaPick, 'areaKey' | 'brand' | 'code'>,
  managed: readonly ManagedBrand[],
  chart: readonly PowderChartColor[],
): string | null {
  const brand = resolvePowderBrand(pick.brand, managed);
  if (!brand) return null;
  const b = brand.name.trim().toLowerCase();
  const ofBrand = chart.filter(
    (x) => x.vendor.trim().toLowerCase() === b || (x.palette ?? '').trim().toLowerCase() === b,
  );
  if (!ofBrand.length) return null;
  const c = pick.code.trim().toLowerCase();
  if (ofBrand.some((x) => x.vendorCode.trim().toLowerCase() === c)) return null;
  return `${pick.areaKey}: ${[pick.brand, pick.code].filter(Boolean).join(' ')} — not on the ${brand.name} chart`;
}

/** Whether a line carries no colour at all. */
export function isBlankColor(c: LineColor): boolean {
  return (
    !(c.powderColor ?? '').trim() &&
    !(c.powderColorCode ?? '').trim() &&
    !c.powderBrandId &&
    !(c.colorPicks ?? []).length
  );
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
 *   - A line whose every claiming area is in `unchangedAreas` (the customer gave the
 *     same pick at the last review), or any line when `onlyBlank` is set, is only
 *     FILLED when blank. A differing colour already on it is a staff correction made
 *     since, and is kept (keptStaffEdits).
 *   - With `clearNewConflicts` (a re-review), a conflict involving an area that
 *     changed clears the line's old colour (clearedLines) rather than leaving a colour
 *     the customer has since superseded on the vendor sheet.
 *   - A frame-paint code not on its brand's chart is applied as given and reported
 *     (offChart).
 *
 * Area keys match case-insensitively: the portal writes them lower-case, and a key an
 * admin saved in another case still means the same area.
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
  /** Area keys whose pick is the same as at the last review. */
  unchangedAreas?: ReadonlySet<string>;
  /** Only ever fill blank lines (the "re-apply reviewed colours" action). */
  onlyBlank?: boolean;
  /** A re-review: a conflict that involves a changed area clears the line. */
  clearNewConflicts?: boolean;
}): ColorPlan {
  const { picks, lines, submittedVendors, brands, chart } = input;
  const mapping = new Map<string, MappingEntry[]>();
  for (const [k, v] of input.mapping) {
    const key = k.trim().toLowerCase();
    mapping.set(key, [...(mapping.get(key) ?? []), ...v]);
  }
  const unchanged = new Set([...(input.unchangedAreas ?? [])].map((k) => k.trim().toLowerCase()));
  const fillOnly = (list: readonly ColorAreaPick[]) =>
    input.onlyBlank === true ||
    (list.length > 0 && list.every((p) => unchanged.has(p.areaKey.toLowerCase())));
  const specs = input.specs ?? new Map<string, ResolvedColorSpec>();
  const offChart: string[] = [];
  const kept: string[] = [];
  const cleared: string[] = [];
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
  const claims = new Map<
    string,
    { line: PlanLine; picks: ColorAreaPick[]; claims: Claim[]; ambiguous: boolean }
  >();
  for (const pick of picks) {
    const off = powderOffChart(pick, brands, chart);
    if (off) offChart.push(off);
    const refs = (mapping.get(pick.areaKey.trim().toLowerCase()) ?? []).map(toRef);
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
        const c = claims.get(line.id) ?? { line, picks: [], claims: [], ambiguous: false };
        const prior = c.claims.find((x) => x.pick.areaKey === pick.areaKey);
        if (!prior) {
          c.picks.push(pick);
          c.claims.push({ pick, piece: ref.piece });
        } else if ((prior.piece ?? null) !== (ref.piece ?? null)) {
          // One area mapped twice onto the same line (say an exact part and a
          // pattern) with different pieces: which piece it means is a guess.
          c.ambiguous = true;
        }
        claims.set(line.id, c);
      }
    }
    if (!matched) result.noMatchingLines.push(pick.areaKey);
  }

  const skipped = new Set<string>();
  const conflictBySku = new Map<string, Set<string>>();
  const updates: ColorPlanUpdate[] = [];
  for (const { line, picks: linePicks, claims: lineClaims, ambiguous } of claims.values()) {
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
    const areasOf = (list: readonly ColorAreaPick[]) =>
      [...new Set(list.map((p) => p.areaKey))].sort().join(', ');
    // A conflict leaves the line alone — except on a re-review where a CHANGED area
    // is part of it: then the colour on the line is the superseded one, and printing
    // it would read as the customer's instruction. Clear it and say so.
    const conflict = (list: readonly ColorAreaPick[]) => {
      addConflict(list);
      if (input.clearNewConflicts && !fillOnly(list) && !isBlankColor(from)) {
        updates.push({
          lineId: line.id,
          sku,
          areaKey: areasOf(list),
          from,
          to: {
            powderBrandId: null,
            powderColorCode: null,
            powderColor: null,
            ...((from.colorPicks ?? []).length ? { colorPicks: [] } : {}),
          },
        });
        cleared.push(
          `${sku}: cleared "${from.powderColor ?? ''}" — ${areasOf(list)} now ask for different colours`,
        );
      }
    };
    // Write `to` unless it is already there, or the line may only be filled and is not
    // blank (a staff correction, kept).
    const propose = (to: LineColor, list: readonly ColorAreaPick[], areaKey: string) => {
      if (sameColor(from, to)) {
        result.linesAlreadyCurrent = (result.linesAlreadyCurrent ?? 0) + 1;
        return;
      }
      if (fillOnly(list) && !isBlankColor(from)) {
        kept.push(
          `${sku} (${areaKey}): kept "${from.powderColor ?? ''}" — the reviewed pick would be "${to.powderColor ?? ''}"`,
        );
        return;
      }
      updates.push({ lineId: line.id, sku, areaKey, from, to });
    };

    // A multi-piece part: each area colours one piece. Only two DIFFERENT picks for
    // the SAME piece conflict — or an area colouring the whole part alongside areas
    // colouring its pieces, which is ambiguous.
    if (ambiguous) {
      conflict(linePicks);
      continue;
    }

    if (lineClaims.some((c) => c.piece != null)) {
      if (lineClaims.some((c) => c.piece == null)) {
        conflict(linePicks);
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
        conflict(clashing.flat());
        continue;
      }

      const spec = specs.get(line.id);
      let to: LineColor;
      if (spec) {
        // Slots of the part's colour spec, the customer's colour found on its vendor
        // chart — by NAME first, then by vendor code, so a name never loses to another
        // colour whose code happens to spell it. Slots nobody answered keep what they
        // had, but only picks that still fit the current spec: a slot beyond its
        // slotCount, or a colour no longer on its chart, is dropped (and said so)
        // rather than printed on a vendor sheet from an old spec.
        const onChart = new Set(spec.colors.map((c) => c.id));
        const bySlot = new Map<number, ColorPick>();
        const stale: string[] = [];
        for (const pk of from.colorPicks ?? []) {
          if (pk.slot >= 1 && pk.slot <= spec.slotCount && onChart.has(pk.colorId))
            bySlot.set(pk.slot, pk);
          else
            stale.push(`${sku}: ${pk.name} in slot ${pk.slot} is not on the current colour spec`);
        }
        let unresolved = false;
        for (const [slot, list] of byPiece) {
          const pick = list[0]!;
          // A piece whose area the customer did not change keeps what the line has
          // (a staff correction made since the last review).
          if (unchanged.has(pick.areaKey.toLowerCase()) && bySlot.has(slot)) continue;
          const code = pick.code.trim().toLowerCase();
          const inRange = slot >= 1 && slot <= spec.slotCount;
          const color = inRange
            ? (spec.colors.find((c) => c.name.trim().toLowerCase() === code) ??
              spec.colors.find((c) => (c.vendorCode ?? '').trim().toLowerCase() === code))
            : undefined;
          if (!color) {
            unresolved = true;
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
        // A piece the chart can't resolve leaves the WHOLE line untouched. Writing the
        // rest would either drop that piece from the line's colour text or keep its
        // previous colour printed as if the customer had chosen it — both read as a
        // final instruction on a vendor sheet. Staff set it by hand from the report.
        if (unresolved) continue;
        offChart.push(...stale);
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
      propose(
        to,
        lineClaims.map((c) => c.pick),
        lineClaims
          .map((c) => c.pick.areaKey)
          .sort()
          .join(', '),
      );
      continue;
    }

    const distinct = new Set(linePicks.map(pickSig));
    if (distinct.size > 1) {
      conflict(linePicks);
      continue;
    }
    const pick = linePicks[0]!;
    const to: LineColor = {
      ...lineColorFor(pick, brands, chart),
      // A whole-part colour replaces any per-slot picks the line carried, so the
      // line never says one thing in its colour text and another in its slots.
      ...((from.colorPicks ?? []).length ? { colorPicks: [] } : {}),
    };
    propose(to, linePicks, pick.areaKey);
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
  result.offChart = [...new Set(offChart)];
  result.keptStaffEdits = kept;
  result.clearedLines = cleared;
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
 *
 * On a RE-review (`reReview`), only areas the customer changed overwrite. When the
 * answers that were last reviewed are known (`previousAnswers`), an area whose pick is
 * the same as then only fills blank lines — a different colour on its line is a staff
 * correction made since, and survives. When they are not known (a review recorded
 * before the answers were kept), every area counts as changed, as before.
 *
 * `onlyBlank` is the "re-apply reviewed colours" action: fill blank lines only.
 */
export async function applyColorPicksToOrder(
  orderId: string,
  answers: unknown,
  actorId: string,
  opts: {
    reReview?: boolean;
    /** The answers of the last review, or undefined when not known. */
    previousAnswers?: unknown;
    onlyBlank?: boolean;
    /** The order event recording the change. */
    eventAction?: string;
  } = {},
): Promise<ColorApplyResult> {
  const picks = colorAreasOf(answers);
  const previous = opts.previousAnswers === undefined ? null : colorAreasOf(opts.previousAnswers);
  const keyOf = (p: ColorAreaPick) => p.areaKey.trim().toLowerCase();
  const nowKeys = new Set(picks.map(keyOf));
  const droppedAreas = previous
    ? previous.filter((p) => !nowKeys.has(keyOf(p))).map((p) => p.areaKey)
    : [];
  if (!picks.length) {
    return {
      linesUpdated: 0,
      unmappedAreas: [],
      noMatchingLines: [],
      skippedVendors: [],
      conflicts: [],
      linesAlreadyCurrent: 0,
      ...(droppedAreas.length ? { droppedAreas } : {}),
      // ✅ with nothing in it: say so rather than report a silent "nothing changed".
      markedCompleteWithoutColors: true,
    };
  }

  const prevSig = new Map((previous ?? []).map((p) => [keyOf(p), pickSig(p)]));
  const unchangedAreas = new Set(
    picks.filter((p) => prevSig.get(keyOf(p)) === pickSig(p)).map(keyOf),
  );
  const { updates, result } = planColorApplication({
    ...(await loadColorPlanInput(orderId, picks)),
    unchangedAreas,
    onlyBlank: opts.onlyBlank === true,
    clearNewConflicts: opts.reReview === true && opts.onlyBlank !== true,
  });
  if (droppedAreas.length) result.droppedAreas = droppedAreas;

  if (updates.length) {
    await prisma.$transaction([
      ...updates.map((u) =>
        prisma.procurementLine.update({
          where: { id: u.lineId },
          data: {
            powderBrandId: u.to.powderBrandId,
            powderColorCode: u.to.powderColorCode,
            powderColor: u.to.powderColor,
            ...(u.to.colorPicks !== undefined
              ? { colorPicks: u.to.colorPicks as unknown as object }
              : {}),
          },
        }),
      ),
      prisma.orderEvent.create({
        data: {
          orderId,
          action: opts.eventAction ?? 'bom.colors.portal-review',
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
            keptStaffEdits: result.keptStaffEdits ?? [],
            clearedLines: result.clearedLines ?? [],
            droppedAreas: result.droppedAreas ?? [],
          } as object,
        },
      }),
    ]);
  }
  return result;
}

/** A procurement line as the planner and the colour check read it. */
export type ColorPlanLine = PlanLine & { name: string };

/**
 * Everything planColorApplication needs for one order's picks, read from the
 * database: the area mapping, the order's lines, submitted vendors, managed powder
 * brands, powder charts and (for multi-piece parts) colour specs. Shared by the
 * write above and the read-only colour check (colorCheck.ts), so the check tests
 * exactly what a review would do.
 */
export async function loadColorPlanInput(
  orderId: string,
  picks: readonly ColorAreaPick[],
): Promise<{
  picks: readonly ColorAreaPick[];
  mapping: Map<string, MappedPartRef[]>;
  lines: ColorPlanLine[];
  specs: Map<string, ResolvedColorSpec>;
  submittedVendors: Set<string>;
  brands: ManagedBrand[];
  chart: PowderChartColor[];
}> {
  const [mappings, lines, sections, brands, chart] = await Promise.all([
    prisma.portalColorAreaMapping.findMany({
      // Case-insensitive: a key saved in another case still names the same area.
      where: {
        areaKey: { in: [...new Set(picks.map((p) => p.areaKey))], mode: 'insensitive' },
      },
      select: { areaKey: true, sku: true, piece: true },
      orderBy: [{ areaKey: 'asc' }, { sku: 'asc' }],
    }),
    prisma.procurementLine.findMany({
      where: { orderId },
      select: {
        id: true,
        productId: true,
        colorPicks: true,
        sku: true,
        name: true,
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
    loadPowderChart(),
  ]);

  const mapping = new Map<string, MappedPartRef[]>();
  for (const m of mappings) {
    const key = m.areaKey.trim().toLowerCase();
    const list = mapping.get(key) ?? [];
    list.push({ sku: m.sku, piece: m.piece ?? null });
    mapping.set(key, list);
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
  return {
    picks,
    mapping,
    lines,
    specs,
    submittedVendors: new Set(sections.map((s) => vendorOf(s.vendor))),
    brands,
    chart,
  };
}
