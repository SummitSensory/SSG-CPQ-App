/**
 * Summit Soar proposal engine — ported from the "Soar Series Build Logic" block of
 * the Product Line / Tier / Cost & Sourcing workbook (Products tab, rows 19-34).
 *
 * Soar is a catalogue pick, not a calculated frame. The rep chooses one of eight
 * mobile free-standing swing frames and optionally switches on the padding &
 * column-wrap package, whose five lines then carry the workbook's Default Qty
 * values. There is no beam calculator, no square-foot mat pricing and no hardware
 * roll-up — fasteners ship with the frame.
 *
 * All eight frames are K-40xx parts, so the overview + Engineering-of-Record copy
 * lands on every frame line and nowhere else.
 */

import skuData from './adventure-skus.json' with { type: 'json' };

export interface SoarSkuRec {
  part: string;
  description: string;
  unitPriceMinor: number;
  unitCostMinor?: number;
  weightLbs: number;
  category?: string;
}

const SKUS: Record<string, SoarSkuRec> = {};
for (const s of skuData as SoarSkuRec[]) SKUS[s.part] = s;

/** Tier-1 headers, straight from the workbook (sort 10 and 100). */
export const SOAR_GROUP_FRAMES = 'SUMMIT SOAR SERIES';
export const SOAR_GROUP_MATS = 'SUMMIT SOAR MATS & ACCESSORIES';

/**
 * The eight frames in workbook sort order. `xl` marks the 12'-wide models, which
 * take the wider CLM325 mat instead of the standard SSM80100.
 */
export const SOAR_FRAMES: Array<{ part: string; label: string; xl: boolean }> = [
  { part: 'K-4000', label: 'S1 — Single Cross Beam', xl: false },
  { part: 'K-4002', label: 'S2 — Two Cross Beams', xl: false },
  { part: 'K-4003', label: 'S3 — Three Cross Beams', xl: false },
  { part: 'K-4001', label: "S1-XL — Single Cross Beam (Width 12')", xl: true },
  { part: 'K-4006', label: "S2-XL — Two Cross Beams (Width 12')", xl: true },
  { part: 'K-4007', label: "S3-XL — Three Cross Beams (Width 12')", xl: true },
  { part: 'K-4004', label: "S1 — Single Cross Beam (Height 7')", xl: false },
  { part: 'K-4005', label: "S2 — Single Cross Beam (Height 7')", xl: false },
];

export const SOAR_PARTS = {
  matXl: 'CLM325',
  matStd: 'SSM80100',
  uWrap: 'COLU2812',
  gusset: 'SFGPC',
  colWrap: 'COLW2812',
} as const;

/**
 * The padding package, in workbook row order with its Default Qty. The two mats are
 * mutually exclusive — the frame selection decides which one is quoted, which is the
 * "Auto Calculate Based on B29 Answer" note beside CLM325.
 */
export const SOAR_PAD_ROWS: Array<{
  key: string;
  part: string;
  defaultQty: number;
  matFor?: 'xl' | 'std';
}> = [
  { key: 'matXlQty', part: SOAR_PARTS.matXl, defaultQty: 0, matFor: 'xl' },
  { key: 'matStdQty', part: SOAR_PARTS.matStd, defaultQty: 1, matFor: 'std' },
  { key: 'uWrapQty', part: SOAR_PARTS.uWrap, defaultQty: 4 },
  { key: 'gussetQty', part: SOAR_PARTS.gusset, defaultQty: 2 },
  { key: 'colWrapQty', part: SOAR_PARTS.colWrap, defaultQty: 2 },
];

export interface SoarAnswers {
  /** One entry per frame quoted, keyed by SKU. A proposal may carry several models. */
  frames?: Array<{ part: string; qty: number }>;
  /** The padding & column-wrap package (workbook B29 "Quick Select"). */
  padding?: boolean;
  /** Package overrides. Undefined means "use the workbook default". */
  matXlQty?: number;
  matStdQty?: number;
  uWrapQty?: number;
  gussetQty?: number;
  colWrapQty?: number;
  /** Print the overview + Engineering-of-Record copy on each frame line. */
  includeOverview?: boolean;
}

export interface SoarPricedLine {
  lineType: 'GROUP' | 'SUBGROUP' | 'PRODUCT' | 'NOTE';
  optional?: boolean;
  name: string;
  sku?: string;
  description?: string;
  quantity?: number;
  rateMinor?: number;
  costEach?: number;
  weightEach?: number;
  needsPrice?: boolean;
}

const n = (v: unknown) => (typeof v === 'number' && isFinite(v) ? Math.max(0, v) : 0);

/**
 * The Engineering-of-Record claim. It closes the frame description on every Soar
 * frame line: architects and general contractors read the proposal as a submittal,
 * so the stamped-design language belongs on the product itself, not in a footnote.
 */
export const SOAR_ENGINEERING =
  'ENGINEERED AND CERTIFIED — ENGINEER OF RECORD: The Summit Soar Series: Mobile Free-Standing Swing Frame is the only ' +
  'free-standing therapeutic swing frame on the market that carries an Engineer of Record. The structure is designed and ' +
  'load-analyzed by a licensed professional engineer, sealed against recognized structural design standards, and every ' +
  'unit is fabricated to that stamped drawing set. Specifiers, architects and building officials receive documented proof ' +
  'of design intent, rated load capacity and material strength \u2014 verified engineering, not a manufacturer\u2019s claim \u2014 so ' +
  'the frame can be reviewed, submitted and approved like any other engineered building component.';

export const SOAR_OVERVIEW =
  'The Summit Soar Series Sensory Swing Frame is a freestanding therapeutic swing frame that is perfect for indoor use. ' +
  'It is designed specifically for multisensory gyms that have low ceilings or are smaller in size. The compact swing ' +
  'frame is constructed of durable and non-corrosive powder-coated steel with safety padding on the uprights and bases. ' +
  'It can support up to 1,500 lbs. and accommodates a variety of therapy swings, including linear and rotational as well ' +
  'as single and double point swings. Note that the mat and swings are not included.\n\n' +
  'Ideal for smaller rooms and rooms with lower ceilings, the Summit Soar Series provides more than 35 various connection ' +
  'points for a wide variety of therapy swings to be used within the structure. The eyebolts are included for attaching ' +
  'therapy swings, including high back, platform, strap, wheel, and cuddle swings. The Summit Soar can be used in sensory ' +
  'gyms, special ed classrooms, and homes.\n\n' +
  'Occupational therapists use the Summit Soar to administer vestibular, neuro-developmental, and sensory integration ' +
  'swing therapy to clients with ADHD, Autism, and other Sensory Processing Disorders. The Summit Soar Sensory Swing ' +
  'Frame is a responsive, reliable, and transparent partner that stands out from the competition.\n\n' +
  SOAR_ENGINEERING;

/** Frames actually quoted, de-duplicated and returned in workbook order. */
export function soarFrames(
  a: SoarAnswers,
): Array<{ part: string; label: string; xl: boolean; qty: number }> {
  const want = new Map<string, number>();
  for (const f of a.frames || []) {
    const qty = n(f && f.qty);
    if (!f || !f.part || qty <= 0) continue;
    want.set(f.part, (want.get(f.part) || 0) + qty);
  }
  return SOAR_FRAMES.filter((f) => (want.get(f.part) || 0) > 0).map((f) => ({
    ...f,
    qty: want.get(f.part) as number,
  }));
}

/** Total frame units — what the padding package scales off. */
export function soarFrameUnits(a: SoarAnswers): number {
  return soarFrames(a).reduce((s, f) => s + f.qty, 0);
}

/**
 * Padding quantities for the current frame selection: the workbook default × the
 * number of frames, with the mat rows routed by frame width.
 */
export function soarPadDefaults(a: SoarAnswers): Record<string, number> {
  const fr = soarFrames(a);
  const xl = fr.filter((f) => f.xl).reduce((s, f) => s + f.qty, 0);
  const std = fr.filter((f) => !f.xl).reduce((s, f) => s + f.qty, 0);
  const units = xl + std || 1;
  const out: Record<string, number> = {};
  for (const row of SOAR_PAD_ROWS) {
    if (row.matFor === 'xl') out[row.key] = xl;
    else if (row.matFor === 'std') out[row.key] = std;
    else out[row.key] = row.defaultQty * units;
  }
  return out;
}

/** Model label for the proposal heading — the frame models quoted. */
export function soarModel(a: SoarAnswers): string {
  const fr = soarFrames(a);
  if (!fr.length) return 'Summit Soar Series';
  return fr.map((f) => (f.qty > 1 ? `${f.qty}\u00d7 ${f.part}` : f.part)).join(' + ');
}

/** Full priced, grouped proposal-line output for the Soar builder. */
export function computeSoarProposal(
  a: SoarAnswers,
  skuMap?: Record<string, SoarSkuRec>,
): { lines: SoarPricedLine[]; totalWeightLbs: number; model: string } {
  const LOOK = skuMap && Object.keys(skuMap).length ? skuMap : SKUS;
  const lines: SoarPricedLine[] = [];
  let weight = 0;
  const P = (part: string, qty: number, description = ''): void => {
    if (n(qty) <= 0) return;
    const rec = LOOK[part];
    const w = rec ? rec.weightLbs || 0 : 0;
    weight += qty * w;
    lines.push({
      lineType: 'PRODUCT',
      name: rec ? rec.description : part,
      sku: part,
      description,
      quantity: qty,
      rateMinor: rec ? rec.unitPriceMinor : 0,
      costEach: rec ? (rec.unitCostMinor ?? 0) : 0,
      weightEach: w,
      needsPrice: !rec,
    });
  };

  // Product-line heading, then the frames. The overview + Engineering-of-Record copy
  // rides on each frame line's own description so it travels with the product
  // through reordering and export instead of sitting in a detachable note.
  const overview = a.includeOverview !== false ? SOAR_OVERVIEW : '';
  lines.push({
    lineType: 'GROUP',
    name: SOAR_GROUP_FRAMES,
    description: `${soarModel(a)} \u00b7 Project Scope`,
  });
  for (const f of soarFrames(a)) P(f.part, f.qty, overview);

  if (a.padding) {
    const defs = soarPadDefaults(a);
    const rows = SOAR_PAD_ROWS.map((r) => {
      const override = (a as Record<string, number | undefined>)[r.key];
      return { part: r.part, qty: override == null ? (defs[r.key] ?? 0) : n(override) };
    }).filter((r) => r.qty > 0);
    if (rows.length) {
      lines.push({
        lineType: 'GROUP',
        name: SOAR_GROUP_MATS,
        optional: true,
        description: 'Optional',
      });
      for (const r of rows) P(r.part, r.qty);
    }
  }

  return { lines, totalWeightLbs: Math.round(weight * 100) / 100, model: soarModel(a) };
}
