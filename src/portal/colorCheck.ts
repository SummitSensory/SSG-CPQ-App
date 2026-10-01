import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { NotFoundError } from '../lib/errors.js';
import { UNASSIGNED } from '../handoff/bomSections.js';
import { buildBomModel, type BomModel } from '../handoff/bomDocuments.js';
import { manufacturingBoardId } from '../integrations/monday/portalDelivery.js';
import { MFG_PORTAL_COL } from './orderPortal.js';
import {
  areaLabel,
  colorAreasOf,
  loadColorPlanInput,
  planColorApplication,
  resolvePowderBrand,
  type ColorAreaPick,
  type ColorPlanLine,
  type ManagedBrand,
  type MappedPartRef,
  type PowderChartColor,
} from './colorAreas.js';
import type { ResolvedColorSpec } from '../vendorColors/service.js';

/**
 * The colour check: does every colour the customer picked land in the right place on
 * the Bill of Materials?
 *
 * Read-only. For each area the customer answered it traces the whole path:
 *
 *   monday column (board / item / column id / JSON key)
 *     → the customer's pick (brand + code)
 *     → the parts mapped to that area (Administration → Portal colour areas)
 *     → each matching procurement line, and the colour a review would write on it
 *     → the vendor's printed BOM: the Powder color column, on that part's row.
 *
 * "Expected" comes from planColorApplication — the same function a review runs — so
 * the check cannot pass on a rule the real apply does not follow. "On the BOM" comes
 * from buildBomModel, the model the PDF, Excel and CSV are all rendered from, so it
 * is what the vendor actually reads.
 */

/** Where the colour answers are read from on monday. */
export const COLOR_ANSWERS_SOURCE = {
  columnId: MFG_PORTAL_COL.COLOR.answers ?? '',
  columnTitle: 'Portal: Color Selection Answers (JSON)',
} as const;

/** Frame paint (a managed powder brand), vinyl, or another material (plastic…). */
export type ColorKind = 'FRAME' | 'VINYL' | 'OTHER';

export type ColorCheckStatus =
  /** The line and the printed BOM both carry the expected colour. */
  | 'OK'
  /** The line carries a different colour (or none) from what the pick should give. */
  | 'MISMATCH'
  /** The line is right, but the vendor's printed sheet does not show it on that part's row. */
  | 'NOT_ON_BOM';

export interface ColorCheckLine {
  lineId: string;
  vendor: string;
  sku: string;
  name: string;
  /** What the customer's pick should put on this line. */
  expected: string;
  /** What the procurement line carries now. */
  onLine: string | null;
  /** What the vendor's printed BOM shows for this part, or null if no such cell. */
  onBom: string | null;
  /** Whether the vendor's sheet prints the Powder color column at all. */
  columnShown: boolean;
  /** The vendor's sheet is submitted, so a review would not change it. */
  vendorSubmitted: boolean;
  status: ColorCheckStatus;
}

export interface ColorCheckArea {
  areaKey: string;
  label: string;
  kind: ColorKind;
  pick: { brand: string; code: string };
  /** Exactly where on monday this pick was read. */
  source: { boardId: string; itemId: string | null; columnId: string; path: string };
  /** The part numbers (or patterns) mapped to this area, with any piece. */
  mappedParts: string[];
  lines: ColorCheckLine[];
  /** Why some or all of this area could not be placed. */
  issues: string[];
}

export interface ColorCheckReport {
  orderId: string;
  source: {
    boardId: string;
    itemId: string | null;
    columnId: string;
    columnTitle: string;
  };
  portal: {
    /** Whether colour answers have been read from monday for this order. */
    found: boolean;
    state: string | null;
    /** Whether staff have reviewed this version of the answers (which is what applies them). */
    reviewed: boolean;
    lastSyncedAt: string | null;
  };
  areas: ColorCheckArea[];
  /** Lines carrying a colour no portal area accounts for — set by hand on the BOM. */
  handSet: Array<{ vendor: string; sku: string; name: string; onLine: string }>;
  /** Vendor sheets that could not be built, with why. */
  bomErrors: string[];
  summary: { ok: number; problems: number; areas: number };
}

/** The Powder color cells of one vendor's printed sheet, by part number. */
export interface BomColorCells {
  columnShown: boolean;
  /** Upper-cased Part # → every Powder color cell printed on a row with that part. */
  byPart: Map<string, string[]>;
}

const POWDER_HEADER = 'Powder color';
const vendorOf = (v: string | null) => (v && v.trim()) || UNASSIGNED;
const norm = (v: string | null | undefined) => (v ?? '').trim().replace(/\s+/g, ' ');

/** The Powder color cells from a built BOM model. Pure; exported for tests. */
export function bomColorCells(model: Pick<BomModel, 'columns' | 'groups'>): BomColorCells {
  const colIdx = model.columns.indexOf(POWDER_HEADER);
  const partIdx = model.columns.indexOf('Part #');
  const byPart = new Map<string, string[]>();
  if (colIdx < 0 || partIdx < 0) return { columnShown: colIdx >= 0, byPart };
  for (const g of model.groups) {
    for (const row of g.rows) {
      const part = norm(row[partIdx]?.text).toUpperCase();
      if (!part) continue;
      const list = byPart.get(part) ?? [];
      list.push(norm(row[colIdx]?.text));
      byPart.set(part, list);
    }
  }
  return { columnShown: true, byPart };
}

export function colorKindOf(brand: string, brands: readonly ManagedBrand[]): ColorKind {
  if (resolvePowderBrand(brand, brands)) return 'FRAME';
  return brand.trim().toLowerCase() === 'vinyl' ? 'VINYL' : 'OTHER';
}

const describeRef = (r: MappedPartRef) => (r.piece != null ? `${r.sku} (piece ${r.piece})` : r.sku);

/**
 * The check itself, with no database: picks + mapping + lines + the printed cells.
 *
 * Expected colours are planned against the lines with their colours BLANKED and no
 * vendor frozen, so every line an area reaches gets an expected value — including
 * one that already carries it (which the real apply would skip as current) and one
 * on a submitted sheet (which the real apply would leave alone, and which is exactly
 * where a wrong colour is most expensive).
 */
export function buildColorCheck(input: {
  picks: readonly ColorAreaPick[];
  mapping: ReadonlyMap<string, readonly MappedPartRef[]>;
  lines: readonly ColorPlanLine[];
  specs?: ReadonlyMap<string, ResolvedColorSpec>;
  submittedVendors: ReadonlySet<string>;
  brands: readonly ManagedBrand[];
  chart: readonly PowderChartColor[];
  bom: ReadonlyMap<string, BomColorCells>;
  source: { boardId: string; itemId: string | null; columnId: string };
}): Pick<ColorCheckReport, 'areas' | 'handSet' | 'summary'> {
  const blank = input.lines.map((l) => ({
    ...l,
    powderBrandId: null,
    powderColorCode: null,
    powderColor: null,
    colorPicks: null,
  }));
  const { updates, result } = planColorApplication({
    picks: input.picks,
    mapping: input.mapping,
    lines: blank,
    specs: input.specs,
    submittedVendors: new Set<string>(),
    brands: input.brands,
    chart: input.chart,
  });
  const lineById = new Map(input.lines.map((l) => [l.id, l]));
  const claimed = new Set<string>();
  const conflictSkus = new Set((result.conflicts ?? []).map((c) => c.sku.toUpperCase()));

  const areas: ColorCheckArea[] = input.picks.map((pick) => {
    const refs = input.mapping.get(pick.areaKey) ?? [];
    const issues: string[] = [];
    if (result.unmappedAreas.includes(pick.areaKey)) {
      issues.push(
        'No parts are mapped to this area (Administration → Orders → Portal colour areas), so this colour goes nowhere on the BOM.',
      );
    }
    if (result.noMatchingLines.includes(pick.areaKey)) {
      issues.push(
        `None of the mapped parts (${refs.map(describeRef).join(', ')}) are on this order.`,
      );
    }
    for (const c of result.conflicts ?? []) {
      if (c.areas.some((a) => a.startsWith(`${pick.areaKey}:`))) {
        issues.push(
          `${c.sku} is claimed by more than one area with different colours (${c.areas.join('; ')}) — set it by hand.`,
        );
      }
    }
    for (const o of result.offChart ?? []) {
      if (o.startsWith(`${pick.areaKey}:`)) issues.push(`Not on the vendor chart — ${o}`);
    }

    const lines: ColorCheckLine[] = [];
    for (const u of updates) {
      if (!u.areaKey.split(', ').includes(pick.areaKey)) continue;
      const line = lineById.get(u.lineId);
      if (!line) continue;
      claimed.add(line.id);
      const vendor = vendorOf(line.vendor);
      const sku = norm(line.sku);
      const expected = norm(u.to.powderColor);
      const onLine = norm(line.powderColor) || null;
      const cells = input.bom.get(vendor);
      const printed = cells?.byPart.get(sku.toUpperCase()) ?? [];
      const onBom = printed.length ? (printed.find((t) => t === expected) ?? printed[0]!) : null;
      const status: ColorCheckStatus =
        onLine !== expected ? 'MISMATCH' : onBom === expected ? 'OK' : 'NOT_ON_BOM';
      lines.push({
        lineId: line.id,
        vendor,
        sku,
        name: line.name,
        expected,
        onLine,
        onBom,
        columnShown: cells?.columnShown ?? false,
        vendorSubmitted: input.submittedVendors.has(vendor),
        status,
      });
    }
    lines.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.sku.localeCompare(b.sku));

    return {
      areaKey: pick.areaKey,
      label: areaLabel(pick.areaKey),
      kind: colorKindOf(pick.brand, input.brands),
      pick: { brand: pick.brand, code: pick.code },
      source: { ...input.source, path: `selections.${pick.group}.${pick.area}` },
      mappedParts: refs.map(describeRef),
      lines,
      issues,
    };
  });

  // Lines in a conflict were reached by an area too — they are not "hand set".
  const handSet = input.lines
    .filter(
      (l) =>
        norm(l.powderColor) && !claimed.has(l.id) && !conflictSkus.has(norm(l.sku).toUpperCase()),
    )
    .map((l) => ({
      vendor: vendorOf(l.vendor),
      sku: norm(l.sku),
      name: l.name,
      onLine: norm(l.powderColor),
    }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.sku.localeCompare(b.sku));

  let ok = 0;
  let problems = 0;
  for (const a of areas) {
    problems += a.issues.length;
    for (const l of a.lines) {
      if (l.status === 'OK') ok++;
      else problems++;
    }
  }
  return { areas, handSet, summary: { ok, problems, areas: areas.length } };
}

/** Run the check for one order: load, build each vendor's sheet, compare. */
export async function checkOrderColors(orderId: string): Promise<ColorCheckReport> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order not found');

  const item = await prisma.orderPortalItem.findUnique({
    where: { orderId_kind: { orderId, kind: 'COLOR' } },
    select: {
      answers: true,
      state: true,
      contentHash: true,
      reviewedHash: true,
      sourceItemId: true,
      lastSyncedAt: true,
    },
  });
  const source = {
    boardId: manufacturingBoardId(),
    itemId: item?.sourceItemId ?? null,
    columnId: COLOR_ANSWERS_SOURCE.columnId,
  };
  const picks = colorAreasOf(item?.answers);
  const input = await loadColorPlanInput(orderId, picks);

  // Every vendor that has a coloured line or a line some area reaches.
  const vendors = new Set(input.lines.map((l) => vendorOf(l.vendor)));
  const bom = new Map<string, BomColorCells>();
  const bomErrors: string[] = [];
  for (const vendor of [...vendors].sort()) {
    try {
      bom.set(vendor, bomColorCells(await buildBomModel(orderId, vendor, {})));
    } catch (err) {
      logger.warn({ err, orderId, vendor }, 'color check: could not build the BOM');
      bomErrors.push(`${vendor}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const checked = buildColorCheck({ ...input, bom, source });
  return {
    orderId,
    source: { ...source, columnTitle: COLOR_ANSWERS_SOURCE.columnTitle },
    portal: {
      found: Boolean(item),
      state: item?.state ?? null,
      reviewed: Boolean(item?.contentHash && item.contentHash === item.reviewedHash),
      lastSyncedAt: item?.lastSyncedAt ? item.lastSyncedAt.toISOString() : null,
    },
    ...checked,
    bomErrors,
  };
}
