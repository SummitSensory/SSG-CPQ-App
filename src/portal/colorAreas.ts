import { ValidationError } from '../lib/errors.js';

/**
 * Portal colour areas → Bill of Materials lines.
 *
 * The portal answers colours by AREA, as
 *   { "selections": { "<group>": { "<area>": { "brand": "cardinal", "code": "T009-BL01" } } } }
 * e.g. structure_frame_paint.legs, adventure_mat.zip_line, slide.slide_color. The
 * Bill of Materials carries one colour per part line. PortalColorAreaMapping (kept
 * in Administration) says which catalog parts each area paints.
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
 * Apply a reviewed colour selection to the order's procurement lines through the
 * area mapping. Implemented with the Administration mapping screen.
 */
export async function applyColorPicksToOrder(
  orderId: string,
  answers: unknown,
  actorId: string,
): Promise<ColorApplyResult> {
  void orderId;
  void actorId;
  if (!colorAreasOf(answers).length) {
    return { linesUpdated: 0, unmappedAreas: [], noMatchingLines: [], skippedVendors: [] };
  }
  throw new ValidationError('Colour area mapping is not set up yet.');
}
