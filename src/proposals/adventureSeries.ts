import skuData from './adventure-skus.json' with { type: 'json' };
import {
  evaluateHardwareRules, evaluateRules, DEFAULT_HARDWARE_RULES,
  type HardwareRule, type HardwareBomRow, type FormulaRule,
} from './hardwareRules.js';
import { DEFAULT_FRAME_RULES, frameContext } from './frameRules.js';
import { computeFloorPadding, type MatQuote, type MatThickness } from './matPricing.js';

export interface SkuRec { part: string; description: string; unitPriceMinor: number; unitCostMinor?: number; weightLbs: number; category: string; }
const SKUS: Record<string, SkuRec> = {};
for (const s of skuData as SkuRec[]) SKUS[s.part] = s;

export interface AdvAnswers {
  length: number; width: number; config: string; legs: number; ladders: number;
  monkeyBars?: boolean; monkeyBarsQty?: number; interiorBeams?: boolean; interiorBeamsQty?: number;
  trolley?: boolean; trolleyType?: string; zipLine?: boolean; zipLineQty?: number; ballRack?: boolean;
  slide?: boolean; slideGray?: boolean; steamroller?: boolean;
  climbFrame?: boolean; climbWall?: boolean; climbShield?: boolean; climbMat?: boolean;
  matFloor?: boolean; matColumn?: boolean; uShaped?: number; completeWrap?: number; matLadderLeg?: boolean; matCustom?: boolean;
  /** Floor padding decision tree: include it, and at which thickness. */
  floorPadding?: boolean; floorPadThickness?: MatThickness;
  brackets?: boolean; bracketsQty?: number; swivel360?: number; swivelStandalone?: number; forged?: number; swingHanger?: number; vRings?: number; carabiner?: number; webbingSling?: number;
}

/**
 * Frame configuration product number, per "Frame Configuration Product Number
 * Identification": {SHAPE}-{beams}{MB}{L}{#ladders}{T}{Z}{R}  e.g. SQ-2MBL2TZR.
 * Segments are omitted when the option is not included.
 */
export function frameModelNumber(a: AdvAnswers): string {
  const shape = a.config === 'Square' ? 'SQ' : a.config === 'L-Shape' ? 'L' : a.config === 'T-Shape' ? 'T' : 'R';
  const beams = a.interiorBeams ? n(a.interiorBeamsQty) : 0;
  const ladders = n(a.ladders);
  let code = '';
  if (beams > 0) code += String(beams);
  if (a.monkeyBars) code += 'MB';
  if (ladders > 0) code += `L${ladders}`;
  if (a.trolley && (a.trolleyType ?? 'Dual') === 'Dual') code += 'T';
  if (a.zipLine) code += 'Z';
  if (a.ballRack) code += 'R';
  return `${shape}-${code}`;
}

/** Human-readable frame footprint, e.g. 10' × 10'. */
export function frameDimensions(a: AdvAnswers): string {
  return `${n(a.length)}' \u00d7 ${n(a.width)}'`;
}

export interface PricedLine {
  lineType: 'GROUP' | 'SUBGROUP' | 'PRODUCT' | 'NOTE';
  optional?: boolean; name: string; sku?: string; description?: string;
  quantity?: number; rateMinor?: number; costEach?: number; weightEach?: number; needsPrice?: boolean;
}

/** One BOM row with the expression that produced its quantity, for the logic trace. */
export interface BomRow { part: string; qty: number; formula: string; rule: string; }

const n = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);

/**
 * Floor padding priced from the frame footprint, or null when the answer is No.
 * `matFloor` is the legacy flag for the same option, so old answer sets still price.
 */
export function floorPaddingQuote(a: AdvAnswers): MatQuote | null {
  const on = a.floorPadding != null ? !!a.floorPadding : !!a.matFloor;
  if (!on) return null;
  return computeFloorPadding(n(a.length), n(a.width), a.floorPadThickness === '2' ? '2' : '3.25');
}

/** Catalog category whose members make up the zip line kit. */
export const ZIP_KIT_CATEGORY = 'Complete Zip Line Kit';

/**
 * Compute the full bill of materials for an Adventure Series frame, mirroring the
 * Excel beam calculator + Calcs tab. Frame-member counts for single-bay frames
 * (length & width 5–10 ft) match the workbook; multi-bay (>10 ft) is approximated
 * and flagged for validation.
 */
export function computeAdventureBOM(a: AdvAnswers, frameRules?: FormulaRule[]): BomRow[] {
  const out: BomRow[] = [];
  // Data-driven frame quantities (Administration → Formulas → Frame quantities).
  const evaluated = evaluateRules(frameRules && frameRules.length ? frameRules : DEFAULT_FRAME_RULES, frameContext(a, () => 0));
  for (const r of evaluated) {
    out.push({ part: r.part, qty: Math.round(r.qty), rule: r.group || 'Frame', formula: r.formula });
  }
  // Structural pieces that are a lookup rather than a coefficient stay in code.
  out.push(...beamMembers(a));
  out.push(...trolleyRail(a));
  return out;
}

/**
 * Beam members — an exact port of the VLOOKUP beam calculator: short caps are
 * chosen by frame WIDTH, long members by LENGTH, with per-leg-count additions and
 * the monkey-bar half-offset. A lookup table, not a multiplier, so it is not
 * expressible as an editable coefficient.
 */
function beamMembers(a: AdvAnswers): BomRow[] {
  const legs = n(a.legs), L = n(a.length), W = n(a.width);
  const monkey = !!a.monkeyBars;
  const interiorCount = a.interiorBeams ? n(a.interiorBeamsQty) : 0;
  const rows: BomRow[] = [];
  const add = (part: string, qty: number, rule: string, formula: string) => {
    if (qty > 0) rows.push({ part, qty: Math.round(qty), rule, formula });
  };
  const memLen: Record<string, number> = { 'P-2545': 5, 'P-2206': 6, 'P-2207': 7, 'A-2408': 8, 'A-2409': 9, 'A-2410': 10 };
  const monkeyMem: Record<number, string> = { 6: 'P-2216', 7: 'P-2217', 8: 'A-2418', 9: 'A-2419', 10: 'A-2420' };
  const shortCap = (part: string): number => {
    if (part === 'P-2206') return W === 6 ? 2 : 0;
    if (part === 'P-2207') return W === 7 ? 2 : 0;
    if (part === 'A-2408') return W === 8 ? 2 : 0;
    if (part === 'A-2409') return W === 9 ? 2 : 0;
    if (part === 'A-2410') return W === 10 ? 2 : 0;
    if (part === 'P-2545') return L === 7 ? 2 : 0; // per workbook (references length)
    return 0;
  };
  const e64 = shortCap('A-2408') + shortCap('A-2409') + shortCap('A-2410');
  const J2 = 4; // Horizontal Beams (perimeter top members for rect/square)
  const longBeam = (part: string): number => {
    if (part === 'P-2545') return 0;
    return L === memLen[part] ? (J2 - e64) : 0;
  };
  Object.keys(memLen).forEach((part) => {
    const len = memLen[part];
    const jj = shortCap(part) + longBeam(part);
    const kk = (legs === 6 && L === len && len >= 8) ? 3 : 0;
    const ll = (legs === 8 && L === len && len >= 8) ? 6 : 0;
    const nn = (L === len) ? interiorCount : 0;
    const mq = (monkey && L === len && monkeyMem[len]) ? 2 : 0;
    const oo = -0.5 * mq;
    add(part, jj + kk + ll + nn + oo, `Beam members (${len}')`,
      `short cap ${shortCap(part)} + long ${longBeam(part)} + 6-leg ${kk} + 8-leg ${ll} + interior ${nn} − monkey offset ${-oo} (W ${W}, L ${L})`);
    if (mq > 0) add(monkeyMem[len], mq, `Monkey bar beam (${len}')`, `monkey bars on a ${len}' run → 2`);
  });
  return rows;
}

/** Trolley rail part is sized from the frame length (a lookup, so it stays in code). */
function trolleyRail(a: AdvAnswers): BomRow[] {
  if (!a.trolley) return [];
  const L = n(a.length);
  const rail: Record<number, string> = { 7: 'TR2000-A07', 8: 'TR2000-A08', 9: 'TR2000-A09', 10: 'TR2000-A10' };
  return [{ part: rail[L - 1] || 'TR2000-A09', qty: 2, rule: 'Trolley', formula: `rail sized from length − 1 = ${L - 1}' → 2` }];
}

/** Full priced, grouped proposal-line output for the builder. */
export function computeAdventureProposal(
  a: AdvAnswers,
  skuMap?: Record<string, SkuRec>,
  rules?: HardwareRule[],
  frameRules?: FormulaRule[],
  /** Catalog category name → the part numbers filed under it, so a "kit" prints every member. */
  kitParts?: Record<string, string[]>,
): { lines: PricedLine[]; totalWeightLbs: number } {
  const LOOK = skuMap && Object.keys(skuMap).length ? skuMap : SKUS;
  const bom = computeAdventureBOM(a, frameRules);
  const qtyOf = (part: string) => (bom.find((b) => b.part === part) || { qty: 0 }).qty;
  const lines: PricedLine[] = [];
  let weight = 0;
  const P = (part: string, qtyOverride?: number, nameOverride?: string): void => {
    const rec = LOOK[part];
    const qty = qtyOverride != null ? qtyOverride : qtyOf(part);
    if (qty <= 0) return;
    const w = rec ? rec.weightLbs : 0;
    weight += qty * w;
    lines.push({
      lineType: 'PRODUCT', name: nameOverride || (rec ? rec.description : part), sku: part,
      description: '', quantity: qty, rateMinor: rec ? rec.unitPriceMinor : 0,
      costEach: rec ? (rec.unitCostMinor ?? 0) : 0, weightEach: w, needsPrice: !rec,
    });
  };
  const G = (name: string, optional = false, description = '') => lines.push({ lineType: 'GROUP', name, optional, description });
  const SG = (name: string) => lines.push({ lineType: 'SUBGROUP', name });
  const NOTE = (name: string, description: string) => lines.push({ lineType: 'NOTE', name, description });
  // Main itemized frame — heading carries the configuration product number; the
  // footprint sits beside it as the heading's right-hand note.
  G(`${frameModelNumber(a)} — Itemized`, false, `Frame Dimensions: ${frameDimensions(a)}`);
  ['A-2245', 'A-2246', 'A-2241', 'A-2242', 'A-2243', 'A-2244', 'A-2225', 'P-2531', 'A-2253',
    'P-2545', 'P-2206', 'P-2207', 'A-2408', 'A-2409', 'A-2410', 'P-2216', 'P-2217', 'A-2418', 'A-2419', 'A-2420',
    'P-2330', 'P-2028'].forEach((p) => P(p));

  // The zip line is part of the structure, so its kit sits inside the itemized
  // frame. Membership comes from the catalog category of the same name: every
  // ACTIVE part filed under it prints, not just the two the engine used to know.
  if (a.zipLine) {
    const zipLines = n(a.zipLineQty || 1);
    SG(ZIP_KIT_CATEGORY);
    const emitted = new Set<string>();
    ['P-2024', 'A-2530'].forEach((p) => { if (qtyOf(p) > 0) { P(p); emitted.add(p); } });
    for (const part of (kitParts && kitParts[ZIP_KIT_CATEGORY]) || []) {
      if (emitted.has(part)) continue;
      emitted.add(part);
      const ruled = qtyOf(part);
      P(part, ruled > 0 ? ruled : zipLines);
      const last = lines[lines.length - 1];
      if (last && last.sku === part && ruled <= 0) {
        // No quantity rule for this member yet — one per zip line, flagged so it is
        // reviewed rather than silently assumed.
        last.description = 'Quantity assumed 1 per zip line — set its rule in Administration → Formulas → Frame quantities.';
      }
    }
  }

  if (a.trolley) { G('Dual Trolley System', true); ['P-2018', 'P-2025', 'TR2000-A07', 'TR2000-A08', 'TR2000-A09', 'TR2000-A10', 'TRH2005', 'TRN2016', 'TRT2001'].forEach((p) => P(p)); }

  const hasComp = a.slide || a.climbFrame || a.climbWall || a.ballRack;
  if (hasComp) {
    G('Therapeutic Activity & Adventure Components', true);
    if (a.slide) { SG('Summit Adventure Slide System'); P('A-2216'); if (a.slideGray) P('WS8203'); if (a.steamroller) { P('150045'); P('A-2349'); } }
    if (a.climbFrame || a.climbWall) { SG('Climbing Wall & Safety Accessories'); P('SSG-SA-CFM'); P('SSG-SA-CWM'); P('P-2500'); }
    if (a.ballRack) { SG('Ball Rack System'); P('K-5000'); }
  }

  const pad = floorPaddingQuote(a);
  if (pad || a.matColumn || a.matLadderLeg || a.matCustom) {
    G('Adventure Mat System (Highly Recommended)', true); SG('Adventure Mat System');
    if (pad) {
      // Sized and priced from the frame footprint — see matPricing.ts. The catalog
      // record, when the part exists, only supplies weight; price and cost come
      // from the formula so a new frame size never needs a new catalog row.
      const rec = LOOK[pad.sku];
      const w = rec ? rec.weightLbs : 0;
      weight += w;
      lines.push({
        lineType: 'PRODUCT', name: pad.description, sku: pad.sku,
        description: `Floor padding ${pad.thickness}" thick · ${pad.matLengthIn}" × ${pad.matWidthIn}" (${pad.squareFeet.toFixed(2)} sq ft)`,
        quantity: 1, rateMinor: pad.priceMinor, costEach: pad.costMinor, weightEach: w, needsPrice: false,
      });
    }
    if (a.matColumn) { if (n(a.uShaped) > 0) lines.push({ lineType: 'PRODUCT', name: 'U-Shaped Column Wraps', sku: '', quantity: n(a.uShaped), rateMinor: 0, weightEach: 0, needsPrice: true }); if (n(a.completeWrap) > 0) lines.push({ lineType: 'PRODUCT', name: 'Complete Column Wraps', sku: '', quantity: n(a.completeWrap), rateMinor: 0, weightEach: 0, needsPrice: true }); }
    if (a.matLadderLeg) lines.push({ lineType: 'PRODUCT', name: 'Adventure Mat System — Ladder Leg', sku: '', quantity: n(a.ladders), rateMinor: 0, weightEach: 0, needsPrice: true });
    if (a.matCustom) lines.push({ lineType: 'PRODUCT', name: 'Adventure Mat System — CUSTOM', sku: '', description: 'Mat SKU determined by logic (to be provided).', quantity: 1, rateMinor: 0, weightEach: 0, needsPrice: true });
    NOTE('Mat System', '*Please allow 8–10 weeks for manufacturing & delivery of all mat systems. *All column wraps & floor padding colors will be determined after proposal is signed.');
  }

  const addlHw = n(a.forged) || n(a.swingHanger) || n(a.vRings) || n(a.carabiner) || n(a.webbingSling) || n(a.swivelStandalone);
  if (a.brackets || addlHw) {
    G('Hardware', false);
    // The saddle bracket and the eye bolts the configurator asks for by name are
    // things the customer chose — they print as their own lines instead of being
    // buried in the H-1000 description, and are excluded from the roll-up below so
    // nothing is counted twice.
    if (a.brackets && qtyOf(BRACKET_PART) > 0) P(BRACKET_PART);
    const hwRows = hardwareBOM(a, rules, frameRules);
    for (const part of ACCESSORY_HW_PARTS) {
      const row = hwRows.find((h) => h.part === part);
      if (!row || row.qty <= 0) continue;
      const rec = LOOK[part];
      const w = rec ? rec.weightLbs : 0;
      weight += row.qty * w;
      lines.push({
        lineType: 'PRODUCT', name: rec ? rec.description : row.name, sku: part, description: '',
        quantity: row.qty, rateMinor: rec ? rec.unitPriceMinor : 0,
        costEach: rec ? (rec.unitCostMinor ?? 0) : 0, weightEach: w, needsPrice: !rec,
      });
    }
    // The remaining fasteners roll up into the single H-1000 line per the v73
    // workbook: rate, cost and weight are the sums of the 6820H-* components, which
    // are listed in the description so the roll-up can be cross-referenced.
    const roll = hardwareRollup(a, LOOK, rules, frameRules, ACCESSORY_HW_PARTS);
    if (roll.components.length) {
      weight += roll.weightLbs;
      lines.push({
        lineType: 'PRODUCT', name: 'Hardware Kit', sku: 'H-1000',
        description: roll.components.map((c) => `${c.qty}× ${c.name} (${c.part})`).join(' · '),
        quantity: 1, rateMinor: roll.priceMinor, costEach: roll.costMinor,
        weightEach: roll.weightLbs, needsPrice: roll.missing.length > 0,
      });
    }
    // Sold as packs alongside the kit — not fasteners, so not rolled into H-1000.
    if (n(a.vRings) > 0) lines.push({ lineType: 'PRODUCT', name: 'V-Rings (10-Pack)', sku: '', quantity: n(a.vRings), rateMinor: 0, costEach: 0, weightEach: 0, needsPrice: true });
    if (n(a.carabiner) > 0) lines.push({ lineType: 'PRODUCT', name: 'Auto-Locking Carabiner (4-Pack)', sku: '', quantity: n(a.carabiner), rateMinor: 0, costEach: 0, weightEach: 0, needsPrice: true });
    if (n(a.webbingSling) > 0) lines.push({ lineType: 'PRODUCT', name: 'Multi-Pocket Webbing Sling', sku: '', quantity: n(a.webbingSling), rateMinor: 0, costEach: 0, weightEach: 0, needsPrice: true });
  }

  return { lines, totalWeightLbs: Math.round(weight * 100) / 100 };
}

/** Frame part number for the Quick Shift Saddle Bracket. */
export const BRACKET_PART = 'P-2124';

/**
 * Hardware the configurator asks for by name. These print as their own proposal
 * lines rather than rolling into H-1000, so ticking the box visibly changes the
 * proposal. Excluded from `hardwareRollup` at the same time.
 */
export const ACCESSORY_HW_PARTS = ['6820H-LDD', '6820H-LAC-G', '6820H-LP', 'B0C4Y8XSNB', 'SSG-SA-SWIVEL-EYE'];

export interface HardwareComponent { part: string; name: string; qty: number; formula: string; unitPriceMinor: number; unitCostMinor: number; weightLbs: number; inCatalog: boolean; edited?: boolean; }

/**
 * Fastener bill of materials for H-1000, ported from the v73 workbook's
 * "ADVENTURE SERIES: HARDWARE COSTS" block (Calcs rows 183–219). Quantities are
 * driven off the frame BOM, so adding frame items increases the fastener counts.
 */
export function hardwareBOM(a: AdvAnswers, rules?: HardwareRule[], frameRules?: FormulaRule[]): HardwareBomRow[] {
  const bom = computeAdventureBOM(a, frameRules);
  const inputs: Record<string, number> = {
    bracketsQty: n(a.bracketsQty), swivel360: n(a.swivel360), swivelStandalone: n(a.swivelStandalone),
    forged: n(a.forged), swingHanger: n(a.swingHanger), vRings: n(a.vRings),
  };
  return evaluateHardwareRules(rules && rules.length ? rules : DEFAULT_HARDWARE_RULES, {
    bom: (part) => (bom.find((b) => b.part === part) || { qty: 0 }).qty,
    input: (key) => inputs[key] ?? 0,
  });
}

/** The 6820H-* fastener components and their summed roll-up into H-1000. */
export function hardwareRollup(
  a: AdvAnswers, look: Record<string, SkuRec>, rules?: HardwareRule[], frameRules?: FormulaRule[],
  /** Parts that print as their own lines and so must not be summed into H-1000. */
  exclude?: string[],
): {
  components: HardwareComponent[]; priceMinor: number; costMinor: number; weightLbs: number; missing: string[];
} {
  const components: HardwareComponent[] = [];
  const missing: string[] = [];
  const skip = new Set(exclude || []);
  let priceMinor = 0, costMinor = 0, weightLbs = 0;
  for (const h of hardwareBOM(a, rules, frameRules)) {
    if (skip.has(h.part)) continue;
    const rec = look[h.part];
    if (!rec) missing.push(h.part);
    const unitPriceMinor = rec ? rec.unitPriceMinor : 0;
    const unitCostMinor = rec ? (rec.unitCostMinor ?? 0) : 0;
    const wt = rec ? rec.weightLbs : 0;
    priceMinor += unitPriceMinor * h.qty;
    costMinor += unitCostMinor * h.qty;
    weightLbs += wt * h.qty;
    components.push({ part: h.part, name: h.name, qty: h.qty, formula: h.formula, unitPriceMinor, unitCostMinor, weightLbs: wt, inCatalog: !!rec, edited: h.edited });
  }
  return { components, priceMinor, costMinor, weightLbs: Math.round(weightLbs * 100) / 100, missing };
}

export interface TraceRow {
  rule: string; part: string; description: string; formula: string; qty: number;
  unitPriceMinor: number; extendedMinor: number; unitCostMinor: number; extendedCostMinor: number;
  weightLbs: number; inCatalog: boolean; rolledIntoH1000: boolean;
}

/**
 * Every quantity the engine derived, with the expression behind it and the live
 * catalog price/cost it was multiplied by — the cross-reference for the workbook.
 */
export function explainAdventure(a: AdvAnswers, skuMap?: Record<string, SkuRec>, rules?: HardwareRule[], frameRules?: FormulaRule[]): {
  model: string; dimensions: string; rows: TraceRow[];
  hardware: ReturnType<typeof hardwareRollup>;
  totals: { revenueMinor: number; cogsMinor: number; marginMinor: number; marginPct: number; weightLbs: number };
  warnings: string[];
} {
  const LOOK = skuMap && Object.keys(skuMap).length ? skuMap : SKUS;
  const rows: TraceRow[] = [];
  const warnings: string[] = [];
  for (const b of computeAdventureBOM(a, frameRules)) {
    const rec = LOOK[b.part];
    if (!rec) warnings.push(`${b.part} is not in the SKU table — priced at $0.00.`);
    const unitPriceMinor = rec ? rec.unitPriceMinor : 0;
    const unitCostMinor = rec ? (rec.unitCostMinor ?? 0) : 0;
    rows.push({
      rule: b.rule, part: b.part, description: rec ? rec.description : '(not in catalog)', formula: b.formula, qty: b.qty,
      unitPriceMinor, extendedMinor: unitPriceMinor * b.qty,
      unitCostMinor, extendedCostMinor: unitCostMinor * b.qty,
      weightLbs: rec ? rec.weightLbs * b.qty : 0,
      inCatalog: !!rec, rolledIntoH1000: false,
    });
  }
  const pad = floorPaddingQuote(a);
  if (pad) {
    rows.push({
      rule: 'Floor Padding', part: pad.sku, description: pad.description, formula: pad.formula, qty: 1,
      unitPriceMinor: pad.priceMinor, extendedMinor: pad.priceMinor,
      unitCostMinor: pad.costMinor, extendedCostMinor: pad.costMinor,
      weightLbs: LOOK[pad.sku] ? LOOK[pad.sku].weightLbs : 0,
      inCatalog: true, rolledIntoH1000: false,
    });
  }
  const hardware = hardwareRollup(a, LOOK, rules);
  for (const m of hardware.missing) warnings.push(`Hardware component “${m}” has no SKU record — contributes $0.00 to H-1000.`);
  const revenueMinor = rows.reduce((s, r) => s + r.extendedMinor, 0) + hardware.priceMinor;
  const cogsMinor = rows.reduce((s, r) => s + r.extendedCostMinor, 0) + hardware.costMinor;
  const weightLbs = Math.round((rows.reduce((s, r) => s + r.weightLbs, 0) + hardware.weightLbs) * 100) / 100;
  const marginMinor = revenueMinor - cogsMinor;
  return {
    model: frameModelNumber(a), dimensions: frameDimensions(a), rows, hardware,
    totals: { revenueMinor, cogsMinor, marginMinor, marginPct: revenueMinor ? Math.round((marginMinor / revenueMinor) * 1000) / 10 : 0, weightLbs },
    warnings,
  };
}
