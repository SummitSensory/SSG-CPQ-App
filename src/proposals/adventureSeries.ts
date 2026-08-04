import skuData from './adventure-skus.json' with { type: 'json' };
import {
  evaluateHardwareRules, evaluateRules, DEFAULT_HARDWARE_RULES,
  type HardwareRule, type HardwareBomRow, type FormulaRule,
} from './hardwareRules.js';
import { DEFAULT_FRAME_RULES, frameContext } from './frameRules.js';
import { computeFloorPadding, type MatQuote, type MatThickness } from './matPricing.js';
import { setting, defaultSettings, type FormulaSettings } from './formulaSettings.js';

export interface SkuRec {
  part: string; description: string; unitPriceMinor: number; unitCostMinor?: number; weightLbs: number; category: string;
  /** Where the catalog files this part: tier-1 group and tier-2 subgroup. Drives
   *  which proposal heading a configurator-picked accessory prints under. */
  proposalGroup?: string; proposalSubgroup?: string;
  /** Tree sort order of that group and subgroup — decides heading order. */
  proposalGroupSort?: number; proposalSubgroupSort?: number;
  /** Catalog pre-approval: may a rep swap this part for another in the builder? */
  overrideAllowed?: boolean;
}
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
  /**
   * Rep-entered part substitutions, keyed by the part the engine would normally
   * pick. Honoured only when the catalog flags the original `overrideAllowed`.
   */
  partOverrides?: Record<string, string>;
  brackets?: boolean; bracketsQty?: number; swivel360?: number; swivelStandalone?: number; forged?: number; swingHanger?: number; vRings?: number; carabiner?: number; webbingSling?: number;
}

/**
 * Frame configuration product number, per "Frame Configuration Product Number
 * Identification": {SHAPE}-{beams}{MB}{L}{#ladders}{T}{Z}{R}  e.g. SQ-2MBL2TZR.
 * Segments are omitted when the option is not included.
 *
 * The beam digit counts the monkey bar run as a beam (+1 when monkey bars are on,
 * flat, regardless of how many sets) because it occupies its own bay — so 1
 * interior beam with monkey bars is `SQ-2MBL2`, not `SQ-1MBL2`. Matches the v73
 * workbook rule "Interior Beams (+1 if monkey bars)".
 */
export function frameModelNumber(a: AdvAnswers): string {
  const shape = a.config === 'Square' ? 'SQ' : a.config === 'L-Shape' ? 'L' : a.config === 'T-Shape' ? 'T' : 'R';
  const beams = (a.interiorBeams ? n(a.interiorBeamsQty) : 0) + (a.monkeyBars ? 1 : 0);
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
  /**
   * An engineering warning for whoever is building the proposal — never printed.
   * `description` is the customer's text, so anything addressed to US belongs
   * here instead: a note telling a rep to go set a formula has no business being
   * read by the person buying the gym.
   */
  internalNote?: string;
  /**
   * For a kit line (H-1000), the parts it is made of. The proposal prints the single
   * kit line because that is what the customer buys; the BOM expands this so the
   * shop has every fastener and its count. Carried on the saved proposal item, so
   * the breakdown survives without re-running the configurator.
   */
  components?: Array<{ part: string; name: string; qty: number; unitPriceMinor?: number; unitCostMinor: number; weightLbs: number; formula?: string; inCatalog?: boolean; edited?: boolean }>;
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
    if (len == null) return;
    const jj = shortCap(part) + longBeam(part);
    const kk = (legs === 6 && L === len && len >= 8) ? 3 : 0;
    const ll = (legs === 8 && L === len && len >= 8) ? 6 : 0;
    const nn = (L === len) ? interiorCount : 0;
    const mm = monkeyMem[len];
    const mq = (monkey && L === len && mm) ? 2 : 0;
    const oo = -0.5 * mq;
    add(part, jj + kk + ll + nn + oo, `Beam members (${len}')`,
      `short cap ${shortCap(part)} + long ${longBeam(part)} + 6-leg ${kk} + 8-leg ${ll} + interior ${nn} − monkey offset ${-oo} (W ${W}, L ${L})`);
    if (mq > 0 && mm) add(mm, mq, `Monkey bar beam (${len}')`, `monkey bars on a ${len}' run → 2`);
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
  /** Business numbers (Administration → Formulas). Only `hardwareRollupDetail` is read here. */
  settings?: FormulaSettings,
): { lines: PricedLine[]; totalWeightLbs: number } {
  const LOOK = skuMap && Object.keys(skuMap).length ? skuMap : SKUS;
  const bom = computeAdventureBOM(a, frameRules);
  const qtyOf = (part: string) => (bom.find((b) => b.part === part) || { qty: 0 }).qty;
  const lines: PricedLine[] = [];
  let weight = 0;
  /**
   * Swap a part for the rep's substitute — but only when the catalog has
   * pre-approved the original AND the substitute is itself a real catalog part.
   * Any other answer falls back to the engine's own pick, so a stale or invented
   * override can never reach a proposal.
   */
  const subPart = (part: string): string => {
    const to = a.partOverrides && a.partOverrides[part];
    if (!to || to === part) return part;
    const base = LOOK[part];
    if (!base || !base.overrideAllowed) return part;
    return LOOK[to] ? to : part;
  };
  const P = (part: string, qtyOverride?: number, nameOverride?: string): void => {
    const use = subPart(part);
    const rec = LOOK[use];
    const qty = qtyOverride != null ? qtyOverride : qtyOf(part);
    if (qty <= 0) return;
    const w = rec ? rec.weightLbs : 0;
    weight += qty * w;
    lines.push({
      lineType: 'PRODUCT', name: nameOverride || (rec ? rec.description : use), sku: use,
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
        // No quantity rule for this member yet — one per zip line. Flagged for the
        // rep so it is reviewed rather than silently assumed, but kept OFF the
        // description: this is a message to us, not to the customer.
        last.internalNote = 'Quantity assumed 1 per zip line — set its rule in Administration → Formulas → Frame quantities.';
      }
    }
  }

  if (a.trolley) { G('Dual Trolley System', true); ['P-2018', 'P-2025', 'TR2000-A07', 'TR2000-A08', 'TR2000-A09', 'TR2000-A10', 'TRH2005', 'TRN2016', 'TRT2001'].forEach((p) => P(p)); }

  const hasComp = a.slide || a.climbFrame || a.climbWall || a.ballRack;
  // Packs the configurator asks for by quantity. Which heading they print under is
  // the catalog's decision (tier 1 = group, tier 2 = subgroup), not the engine's —
  // so a part filed under “Essential Carabiners & Connectors” prints there rather
  // than being lumped into Hardware.
  const extras: Array<{ part: string; qty: number }> = [
    { part: V_RING_PART, qty: n(a.vRings) },
    { part: CARABINER_PART, qty: n(a.carabiner) },
    { part: WEBBING_SLING_PART, qty: n(a.webbingSling) },
  ].filter((e) => e.qty > 0);
  const norm = (s?: string) => (s || '').trim().toLowerCase();
  const takeExtras = (groupName: string): Array<{ part: string; qty: number }> => {
    const want = norm(groupName);
    const hit = extras.filter((e) => norm(LOOK[e.part]?.proposalGroup) === want);
    for (const h of hit) extras.splice(extras.indexOf(h), 1);
    return hit;
  };
  /** Print picked parts beneath their catalog subgroup heading, in tree order. */
  const emitExtras = (items: Array<{ part: string; qty: number }>) => {
    const bySub: Record<string, Array<{ part: string; qty: number }>> = {};
    const subSort: Record<string, number> = {};
    for (const it of items) {
      const rec = LOOK[it.part];
      const sub = rec?.proposalSubgroup || '';
      if (!bySub[sub]) { bySub[sub] = []; subSort[sub] = rec?.proposalSubgroupSort ?? 9_999; }
      bySub[sub].push(it);
    }
    // Subgroup headings follow the product tree's sort order, not the order the
    // configurator's questions happen to be asked in.
    const subs = Object.keys(bySub).sort((a, b) => (subSort[a] ?? 9_999) - (subSort[b] ?? 9_999) || a.localeCompare(b));
    for (const sub of subs) { if (sub) SG(sub); (bySub[sub] ?? []).forEach((it) => P(it.part, it.qty)); }
  };
  const compExtras = takeExtras('Therapeutic Activity & Adventure Components');
  const matExtras = takeExtras('Adventure Mat System');
  if (hasComp || compExtras.length) {
    G('Therapeutic Activity & Adventure Components', true);
    if (a.slide) { SG('Summit Adventure Slide System'); P('A-2216'); if (a.slideGray) P('WS8203'); if (a.steamroller) { P('150045'); P('A-2349'); } }
    if (a.climbFrame || a.climbWall) { SG('Climbing Wall & Safety Accessories'); P('SSG-SA-CFM'); P('SSG-SA-CWM'); P('P-2500'); }
    if (a.ballRack) { SG('Ball Rack System'); P('K-5000'); }
    emitExtras(compExtras);
  }

  const pad = floorPaddingQuote(a);
  if (pad || a.matColumn || a.matLadderLeg || a.matCustom || matExtras.length) {
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
    if (a.matColumn) { P(U_SHAPED_WRAP_PART, n(a.uShaped)); P(COMPLETE_WRAP_PART, n(a.completeWrap)); }
    if (a.matLadderLeg) P(LADDER_LEG_WRAP_PART, n(a.ladders));
    if (a.matCustom) lines.push({ lineType: 'PRODUCT', name: 'Adventure Mat System — CUSTOM', sku: '', description: 'Mat SKU determined by logic (to be provided).', quantity: 1, rateMinor: 0, weightEach: 0, needsPrice: true });
    emitExtras(matExtras);
    NOTE('Mat System', '*Please allow 8–10 weeks for manufacturing & delivery of all mat systems. *All column wraps & floor padding colors will be determined after proposal is signed.');
  }

  // Anything still unplaced but filed under some OTHER catalog group prints under
  // that group's own heading. Only a part with no catalog placement at all falls
  // through to Hardware — a tier-2 accessory is never swept in with the fasteners.
  const otherGroups: string[] = [];
  const byGroup: Record<string, Array<{ part: string; qty: number }>> = {};
  const groupSort: Record<string, number> = {};
  for (const e of extras.slice()) {
    const rec = LOOK[e.part];
    const g = rec?.proposalGroup || '';
    if (!g) continue;
    if (!byGroup[g]) { byGroup[g] = []; otherGroups.push(g); groupSort[g] = rec?.proposalGroupSort ?? 9_999; }
    byGroup[g].push(e);
    extras.splice(extras.indexOf(e), 1);
  }
  otherGroups.sort((a, b) => (groupSort[a] ?? 9_999) - (groupSort[b] ?? 9_999) || a.localeCompare(b));
  for (const g of otherGroups) { G(g, true); emitExtras(byGroup[g] ?? []); }

  // V-rings must keep this block alive even on their own: each pack answered adds
  // 10× 6820H-LAE + 10× 6820H-LAF, which are priced inside H-1000, so dropping the
  // block would silently drop their cost.
  const addlHw = n(a.forged) || n(a.swingHanger) || n(a.swivelStandalone) || n(a.vRings) || extras.length;
  if (a.brackets || addlHw) {
    G('Hardware', false);
    // The saddle bracket and the eye bolts the configurator asks for by name are
    // things the customer chose — they print as their own lines instead of being
    // buried in the H-1000 description, and are excluded from the roll-up below so
    // nothing is counted twice.
    // They print beneath their own catalog subgroup heading — 6820H-LDD is filed
    // under HARDWARE › Quick Shift alongside P-2124, so the bracket and the eye
    // bolts that belong to it sit together instead of loose under Hardware.
    const hwRows = hardwareBOM(a, rules, frameRules);
    // The fasteners roll up into the single H-1000 line per the v73 workbook: rate,
    // cost and weight are the sums of the 6820H-* components. It prints FIRST in the
    // Hardware section — the kit is the section's headline, not its footnote.
    // Whether those components are also PRINTED in the description is a business
    // decision, not a pricing one — see `hardwareRollupDetail`. The math is identical
    // either way; the full breakdown always travels on the line in `components`, so
    // the H-1000 audit works on a draft that was built weeks ago.
    const roll = hardwareRollup(a, LOOK, rules, frameRules, ACCESSORY_HW_PARTS);
    if (roll.components.length) {
      weight += roll.weightLbs;
      const itemize = setting(settings ?? defaultSettings(), 'hardwareRollupDetail') === 1;
      const pieces = roll.components.reduce((s, c) => s + c.qty, 0);
      lines.push({
        lineType: 'PRODUCT', name: 'Hardware Kit', sku: 'H-1000',
        description: itemize
          ? roll.components.map((c) => `${c.qty}× ${c.name} (${c.part})`).join(' · ')
          : `All mounting hardware for this structure — ${pieces} pieces across ${roll.components.length} part numbers.`,
        quantity: 1, rateMinor: roll.priceMinor, costEach: roll.costMinor,
        weightEach: roll.weightLbs, needsPrice: roll.missing.length > 0,
        components: roll.components.map((c) => ({
          part: c.part, name: c.name, qty: c.qty, formula: c.formula,
          unitPriceMinor: c.unitPriceMinor, unitCostMinor: c.unitCostMinor,
          weightLbs: c.weightLbs, inCatalog: c.inCatalog, edited: c.edited,
        })),
      });
    }
    const picked: Array<{ part: string; qty: number }> = [];
    if (a.brackets && qtyOf(BRACKET_PART) > 0) picked.push({ part: BRACKET_PART, qty: qtyOf(BRACKET_PART) });
    for (const part of ACCESSORY_HW_PARTS) {
      const ruled = hwRows.find((h) => h.part === part)?.qty ?? 0;
      // A quantity the rep typed reaches the proposal even when that part's rule row
      // has been switched off, emptied or zeroed in Administration → Formulas. The
      // rule may ADD to the answer (6820H-LP also covers the zip-line BOM); it may
      // not erase it. This is why "# of 360 Swivel / 180 Eye Bolts" could be
      // answered and still not print.
      const qty = Math.max(ruled, accessoryAnswerQty(a, part));
      if (qty > 0) picked.push({ part, qty });
    }
    emitExtras(picked);
    // Anything the catalog files under Hardware (or files nowhere yet).
    emitExtras(extras);
  }

  return { lines, totalWeightLbs: Math.round(weight * 100) / 100 };
}

/** Frame part number for the Quick Shift Saddle Bracket. */
export const BRACKET_PART = 'P-2124';

/**
 * Catalog parts behind the configurator's mat and pack questions. These used to be
 * emitted as nameless $0 lines, so they never picked up a price, cost or weight —
 * they now resolve through the same catalog lookup as every other part.
 */
export const U_SHAPED_WRAP_PART = 'SSUSP67';
export const COMPLETE_WRAP_PART = 'SSCW67';
export const LADDER_LEG_WRAP_PART = 'SSUSP72';
export const V_RING_PART = 'B07MB985GW';
export const CARABINER_PART = 'B0CDVDZSB1';
export const WEBBING_SLING_PART = '6820H-LAN';

/**
 * Hardware the configurator asks for by name. These print as their own proposal
 * lines rather than rolling into H-1000, so ticking the box visibly changes the
 * proposal. Excluded from `hardwareRollup` at the same time.
 */
export const ACCESSORY_HW_PARTS = ['6820H-LDD', '6820H-LAC-G', '6820H-LP', 'B0C4Y8XSNB', 'SSG-SA-SWIVEL-EYE'];

/**
 * The configurator answer standing behind each accessory part. Used as a floor on
 * the rule result so an answered quantity can never be zeroed out by a missing or
 * edited HardwareRule row — the rep typed it, so the customer sees it.
 */
export function accessoryAnswerQty(a: AdvAnswers, part: string): number {
  switch (part) {
    case '6820H-LDD': return a.brackets ? n(a.swivel360) : 0;
    case '6820H-LAC-G': return a.brackets ? Math.max(0, n(a.bracketsQty) - n(a.swivel360)) : 0;
    case '6820H-LP': return n(a.forged);
    case 'B0C4Y8XSNB': return n(a.swingHanger);
    case 'SSG-SA-SWIVEL-EYE': return n(a.swivelStandalone);
    default: return 0;
  }
}

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
      weightLbs: LOOK[pad.sku]?.weightLbs ?? 0,
      inCatalog: true, rolledIntoH1000: false,
    });
  }
  // Catalog parts chosen directly in the configurator rather than derived from the
  // frame BOM — they carry price and cost like any other line, so the totals below
  // must include them.
  const picked: Array<{ rule: string; part: string; qty: number; formula: string }> = [];
  if (a.matColumn) {
    picked.push({ rule: 'Mat System', part: U_SHAPED_WRAP_PART, qty: n(a.uShaped), formula: '# U-shaped column wraps answered' });
    picked.push({ rule: 'Mat System', part: COMPLETE_WRAP_PART, qty: n(a.completeWrap), formula: `legs ${n(a.legs)} − U-shaped ${n(a.uShaped)}` });
  }
  if (a.matLadderLeg) picked.push({ rule: 'Mat System', part: LADDER_LEG_WRAP_PART, qty: n(a.ladders), formula: `# of ladders = ${n(a.ladders)}` });
  picked.push({ rule: 'Accessories', part: V_RING_PART, qty: n(a.vRings), formula: '# V-ring packs answered' });
  picked.push({ rule: 'Accessories', part: CARABINER_PART, qty: n(a.carabiner), formula: '# carabiner packs answered' });
  picked.push({ rule: 'Accessories', part: WEBBING_SLING_PART, qty: n(a.webbingSling), formula: '# webbing slings answered' });
  // Hardware the rep answers for by name prints as its own proposal line, so it is
  // traced as its own row — and excluded from the H-1000 roll-up below, which used
  // to count it twice: once here and once inside the kit.
  const hwRows = hardwareBOM(a, rules, frameRules);
  for (const part of ACCESSORY_HW_PARTS) {
    const ruled = hwRows.find((h) => h.part === part);
    const qty = Math.max(ruled?.qty ?? 0, accessoryAnswerQty(a, part));
    if (qty > 0) picked.push({ rule: 'Accessories & Hardware', part, qty, formula: ruled?.formula || 'answered in the configurator' });
  }
  for (const p of picked) {
    if (p.qty <= 0) continue;
    const rec = LOOK[p.part];
    if (!rec) warnings.push(`${p.part} is not in the SKU table — priced at $0.00.`);
    const unitPriceMinor = rec ? rec.unitPriceMinor : 0;
    const unitCostMinor = rec ? (rec.unitCostMinor ?? 0) : 0;
    rows.push({
      rule: p.rule, part: p.part, description: rec ? rec.description : '(not in catalog)', formula: p.formula, qty: p.qty,
      unitPriceMinor, extendedMinor: unitPriceMinor * p.qty,
      unitCostMinor, extendedCostMinor: unitCostMinor * p.qty,
      weightLbs: rec ? rec.weightLbs * p.qty : 0,
      inCatalog: !!rec, rolledIntoH1000: false,
    });
  }
  const hardware = hardwareRollup(a, LOOK, rules, frameRules, ACCESSORY_HW_PARTS);
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
