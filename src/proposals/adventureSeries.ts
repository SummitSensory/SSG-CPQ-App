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
  // Quick Shift Saddle Bracket group (the bracket is a product; its eye bolts are
  // fasteners and live in the H-1000 hardware roll-up, not here).
  if (a.brackets) add('P-2124', n(a.bracketsQty), 'Hardware', `# of saddle brackets (${n(a.bracketsQty)})`);
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

  const addlHw = n(a.forged) || n(a.swingHanger) || n(a.vRings) || n(a.carabiner) || n(a.webbingSling) || n(a.swivelStandalone);
  if (a.brackets || addlHw) {
    G('Hardware', false);
    // Fasteners roll up into the single H-1000 line per the v73 workbook: rate,
    // cost and weight are the sums of the 6820H-* components, which are listed in
    // the description so the roll-up can be cross-referenced against the trace.
    const roll = hardwareRollup(a, LOOK);
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

export interface HardwareComponent { part: string; name: string; qty: number; formula: string; unitPriceMinor: number; unitCostMinor: number; weightLbs: number; inCatalog: boolean; }

/** Excel CEILING(x, significance). */
const ceilTo = (v: number, sig = 1) => (sig <= 0 ? 0 : Math.ceil(v / sig) * sig);

/**
 * Fastener bill of materials for H-1000, ported from the v73 workbook's
 * "ADVENTURE SERIES: HARDWARE COSTS" block (Calcs rows 183–219). Quantities are
 * driven off the frame BOM, so adding frame items increases the fastener counts.
 */
export function hardwareBOM(a: AdvAnswers): { part: string; name: string; qty: number; formula: string }[] {
  const bom = computeAdventureBOM(a);
  const q = (part: string) => (bom.find((b) => b.part === part) || { qty: 0 }).qty;

  // Frame quantities the workbook's hardware formulas reference.
  const A2245 = q('A-2245'), A2246 = q('A-2246'), A2241 = q('A-2241'), A2242 = q('A-2242');
  const A2243 = q('A-2243'), A2244 = q('A-2244'), A2225 = q('A-2225'), P2531 = q('P-2531');
  const A2253 = q('A-2253'), A2248 = q('A-2248'), P2330 = q('P-2330'), P2024 = q('P-2024');
  const A2530 = q('A-2530'), P2124 = q('P-2124'), P2028 = q('P-2028'), P2500 = q('P-2500');
  const P2501 = q('P-2501'), P2502 = q('P-2502'), P2018 = q('P-2018'), P2025 = q('P-2025');
  const TRH2005 = q('TRH2005'), TRN2016 = q('TRN2016');

  // Configurator inputs (VLOOKUP sheet).
  const swivel = n(a.swivel360);
  const nonSwivel = Math.max(0, n(a.bracketsQty) - swivel);
  const forged = n(a.forged);
  const swingHanger = n(a.swingHanger);
  const swivelStandalone = n(a.swivelStandalone);
  const vRings = n(a.vRings);

  // Independent rows first; the dependent ones reference these.
  const LAD = P2531 * 2;
  const LAK = ceilTo((A2245 + A2246) * 4 + 1, 1);
  const LDD = swivel;
  const LAC_G = nonSwivel;
  const LP = forged + P2024;
  const SWING = swingHanger;
  const LY = P2018 * 2;
  const LAI = P2124 * 2;
  const LX = P2018 * 2;
  const LA = (A2241 * 4) + (A2242 * 6) + (A2243 * 8) + (A2244 * 10) + (A2225 * 4) + (A2253 * 2) + (A2248 * 1.5) + (P2500 * 2) + (P2501 * 2) + (P2502 * 2) - (A2530 * 2);
  const LAG = 0;
  const LH = 0;
  const LG = ceilTo((P2330 * 2 - P2531 * 10) * 1.02, 1);
  const LI = P2531 * 2;
  const LJ = A2246 * 2;
  const LT = P2018 * 2;
  const LAB = P2028;
  const LAA = P2018 * 2 + P2028;
  const LU = (P2025 * 3) + P2028 * 2;
  const LV = P2028 + (P2025 * 3);
  const LW = P2025 * 2;
  const LQ = TRH2005;
  const LO = P2024 * 2;
  const LR = TRH2005 * 2;
  const LN = 0;
  const LS = TRN2016 > 0 ? 1 : 0;
  const LAE = vRings * 10;
  const LAF = vRings * 10;
  const LAH = (P2531 * 10) + (A2253 * 2) + (A2248 * 2);
  const LAJ = A2530 * 3;
  // Dependent rows.
  const LK = LY + (LI + LJ) * 2;
  const LL = LI + LJ + LY;
  const LC = ceilTo((LP + LA + LQ + LO + LN + LAJ) * 1.02, 2);
  const LB = ceilTo((LP + (LA * 2) + (LQ * 4) + (LO * 2) + (LAJ * 2)) * 1.1, 1);
  const LF = ceilTo((P2124 + LAF) * 1.05, 1);
  const LM = ceilTo(((P2330 * 2) + (LAF * 2) + P2124) * 1.2, 1);

  const rows: { part: string; name: string; qty: number; formula: string }[] = [
    { part: '6820H-LAD', name: 'Playground Handles, Gate Handles', qty: LAD, formula: `ladder legs P-2531 (${P2531}) × 2` },
    { part: '6820H-LAK', name: '1/2" × 4" Titen HD Screw Anchor, Zinc', qty: LAK, formula: `ceil((A-2245 ${A2245} + A-2246 ${A2246}) × 4 + 1)` },
    { part: '6820H-LDD', name: 'Swing & Swivel Eye Bolt (Quick Shift Saddle Bracket)', qty: LDD, formula: `# of 360 swivel / 180 eye bolts (${swivel})` },
    { part: '6820H-LAC-G', name: 'Eye Bolt — Fixed (Quick Shift Saddle Bracket)', qty: LAC_G, formula: `brackets ${n(a.bracketsQty)} − swivel ${swivel}` },
    { part: '6820H-LP', name: 'Eye Bolt — Fixed', qty: LP, formula: `forged eye bolts ${forged} + zip line tube P-2024 (${P2024})` },
    { part: 'B0C4Y8XSNB', name: 'Eye Bolt — Swing Hanger w/ Bearing', qty: SWING, formula: `# of swing hangers (${swingHanger})` },
    { part: '6820H-LY', name: 'Eye Bolt; 1/4-20 × 2', qty: LY, formula: `trolley bar P-2018 (${P2018}) × 2` },
    { part: '6820H-LAI', name: 'Quick Shift Bracket Bent Pin w/ Lanyard', qty: LAI, formula: `brackets P-2124 (${P2124}) × 2` },
    { part: '6820H-LC', name: 'Hex Nylon Insert Lock Nut, 1/2-13', qty: LC, formula: `ceil((LP ${LP} + LA ${LA} + LQ ${LQ} + LO ${LO} + LN ${LN} + LAJ ${LAJ}) × 1.02, step 2)` },
    { part: '6820H-LX', name: 'Flat Shoulder Rod End Bolt 5/16-18 × 1', qty: LX, formula: `trolley bar P-2018 (${P2018}) × 2` },
    { part: '6820H-LF', name: 'Hex Nylon Insert Lock Nut, 3/8-16', qty: LF, formula: `ceil((brackets ${P2124} + V-ring anchors ${LAF}) × 1.05)` },
    { part: '6820H-LB', name: 'Washer 1/2 Flat', qty: LB, formula: `ceil((LP ${LP} + LA×2 ${LA * 2} + LQ×4 ${LQ * 4} + LO×2 ${LO * 2} + LAJ×2 ${LAJ * 2}) × 1.1)` },
    { part: '6820H-LA', name: 'Hex Bolt, 1/2-13 × 4-1/2"', qty: LA, formula: `A-2241×4 + A-2242×6 + A-2243×8 + A-2244×10 + A-2225×4 + A-2253×2 + A-2248×1.5 + shields×2 − A-2530×2` },
    { part: '6820H-LAG', name: 'Hex Bolt, 1/2-13 × 4"', qty: LAG, formula: 'not used by the workbook (0)' },
    { part: '6820H-LH', name: 'Tap Bolt, 3/8-16 × 2-1/4"', qty: LH, formula: 'not used by the workbook (0)' },
    { part: '6820H-LG', name: 'Tap Bolt, 3/8-16 × 1-3/4"', qty: LG, formula: `ceil((rungs P-2330 ${P2330} × 2 − ladder legs ${P2531} × 10) × 1.02)` },
    { part: '6820H-LI', name: 'Hex Bolt, 1/4-20 × 2-3/4"', qty: LI, formula: `ladder legs P-2531 (${P2531}) × 2` },
    { part: '6820H-LJ', name: 'Hex Bolt, 1/4-20 × 4"', qty: LJ, formula: `A-2246 (${A2246}) × 2` },
    { part: '6820H-LK', name: 'USS Flat Washer, 1/4', qty: LK, formula: `LY ${LY} + (LI ${LI} + LJ ${LJ}) × 2` },
    { part: '6820H-LL', name: 'Hex Nylon Insert Lock Nut, 1/4-20', qty: LL, formula: `LI ${LI} + LJ ${LJ} + LY ${LY}` },
    { part: '6820H-LT', name: 'Coupling Nut, 5/16-18 × 1-3/4', qty: LT, formula: `trolley bar P-2018 (${P2018}) × 2` },
    { part: '6820H-LAB', name: 'Hex Nut, 5/16-18', qty: LAB, formula: `base plate shields P-2028 (${P2028})` },
    { part: '6820H-LAA', name: 'Lock Washer, 5/16', qty: LAA, formula: `P-2018 (${P2018}) × 2 + P-2028 (${P2028})` },
    { part: '6820H-LU', name: 'USS Flat Washer, 5/16', qty: LU, formula: `trolley plate P-2025 (${P2025}) × 3 + P-2028 (${P2028}) × 2` },
    { part: '6820H-LV', name: 'Hex Bolt, 5/16-18 × 1"', qty: LV, formula: `P-2028 (${P2028}) + P-2025 (${P2025}) × 3` },
    { part: '6820H-LW', name: 'Hex Nylon Insert Lock Nut, 5/16-18', qty: LW, formula: `trolley plate P-2025 (${P2025}) × 2` },
    { part: '6820H-LQ', name: 'Tap Bolt, 1/2-13 × 6"', qty: LQ, formula: `threaded rod hangers TRH2005 (${TRH2005})` },
    { part: '6820H-LO', name: 'Hex Bolt, 1/2-13 × 7"', qty: LO, formula: `zip line tube P-2024 (${P2024}) × 2` },
    { part: '6820H-LR', name: 'Hex Nut, 1/2-13', qty: LR, formula: `TRH2005 (${TRH2005}) × 2` },
    { part: '6820H-LM', name: 'USS Flat Washer, 3/8', qty: LM, formula: `ceil((rungs ${P2330} × 2 + V-ring anchors ${LAF} × 2 + brackets ${P2124}) × 1.2)` },
    { part: '6820H-LN', name: 'Hex Bolt, 1/2-13 × 3-1/2"', qty: LN, formula: 'not used by the workbook (0)' },
    { part: '6820H-LS', name: 'Rubber Bumpers, 3/4 OD (25 pack)', qty: LS, formula: `rail end caps TRN2016 (${TRN2016}) > 0 ? 1 : 0` },
    { part: '6820H-LAE', name: 'Tap Bolt, 3/8-16 × 4"', qty: LAE, formula: `V-ring 10-packs (${vRings}) × 10` },
    { part: '6820H-LAF', name: 'V-Ring Bolt-On Anchor', qty: LAF, formula: `V-ring 10-packs (${vRings}) × 10` },
    { part: '6820H-LAH', name: 'Button Head Hex Drive Screw, 3/8-16 × 1-1/2"', qty: LAH, formula: `ladder legs ${P2531} × 10 + A-2253 ${A2253} × 2 + A-2248 ${A2248} × 2` },
    { part: '6820H-LAJ', name: 'Hex Bolt, 1/2-13 × 5"', qty: LAJ, formula: `zip line collars A-2530 (${A2530}) × 3` },
    { part: 'SSG-SA-SWIVEL-EYE', name: 'Swing & Swivel Eye Bolt (Stand Alone)', qty: swivelStandalone, formula: `# of stand-alone swivel eye bolts (${swivelStandalone})` },
  ];
  return rows.filter((r) => r.qty > 0).map((r) => ({ ...r, qty: Math.round(r.qty) }));
}

/** The 6820H-* fastener components and their summed roll-up into H-1000. */
export function hardwareRollup(a: AdvAnswers, look: Record<string, SkuRec>): {
  components: HardwareComponent[]; priceMinor: number; costMinor: number; weightLbs: number; missing: string[];
} {
  const components: HardwareComponent[] = [];
  const missing: string[] = [];
  let priceMinor = 0, costMinor = 0, weightLbs = 0;
  for (const h of hardwareBOM(a)) {
    const rec = look[h.part];
    if (!rec) missing.push(h.part);
    const unitPriceMinor = rec ? rec.unitPriceMinor : 0;
    const unitCostMinor = rec ? (rec.unitCostMinor ?? 0) : 0;
    const wt = rec ? rec.weightLbs : 0;
    priceMinor += unitPriceMinor * h.qty;
    costMinor += unitCostMinor * h.qty;
    weightLbs += wt * h.qty;
    components.push({ part: h.part, name: h.name, qty: h.qty, formula: h.formula, unitPriceMinor, unitCostMinor, weightLbs: wt, inCatalog: !!rec });
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
      inCatalog: !!rec, rolledIntoH1000: false,
    });
  }
  const hardware = hardwareRollup(a, LOOK);
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
