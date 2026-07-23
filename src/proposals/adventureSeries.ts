import skuData from './adventure-skus.json' with { type: 'json' };

export interface SkuRec { part: string; description: string; unitPriceMinor: number; weightLbs: number; category: string; }
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

export interface PricedLine {
  lineType: 'GROUP' | 'SUBGROUP' | 'PRODUCT' | 'NOTE';
  optional?: boolean; name: string; sku?: string; description?: string;
  quantity?: number; rateMinor?: number; weightEach?: number; needsPrice?: boolean;
}

const n = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);

/**
 * Compute the full bill of materials for an Adventure Series frame, mirroring the
 * Excel beam calculator + Calcs tab. Frame-member counts for single-bay frames
 * (length & width 5–10 ft) match the workbook; multi-bay (>10 ft) is approximated
 * and flagged for validation.
 */
export function computeAdventureBOM(a: AdvAnswers): { part: string; qty: number }[] {
  const legs = n(a.legs), ladders = n(a.ladders), L = n(a.length), W = n(a.width);
  const monkey = !!a.monkeyBars, cfg = a.config || 'Rectangle';
  const out: { part: string; qty: number }[] = [];
  const add = (part: string, qty: number) => { if (qty > 0) out.push({ part, qty: Math.round(qty) }); };

  // Verticals
  add('A-2245', Math.max(0, legs - ladders));
  add('A-2246', ladders);
  // Corner posts (config/legs driven)
  add('A-2241', cfg === 'T-Shape' ? 2 : 0);
  add('A-2242', (legs > 0 ? 4 : 0) + (cfg === 'L-Shape' ? 1 : 0));
  add('A-2243', (legs === 6 ? 2 : 0) + (legs === 8 ? 4 : 0) + (cfg === 'L-Shape' ? -2 : 0));
  add('A-2244', cfg === 'L-Shape' ? 1 : 0);
  // Mid span saddle
  const interiorCount = a.interiorBeams ? n(a.interiorBeamsQty) : 0;
  add('A-2225', interiorCount * 2 + (monkey ? 2 : 0));
  // Ladders
  add('P-2531', ladders);
  add('A-2253', ladders);
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
    add(part, jj + kk + ll + nn + oo);
    if (mq > 0) add(monkeyMem[len], mq);
  });
  // Monkey bar rungs
  add('P-2330', (monkey ? 9 : 0) + ladders * 5);
  // Base plate shields = legs * 2
  add('P-2028', legs * 2);
  // Zip line
  if (a.zipLine) { add('P-2024', 2 * n(a.zipLineQty || 1)); add('A-2530', 4 * n(a.zipLineQty || 1)); }
  // Ball rack
  if (a.ballRack) add('K-5000', 1);
  // Slide
  if (a.slide) { add('A-2216', 1); if (a.slideGray) add('WS8203', 1); if (a.steamroller) { add('150045', 1); add('A-2349', 1); } }
  // Climbing wall
  if (a.climbFrame) add('SSG-SA-CFM', 1);
  if (a.climbWall) add('SSG-SA-CWM', 1);
  const walls = (a.climbFrame ? 1 : 0) + (a.climbWall ? 1 : 0);
  if (a.climbShield) add('P-2500', walls);
  // Trolley
  if (a.trolley) {
    add('P-2018', 1); add('P-2025', 2);
    const rail: Record<number, string> = { 7: 'TR2000-A07', 8: 'TR2000-A08', 9: 'TR2000-A09', 10: 'TR2000-A10' };
    add(rail[L - 1] || 'TR2000-A09', 2); add('TRH2005', 6); add('TRN2016', 4); add('TRT2001', 2);
  }
  // Quick Shift Saddle Bracket group
  if (a.brackets) {
    add('P-2124', n(a.bracketsQty));
    // 360 swivel / non-swivel eye bolts (hardware SKUs)
    add('6820H-LDD', n(a.swivel360));
    add('6820H-LAC-G', Math.max(0, n(a.bracketsQty) - n(a.swivel360)));
  }
  // Additional hardware
  add('6820H-LP', n(a.forged));
  add('6820H-LE-G', n(a.swingHanger));
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
      description: '', quantity: qty, rateMinor: rec ? rec.unitPriceMinor : 0, weightEach: w, needsPrice: !rec,
    });
  };
  const G = (name: string, optional = false) => lines.push({ lineType: 'GROUP', name, optional });
  const SG = (name: string) => lines.push({ lineType: 'SUBGROUP', name });
  const NOTE = (name: string, description: string) => lines.push({ lineType: 'NOTE', name, description });
  const prefix = a.config === 'Square' ? 'SQ-' : a.config === 'L-Shape' ? 'L-' : a.config === 'T-Shape' ? 'T-' : 'R-';

  // Main itemized frame
  G(`${prefix}${a.length}x${a.width} — Itemized`, false);
  ['A-2245', 'A-2246', 'A-2241', 'A-2242', 'A-2243', 'A-2244', 'A-2225', 'P-2531', 'A-2253',
    'P-2545', 'P-2206', 'P-2207', 'A-2408', 'A-2409', 'A-2410', 'P-2216', 'P-2217', 'A-2418', 'A-2419', 'A-2420',
    'P-2330', 'P-2028'].forEach((p) => P(p));

  if (a.trolley) { G('Dual Trolley System (Optional)', true); ['P-2018', 'P-2025', 'TR2000-A07', 'TR2000-A08', 'TR2000-A09', 'TR2000-A10', 'TRH2005', 'TRN2016', 'TRT2001'].forEach((p) => P(p)); }

  const hasComp = a.slide || a.climbFrame || a.climbWall || a.zipLine || a.ballRack;
  if (hasComp) {
    G('Therapeutic Activity & Adventure Components (Optional)', true);
    if (a.slide) { SG('Summit Adventure Slide System'); P('A-2216'); if (a.slideGray) P('WS8203'); if (a.steamroller) { P('150045'); P('A-2349'); } }
    if (a.climbFrame || a.climbWall) { SG('Climbing Wall & Safety Accessories'); P('SSG-SA-CFM'); P('SSG-SA-CWM'); P('P-2500'); }
    if (a.zipLine || a.ballRack) { SG('Complete Zip Line Kit'); P('P-2024'); P('A-2530'); P('K-5000'); }
  }

  if (a.matFloor || a.matColumn || a.matLadderLeg || a.matCustom) {
    G('Adventure Mat System (Highly Recommended — Optional)', true); SG('Adventure Mat System');
    if (a.matFloor) lines.push({ lineType: 'PRODUCT', name: 'Adventure Mat System — Floor', sku: '', description: 'Mat SKU determined by logic (to be provided).', quantity: 1, rateMinor: 0, weightEach: 0, needsPrice: true });
    if (a.matColumn) { if (n(a.uShaped) > 0) lines.push({ lineType: 'PRODUCT', name: 'U-Shaped Column Wraps', sku: '', quantity: n(a.uShaped), rateMinor: 0, weightEach: 0, needsPrice: true }); if (n(a.completeWrap) > 0) lines.push({ lineType: 'PRODUCT', name: 'Complete Column Wraps', sku: '', quantity: n(a.completeWrap), rateMinor: 0, weightEach: 0, needsPrice: true }); }
    if (a.matLadderLeg) lines.push({ lineType: 'PRODUCT', name: 'Adventure Mat System — Ladder Leg', sku: '', quantity: n(a.ladders), rateMinor: 0, weightEach: 0, needsPrice: true });
    if (a.matCustom) lines.push({ lineType: 'PRODUCT', name: 'Adventure Mat System — CUSTOM', sku: '', description: 'Mat SKU determined by logic (to be provided).', quantity: 1, rateMinor: 0, weightEach: 0, needsPrice: true });
    NOTE('Mat System', '*Please allow 8–10 weeks for manufacturing & delivery of all mat systems. *All column wraps & floor padding colors will be determined after proposal is signed.');
  }

  const addlHw = n(a.forged) || n(a.swingHanger) || n(a.vRings) || n(a.carabiner) || n(a.webbingSling);
  if (a.brackets || addlHw) {
    G('Hardware', false);
    if (a.brackets) { SG('Quick Shift Saddle Bracket'); P('P-2124'); P('6820H-LDD', n(a.swivel360), '360 Swivel / 180 Rotational Eye Bolt'); P('6820H-LAC-G', Math.max(0, n(a.bracketsQty) - n(a.swivel360)), '3/8" Non-Swivel Eye Bolts'); }
    if (addlHw) {
      SG('Accessories & Hardware');
      P('6820H-LP', n(a.forged), '1/2" Forged Eye Bolts');
      P('6820H-LE-G', n(a.swingHanger), 'Eye Bolt — Swing Hanger w/ Bearing');
      if (n(a.vRings) > 0) lines.push({ lineType: 'PRODUCT', name: 'V-Rings (10-Pack)', sku: '', quantity: n(a.vRings), rateMinor: 0, weightEach: 0, needsPrice: true });
      if (n(a.carabiner) > 0) lines.push({ lineType: 'PRODUCT', name: 'Auto-Locking Carabiner (4-Pack)', sku: '', quantity: n(a.carabiner), rateMinor: 0, weightEach: 0, needsPrice: true });
      if (n(a.webbingSling) > 0) lines.push({ lineType: 'PRODUCT', name: 'Multi-Pocket Webbing Sling', sku: '', quantity: n(a.webbingSling), rateMinor: 0, weightEach: 0, needsPrice: true });
    }
  }

  return { lines, totalWeightLbs: Math.round(weight * 100) / 100 };
}
