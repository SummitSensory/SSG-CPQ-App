import skuData from './adventure-skus.json' with { type: 'json' };

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
  brackets?: boolean; bracketsQty?: number; swivel360?: number; forged?: number; swingHanger?: number; vRings?: number; carabiner?: number; webbingSling?: number;
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
 * Compute the full bill of materials for an Adventure Series frame, mirroring the
 * Excel beam calculator + Calcs tab. Frame-member counts for single-bay frames
 * (length & width 5–10 ft) match the workbook; multi-bay (>10 ft) is approximated
 * and flagged for validation.
 */
export function computeAdventureBOM(a: AdvAnswers): BomRow[] {
  const legs = n(a.legs), ladders = n(a.ladders), L = n(a.length), W = n(a.width);
  const monkey = !!a.monkeyBars, cfg = a.config || 'Rectangle';
  const out: BomRow[] = [];
  const add = (part: string, qty: number, rule: string, formula: string) => {
    if (qty > 0) out.push({ part, qty: Math.round(qty), rule, formula });
  };

  // Verticals
  add('A-2245', Math.max(0, legs - ladders), 'Verticals', `max(0, legs ${legs} − ladders ${ladders})`);
  add('A-2246', ladders, 'Verticals', `= # of ladders (${ladders})`);
  // Corner posts (config/legs driven)
  add('A-2241', cfg === 'T-Shape' ? 2 : 0, 'Corner posts', `T-Shape ? 2 : 0 (config = ${cfg})`);
  add('A-2242', (legs > 0 ? 4 : 0) + (cfg === 'L-Shape' ? 1 : 0), 'Corner posts', `(legs>0 ? 4 : 0) + (L-Shape ? 1 : 0) — legs ${legs}, config ${cfg}`);
  add('A-2243', (legs === 6 ? 2 : 0) + (legs === 8 ? 4 : 0) + (cfg === 'L-Shape' ? -2 : 0), 'Corner posts', `(legs=6 ? 2) + (legs=8 ? 4) + (L-Shape ? −2) — legs ${legs}, config ${cfg}`);
  add('A-2244', cfg === 'L-Shape' ? 1 : 0, 'Corner posts', `L-Shape ? 1 : 0 (config = ${cfg})`);
  // Mid span saddle
  const interiorCount = a.interiorBeams ? n(a.interiorBeamsQty) : 0;
  add('A-2225', interiorCount * 2 + (monkey ? 2 : 0), 'Mid span saddle', `interior beams ${interiorCount} × 2 + (monkey bars ? 2 : 0)`);
  // Ladders
  add('P-2531', ladders, 'Ladders', `= # of ladders (${ladders})`);
  add('A-2253', ladders, 'Ladders', `= # of ladders (${ladders})`);
  // --- Beam members: exact port of the VLOOKUP beam calculator (short caps by width, long by length) ---
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
  // Monkey bar rungs
  add('P-2330', (monkey ? 9 : 0) + ladders * 5, 'Rungs', `(monkey bars ? 9 : 0) + ladders ${ladders} × 5`);
  // Base plate shields = legs * 2
  add('P-2028', legs * 2, 'Base plate shields', `legs ${legs} × 2`);
  // Zip line
  if (a.zipLine) { add('P-2024', 2 * n(a.zipLineQty || 1), 'Zip line', `2 × zip lines ${n(a.zipLineQty || 1)}`); add('A-2530', 4 * n(a.zipLineQty || 1), 'Zip line', `4 × zip lines ${n(a.zipLineQty || 1)}`); }
  // Ball rack
  if (a.ballRack) add('K-5000', 1, 'Ball rack', 'selected → 1');
  // Slide
  if (a.slide) {
    add('A-2216', 1, 'Slide', 'selected → 1');
    if (a.slideGray) add('WS8203', 1, 'Slide', 'gray upcharge → 1');
    if (a.steamroller) { add('150045', 1, 'Slide', 'steamroller ramp → 1'); add('A-2349', 1, 'Slide', 'slide conversion kit → 1'); }
  }
  // Climbing wall
  if (a.climbFrame) add('SSG-SA-CFM', 1, 'Climbing wall', 'frame mounted → 1');
  if (a.climbWall) add('SSG-SA-CWM', 1, 'Climbing wall', 'wall mounted → 1');
  const walls = (a.climbFrame ? 1 : 0) + (a.climbWall ? 1 : 0);
  if (a.climbShield) add('P-2500', walls, 'Climbing wall', `safety shield = # climbing walls (${walls})`);
  // Trolley
  if (a.trolley) {
    add('P-2018', 1, 'Trolley', 'fixed 1'); add('P-2025', 2, 'Trolley', 'fixed 2');
    const rail: Record<number, string> = { 7: 'TR2000-A07', 8: 'TR2000-A08', 9: 'TR2000-A09', 10: 'TR2000-A10' };
    add(rail[L - 1] || 'TR2000-A09', 2, 'Trolley', `rail sized from length − 1 = ${L - 1}' → 2`);
    add('TRH2005', 6, 'Trolley', 'fixed 6'); add('TRN2016', 4, 'Trolley', 'fixed 4'); add('TRT2001', 2, 'Trolley', 'fixed 2');
  }
  // Quick Shift Saddle Bracket group
  if (a.brackets) {
    add('P-2124', n(a.bracketsQty), 'Hardware', `# of saddle brackets (${n(a.bracketsQty)})`);
    add('6820H-LDD', n(a.swivel360), 'Hardware', `# of 360 swivel / 180 eye bolts (${n(a.swivel360)})`);
    add('6820H-LAC-G', Math.max(0, n(a.bracketsQty) - n(a.swivel360)), 'Hardware', `brackets ${n(a.bracketsQty)} − swivel ${n(a.swivel360)}`);
  }
  // Additional hardware
  add('6820H-LP', n(a.forged), 'Hardware', `# of 1/2" forged eye bolts (${n(a.forged)})`);
  add('6820H-LE-G', n(a.swingHanger), 'Hardware', `# of swing hangers (${n(a.swingHanger)})`);
  return out;
}

/** Full priced, grouped proposal-line output for the builder. */
export function computeAdventureProposal(a: AdvAnswers, skuMap?: Record<string, SkuRec>): { lines: PricedLine[]; totalWeightLbs: number } {
  const LOOK = skuMap && Object.keys(skuMap).length ? skuMap : SKUS;
  const bom = computeAdventureBOM(a);
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

  if (a.trolley) { G('Dual Trolley System', true); ['P-2018', 'P-2025', 'TR2000-A07', 'TR2000-A08', 'TR2000-A09', 'TR2000-A10', 'TRH2005', 'TRN2016', 'TRT2001'].forEach((p) => P(p)); }

  const hasComp = a.slide || a.climbFrame || a.climbWall || a.zipLine || a.ballRack;
  if (hasComp) {
    G('Therapeutic Activity & Adventure Components', true);
    if (a.slide) { SG('Summit Adventure Slide System'); P('A-2216'); if (a.slideGray) P('WS8203'); if (a.steamroller) { P('150045'); P('A-2349'); } }
    if (a.climbFrame || a.climbWall) { SG('Climbing Wall & Safety Accessories'); P('SSG-SA-CFM'); P('SSG-SA-CWM'); P('P-2500'); }
    if (a.zipLine || a.ballRack) { SG('Complete Zip Line Kit'); P('P-2024'); P('A-2530'); P('K-5000'); }
  }

  if (a.matFloor || a.matColumn || a.matLadderLeg || a.matCustom) {
    G('Adventure Mat System (Highly Recommended)', true); SG('Adventure Mat System');
    if (a.matFloor) lines.push({ lineType: 'PRODUCT', name: 'Adventure Mat System — Floor', sku: '', description: 'Mat SKU determined by logic (to be provided).', quantity: 1, rateMinor: 0, weightEach: 0, needsPrice: true });
    if (a.matColumn) { if (n(a.uShaped) > 0) lines.push({ lineType: 'PRODUCT', name: 'U-Shaped Column Wraps', sku: '', quantity: n(a.uShaped), rateMinor: 0, weightEach: 0, needsPrice: true }); if (n(a.completeWrap) > 0) lines.push({ lineType: 'PRODUCT', name: 'Complete Column Wraps', sku: '', quantity: n(a.completeWrap), rateMinor: 0, weightEach: 0, needsPrice: true }); }
    if (a.matLadderLeg) lines.push({ lineType: 'PRODUCT', name: 'Adventure Mat System — Ladder Leg', sku: '', quantity: n(a.ladders), rateMinor: 0, weightEach: 0, needsPrice: true });
    if (a.matCustom) lines.push({ lineType: 'PRODUCT', name: 'Adventure Mat System — CUSTOM', sku: '', description: 'Mat SKU determined by logic (to be provided).', quantity: 1, rateMinor: 0, weightEach: 0, needsPrice: true });
    NOTE('Mat System', '*Please allow 8–10 weeks for manufacturing & delivery of all mat systems. *All column wraps & floor padding colors will be determined after proposal is signed.');
  }

  const addlHw = n(a.forged) || n(a.swingHanger) || n(a.vRings) || n(a.carabiner) || n(a.webbingSling);
  if (a.brackets || addlHw) {
    G('Hardware', false);
    // Every hardware component rolls up into the single H-1000 kit line: rate,
    // cost and weight are the sums of the components, which are listed in the
    // description so the roll-up can be cross-referenced against the trace.
    const roll = hardwareRollup(a, LOOK);
    weight += roll.weightLbs;
    lines.push({
      lineType: 'PRODUCT', name: 'Hardware Kit', sku: 'H-1000',
      description: roll.components.map((c) => `${c.qty}× ${c.name}${c.part ? ` (${c.part})` : ''}`).join(' · '),
      quantity: 1, rateMinor: roll.priceMinor, costEach: roll.costMinor,
      weightEach: roll.weightLbs, needsPrice: roll.missing.length > 0,
    });
  }

  return { lines, totalWeightLbs: Math.round(weight * 100) / 100 };
}

export interface HardwareComponent { part: string; name: string; qty: number; unitPriceMinor: number; unitCostMinor: number; weightLbs: number; inCatalog: boolean; }

/** Hardware components and their summed roll-up into H-1000. */
export function hardwareRollup(a: AdvAnswers, look: Record<string, SkuRec>): {
  components: HardwareComponent[]; priceMinor: number; costMinor: number; weightLbs: number; missing: string[];
} {
  const want: { part: string; name: string; qty: number }[] = [];
  if (a.brackets) {
    want.push({ part: 'P-2124', name: 'Quick Shift Saddle Bracket', qty: n(a.bracketsQty) });
    want.push({ part: '6820H-LDD', name: '360 Swivel / 180 Rotational Eye Bolt', qty: n(a.swivel360) });
    want.push({ part: '6820H-LAC-G', name: '3/8" Non-Swivel Eye Bolt', qty: Math.max(0, n(a.bracketsQty) - n(a.swivel360)) });
  }
  want.push({ part: '6820H-LP', name: '1/2" Forged Eye Bolt', qty: n(a.forged) });
  want.push({ part: '6820H-LE-G', name: 'Eye Bolt — Swing Hanger w/ Bearing', qty: n(a.swingHanger) });
  want.push({ part: '', name: 'V-Rings (10-Pack)', qty: n(a.vRings) });
  want.push({ part: '', name: 'Auto-Locking Carabiner (4-Pack)', qty: n(a.carabiner) });
  want.push({ part: '', name: 'Multi-Pocket Webbing Sling', qty: n(a.webbingSling) });

  const components: HardwareComponent[] = [];
  const missing: string[] = [];
  let priceMinor = 0, costMinor = 0, weightLbs = 0;
  for (const w of want) {
    if (w.qty <= 0) continue;
    const rec = w.part ? look[w.part] : undefined;
    if (!rec) missing.push(w.part || w.name);
    const unitPriceMinor = rec ? rec.unitPriceMinor : 0;
    const unitCostMinor = rec ? (rec.unitCostMinor ?? 0) : 0;
    const wt = rec ? rec.weightLbs : 0;
    priceMinor += unitPriceMinor * w.qty;
    costMinor += unitCostMinor * w.qty;
    weightLbs += wt * w.qty;
    components.push({ part: w.part, name: w.name, qty: w.qty, unitPriceMinor, unitCostMinor, weightLbs: wt, inCatalog: !!rec });
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
export function explainAdventure(a: AdvAnswers, skuMap?: Record<string, SkuRec>): {
  model: string; dimensions: string; rows: TraceRow[];
  hardware: ReturnType<typeof hardwareRollup>;
  totals: { revenueMinor: number; cogsMinor: number; marginMinor: number; marginPct: number; weightLbs: number };
  warnings: string[];
} {
  const LOOK = skuMap && Object.keys(skuMap).length ? skuMap : SKUS;
  const hardwareParts = new Set(['P-2124', '6820H-LDD', '6820H-LAC-G', '6820H-LP', '6820H-LE-G']);
  const rows: TraceRow[] = [];
  const warnings: string[] = [];
  for (const b of computeAdventureBOM(a)) {
    const rec = LOOK[b.part];
    if (!rec) warnings.push(`${b.part} is not in the SKU table — priced at $0.00.`);
    const unitPriceMinor = rec ? rec.unitPriceMinor : 0;
    const unitCostMinor = rec ? (rec.unitCostMinor ?? 0) : 0;
    rows.push({
      rule: b.rule, part: b.part, description: rec ? rec.description : '(not in catalog)', formula: b.formula, qty: b.qty,
      unitPriceMinor, extendedMinor: unitPriceMinor * b.qty,
      unitCostMinor, extendedCostMinor: unitCostMinor * b.qty,
      weightLbs: rec ? rec.weightLbs * b.qty : 0,
      inCatalog: !!rec, rolledIntoH1000: hardwareParts.has(b.part),
    });
  }
  const hardware = hardwareRollup(a, LOOK);
  for (const m of hardware.missing) warnings.push(`Hardware component “${m}” has no SKU record — contributes $0.00 to H-1000.`);
  // Frame rows (non-hardware) + the single rolled-up hardware kit.
  const frameRows = rows.filter((r) => !r.rolledIntoH1000);
  const revenueMinor = frameRows.reduce((s, r) => s + r.extendedMinor, 0) + hardware.priceMinor;
  const cogsMinor = frameRows.reduce((s, r) => s + r.extendedCostMinor, 0) + hardware.costMinor;
  const weightLbs = Math.round((frameRows.reduce((s, r) => s + r.weightLbs, 0) + hardware.weightLbs) * 100) / 100;
  const marginMinor = revenueMinor - cogsMinor;
  return {
    model: frameModelNumber(a), dimensions: frameDimensions(a), rows, hardware,
    totals: { revenueMinor, cogsMinor, marginMinor, marginPct: revenueMinor ? Math.round((marginMinor / revenueMinor) * 1000) / 10 : 0, weightLbs },
    warnings,
  };
}
