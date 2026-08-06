/**
 * Hardware quantity rules — the coefficients behind the H-1000 fastener counts,
 * expressed as DATA rather than code.
 *
 * Every row of the workbook's ADVENTURE SERIES: HARDWARE COSTS block has the
 * same shape:
 *
 *     qty = round( (Σ coefficientᵢ × sourceᵢ + constant) × factor )
 *
 * where each source is a frame BOM part quantity (`bom:A-2245`), a configurator
 * input (`in:swivel360`) or another hardware row (`hw:6820H-LP`). The shape stays
 * in code; the numbers live in `DEFAULT_HARDWARE_RULES` below and may be
 * overridden per part from the HardwareRule table (Administration → Hardware
 * quantity formulas), so a multiplier can be corrected without a deploy.
 *
 * `PRESENCE` mode covers the one "if any, then a fixed pack" row (rubber bumpers).
 */

export type RoundMode = 'NONE' | 'CEIL' | 'ROUND';
export type RuleMode = 'SUM' | 'PRESENCE';

export type CompareOp = '=' | '!=' | '>' | '<' | '>=' | '<=';

/** A term (or a whole rule) can be gated on a configurator answer. */
export interface RuleCondition {
  /** Configurator answer key, e.g. `config`, `legs`, `monkeyBars`. */
  input: string;
  op: CompareOp;
  value: string | number | boolean;
}

export interface HardwareTerm {
  /**
   * `bom:<part>` (frame quantity) | `in:<answerKey>` (configurator number) |
   * `flag:<answerKey>` (yes/no as 1/0) | `hw:<part>` (another rule's result).
   * Omitted entirely for a plain constant term.
   */
  source?: string;
  coefficient: number;
  /** Only counted when this condition holds. */
  when?: RuleCondition;
}

export interface HardwareRule {
  part: string;
  name: string;
  terms: HardwareTerm[];
  /** Added to the weighted sum before `factor` is applied. In PRESENCE mode this is the fixed output. */
  constant: number;
  /** Waste/overage multiplier, e.g. 1.02. */
  factor: number;
  roundMode: RoundMode;
  /** Round up to a multiple of this (2 = sold in pairs). Ignored when roundMode is NONE. */
  roundStep: number;
  mode: RuleMode;
  /** Clamp a negative result to zero. */
  minZero: boolean;
  sortOrder: number;
  active: boolean;
  /** The whole rule only applies when this holds (e.g. only when a slide is chosen). */
  when?: RuleCondition;
  /** Heading this row is grouped under in the BOM and the trace. */
  group?: string;
  /** Set when the rule came from the database rather than the workbook defaults. */
  edited?: boolean;
  note?: string;
}

export interface HardwareBomRow {
  part: string;
  name: string;
  qty: number;
  formula: string;
  group?: string;
  edited?: boolean;
}

const ceilTo = (v: number, step: number): number => (step > 0 ? Math.ceil(v / step) * step : Math.ceil(v));

/** Friendly labels for the configurator inputs the formulas can reference. */
export const HARDWARE_INPUTS: { key: string; label: string }[] = [
  { key: 'bracketsQty', label: '# of saddle brackets' },
  { key: 'swivel360', label: '# of 360° swivel / 180° eye bolts' },
  { key: 'swivelStandalone', label: '# of stand-alone swivel eye bolts' },
  { key: 'forged', label: '# of forged eye bolts' },
  { key: 'swingHanger', label: '# of swing hangers' },
  { key: 'vRings', label: '# of V-ring 10-packs' },
];

const R = (
  part: string,
  name: string,
  terms: [string, number][],
  extra: Partial<Omit<HardwareRule, 'part' | 'name' | 'terms'>> = {},
): HardwareRule => ({
  part,
  name,
  terms: terms.map(([source, coefficient]) => ({ source, coefficient })),
  constant: 0,
  factor: 1,
  roundMode: 'NONE',
  roundStep: 1,
  mode: 'SUM',
  minZero: true,
  sortOrder: 0,
  active: true,
  ...extra,
});

/**
 * The workbook (v73) coefficients. Order matches the trace output; dependent rows
 * may reference rows declared later — evaluation resolves by dependency, not order.
 */
export const DEFAULT_HARDWARE_RULES: HardwareRule[] = [
  R('6820H-LAD', 'Playground Handles, Gate Handles', [['bom:P-2531', 2]]),
  R('6820H-LAK', '1/2" × 4" Titen HD Screw Anchor, Zinc', [['bom:A-2245', 4], ['bom:A-2246', 4]], { constant: 1, roundMode: 'CEIL', roundStep: 1 }),
  R('6820H-LDD', 'Swing & Swivel Eye Bolt (Quick Shift Saddle Bracket)', [['in:swivel360', 1]]),
  R('6820H-LAC-G', 'Eye Bolt — Fixed (Quick Shift Saddle Bracket)', [['in:bracketsQty', 1], ['in:swivel360', -1]]),
  R('6820H-LP', 'Eye Bolt — Fixed', [['in:forged', 1], ['bom:P-2024', 1]]),
  R('B0C4Y8XSNB', 'Eye Bolt — Swing Hanger w/ Bearing', [['in:swingHanger', 1]]),
  R('6820H-LY', 'Eye Bolt; 1/4-20 × 2', [['bom:P-2018', 2]]),
  R('6820H-LAI', 'Quick Shift Bracket Bent Pin w/ Lanyard', [['bom:P-2124', 2]]),
  R('6820H-LC', 'Hex Nylon Insert Lock Nut, 1/2-13',
    [['hw:6820H-LP', 1], ['hw:6820H-LA', 1], ['hw:6820H-LQ', 1], ['hw:6820H-LO', 1], ['hw:6820H-LN', 1], ['hw:6820H-LAJ', 1]],
    { factor: 1.02, roundMode: 'CEIL', roundStep: 2 }),
  R('6820H-LX', 'Flat Shoulder Rod End Bolt 5/16-18 × 1', [['bom:P-2018', 2]]),
  R('6820H-LF', 'Hex Nylon Insert Lock Nut, 3/8-16', [['bom:P-2124', 1], ['hw:6820H-LAF', 1]], { factor: 1.05, roundMode: 'CEIL', roundStep: 1 }),
  R('6820H-LB', 'Washer 1/2 Flat',
    [['hw:6820H-LP', 1], ['hw:6820H-LA', 2], ['hw:6820H-LQ', 4], ['hw:6820H-LO', 2], ['hw:6820H-LAJ', 2]],
    { factor: 1.1, roundMode: 'CEIL', roundStep: 1 }),
  R('6820H-LA', 'Hex Bolt, 1/2-13 × 4-1/2"',
    [['bom:A-2241', 4], ['bom:A-2242', 6], ['bom:A-2243', 8], ['bom:A-2244', 10], ['bom:A-2225', 4],
     ['bom:A-2253', 2], ['bom:A-2248', 1.5], ['bom:P-2500', 2], ['bom:P-2501', 2], ['bom:P-2502', 2], ['bom:A-2530', -2]]),
  R('6820H-LAG', 'Hex Bolt, 1/2-13 × 4"', [], { active: false, note: 'Hard zero in the v73 workbook.' }),
  R('6820H-LH', 'Tap Bolt, 3/8-16 × 2-1/4"', [], { active: false, note: 'Hard zero in the v73 workbook.' }),
  R('6820H-LG', 'Tap Bolt, 3/8-16 × 1-3/4"', [['bom:P-2330', 2], ['bom:P-2531', -10]], { factor: 1.02, roundMode: 'CEIL', roundStep: 1 }),
  R('6820H-LI', 'Hex Bolt, 1/4-20 × 2-3/4"', [['bom:P-2531', 2]]),
  R('6820H-LJ', 'Hex Bolt, 1/4-20 × 4"', [['bom:A-2246', 2]]),
  R('6820H-LK', 'USS Flat Washer, 1/4', [['hw:6820H-LY', 1], ['hw:6820H-LI', 2], ['hw:6820H-LJ', 2]]),
  R('6820H-LL', 'Hex Nylon Insert Lock Nut, 1/4-20', [['hw:6820H-LI', 1], ['hw:6820H-LJ', 1], ['hw:6820H-LY', 1]]),
  R('6820H-LT', 'Coupling Nut, 5/16-18 × 1-3/4', [['bom:P-2018', 2]]),
  R('6820H-LAB', 'Hex Nut, 5/16-18', [['bom:P-2028', 1]]),
  R('6820H-LAA', 'Lock Washer, 5/16', [['bom:P-2018', 2], ['bom:P-2028', 1]]),
  R('6820H-LU', 'USS Flat Washer, 5/16', [['bom:P-2025', 3], ['bom:P-2028', 2]]),
  R('6820H-LV', 'Hex Bolt, 5/16-18 × 1"', [['bom:P-2028', 1], ['bom:P-2025', 3]]),
  R('6820H-LW', 'Hex Nylon Insert Lock Nut, 5/16-18', [['bom:P-2025', 2]]),
  R('6820H-LQ', 'Tap Bolt, 1/2-13 × 6"', [['bom:TRH2005', 1]]),
  R('6820H-LO', 'Hex Bolt, 1/2-13 × 7"', [['bom:P-2024', 2]]),
  R('6820H-LR', 'Hex Nut, 1/2-13', [['bom:TRH2005', 2]]),
  R('6820H-LM', 'USS Flat Washer, 3/8', [['bom:P-2330', 2], ['hw:6820H-LAF', 2], ['bom:P-2124', 1]], { factor: 1.2, roundMode: 'CEIL', roundStep: 1 }),
  R('6820H-LN', 'Hex Bolt, 1/2-13 × 3-1/2"', [], { active: false, note: 'Hard zero in the v73 workbook.' }),
  R('6820H-LS', 'Rubber Bumpers, 3/4 OD (25 pack)', [['bom:TRN2016', 1]], { mode: 'PRESENCE', constant: 1 }),
  R('6820H-LAE', 'Tap Bolt, 3/8-16 × 4"', [['in:vRings', 10]]),
  R('6820H-LAF', 'V-Ring Bolt-On Anchor', [['in:vRings', 10]]),
  R('6820H-LAH', 'Button Head Hex Drive Screw, 3/8-16 × 1-1/2"', [['bom:P-2531', 10], ['bom:A-2253', 2], ['bom:A-2248', 2]]),
  R('6820H-LAJ', 'Hex Bolt, 1/2-13 × 5"', [['bom:A-2530', 3]]),
  R('SSG-SA-SWIVEL-EYE', 'Swing & Swivel Eye Bolt (Stand Alone)', [['in:swivelStandalone', 1]]),
].map((r, i) => ({ ...r, sortOrder: i }));

export interface RuleContext {
  /** Frame BOM quantity for a part number. */
  bom: (part: string) => number;
  /** Configurator answer, as a number. */
  input: (key: string) => number;
  /** Configurator answer as stored (string/boolean/number) — for conditions. */
  raw?: (key: string) => unknown;
  /**
   * Quantity of a fastener actually on the proposal, when a rep has put one there
   * by hand. Returns undefined for a part nobody has touched.
   *
   * Adding an eye bolt to a proposal has to move the nuts and washers that hang off
   * it — 6820H-LC and 6820H-LB both read `hw:6820H-LP`. Without this the rule only
   * ever sees the configurator's own count and the dependants never move.
   *
   * It raises a quantity, never lowers one: the rule's own result stands unless the
   * proposal asks for more. That mirrors how the configurator's accessory answers
   * already work — a rule may add to the answer, it may not erase it.
   */
  override?: (part: string) => number | undefined;
}

/** Evaluate a term/rule condition against the answers. */
export function conditionHolds(c: RuleCondition | undefined, ctx: RuleContext): boolean {
  if (!c) return true;
  const raw = ctx.raw ? ctx.raw(c.input) : ctx.input(c.input);
  if (typeof c.value === 'boolean') return !!raw === c.value;
  if (typeof c.value === 'string' && typeof raw === 'string') {
    return c.op === '!=' ? raw !== c.value : raw === c.value;
  }
  const a = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw) || 0;
  const b = Number(c.value) || 0;
  switch (c.op) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '!=': return a !== b;
    default: return a === b;
  }
}

export function describeCondition(c: RuleCondition): string {
  if (typeof c.value === 'boolean') return c.value ? c.input : `not ${c.input}`;
  return `${c.input} ${c.op} ${c.value}`;
}

const label = (source: string): string => {
  if (source.startsWith('in:')) {
    const key = source.slice(3);
    return (HARDWARE_INPUTS.find((i) => i.key === key) || { label: key }).label;
  }
  return source.slice(source.indexOf(':') + 1);
};

/** Resolve every rule to a quantity, with the expression and live values behind it. */
export function evaluateHardwareRules(rules: HardwareRule[], ctx: RuleContext): HardwareBomRow[] {
  const byPart = new Map(rules.map((r) => [r.part, r]));
  const done = new Map<string, number>();
  const visiting = new Set<string>();
  const detail = new Map<string, string>();

  function valueOf(source: string): number {
    if (source.startsWith('bom:')) return ctx.bom(source.slice(4));
    if (source.startsWith('in:')) return ctx.input(source.slice(3));
    if (source.startsWith('flag:')) {
      const raw = ctx.raw ? ctx.raw(source.slice(5)) : ctx.input(source.slice(5));
      return raw ? 1 : 0;
    }
    if (source.startsWith('hw:')) return resolve(source.slice(3));
    return 0;
  }

  function resolve(part: string): number {
    const cached = done.get(part);
    if (cached !== undefined) return cached;
    const rule = byPart.get(part);
    if (!rule) return 0;
    if (visiting.has(part)) {
      // Circular reference: treat as zero rather than looping forever.
      detail.set(part, 'circular reference — treated as 0');
      return 0;
    }
    visiting.add(part);

    const parts: string[] = [];
    let sum = 0;
    const ruleApplies = rule.active && conditionHolds(rule.when, ctx);
    if (ruleApplies) {
      for (const t of rule.terms) {
        if (!conditionHolds(t.when, ctx)) continue;
        const sign = t.coefficient < 0 ? '−' : parts.length ? '+' : '';
        const mag = Math.abs(t.coefficient);
        const cond = t.when ? ` when ${describeCondition(t.when)}` : '';
        if (!t.source) {
          // Plain constant term (e.g. "4 per frame when legs > 0").
          sum += t.coefficient;
          parts.push(`${sign} ${mag}${cond}`.trim());
          continue;
        }
        const v = valueOf(t.source);
        sum += v * t.coefficient;
        parts.push(`${sign} ${label(t.source)} (${v})${mag === 1 ? '' : ` × ${mag}`}${cond}`.trim());
      }
    }

    let qty: number;
    let expr: string;
    if (!rule.active) {
      qty = 0;
      expr = rule.note || 'rule switched off — 0';
    } else if (!ruleApplies) {
      qty = 0;
      expr = `not applicable (${describeCondition(rule.when!)})`;
    } else if (rule.mode === 'PRESENCE') {
      qty = sum > 0 ? rule.constant : 0;
      expr = `${parts.join(' ') || '0'} > 0 ? ${rule.constant} : 0`;
    } else {
      let v = sum + rule.constant;
      expr = parts.join(' ') || '0';
      if (rule.constant) expr = `${expr} ${rule.constant < 0 ? '−' : '+'} ${Math.abs(rule.constant)}`;
      if (rule.factor !== 1) { v *= rule.factor; expr = `(${expr}) × ${rule.factor}`; }
      if (rule.roundMode === 'CEIL') {
        v = ceilTo(v, rule.roundStep);
        expr = `ceil(${expr}${rule.roundStep > 1 ? `, step ${rule.roundStep}` : ''})`;
      } else if (rule.roundMode === 'ROUND') {
        const step = rule.roundStep > 0 ? rule.roundStep : 1;
        v = Math.round(v / step) * step;
        expr = `round(${expr}${step > 1 ? `, step ${step}` : ''})`;
      }
      if (rule.minZero && v < 0) { v = 0; expr = `max(0, ${expr})`; }
      qty = v;
    }

    // What the proposal actually asks for wins when it asks for more. Applied here,
    // before caching, so every dependant rule resolves against the same number.
    const asked = ctx.override ? ctx.override(part) : undefined;
    if (asked !== undefined && asked > qty) {
      expr = `${expr} → ${asked} (quantity on the proposal)`;
      qty = asked;
    }

    visiting.delete(part);
    done.set(part, qty);
    detail.set(part, expr);
    return qty;
  }

  return [...rules]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({ part: r.part, name: r.name, qty: resolve(r.part), formula: detail.get(r.part) || '', group: r.group, edited: r.edited }))
    .filter((r) => r.qty > 0)
    .map((r) => ({ ...r, qty: Math.round(r.qty) }));
}

/**
 * Overlay database rows onto the workbook defaults. Unknown parts are appended
 * (a shop can add a fastener the workbook never had); defaults fill any gap.
 */
export function mergeHardwareRules(dbRows: Partial<HardwareRule>[] | null | undefined): HardwareRule[] {
  if (!dbRows || !dbRows.length) return DEFAULT_HARDWARE_RULES;
  const out = DEFAULT_HARDWARE_RULES.map((d) => {
    const row = dbRows.find((r) => r.part === d.part);
    if (!row) return d;
    return {
      ...d,
      ...row,
      terms: Array.isArray(row.terms) ? (row.terms as HardwareTerm[]) : d.terms,
      edited: true,
    } as HardwareRule;
  });
  for (const row of dbRows) {
    if (row.part && !out.some((r) => r.part === row.part)) {
      out.push({
        part: row.part, name: row.name || row.part, terms: (row.terms as HardwareTerm[]) || [],
        constant: row.constant ?? 0, factor: row.factor ?? 1, roundMode: row.roundMode ?? 'NONE',
        roundStep: row.roundStep ?? 1, mode: row.mode ?? 'SUM', minZero: row.minZero ?? true,
        sortOrder: row.sortOrder ?? out.length, active: row.active ?? true, edited: true,
      });
    }
  }
  return out;
}

/** Shared aliases — the same shape drives hardware and frame quantities. */
export type FormulaRule = HardwareRule;
export type FormulaTerm = HardwareTerm;
export const evaluateRules = evaluateHardwareRules;

/** Overlay database rows onto any default rule set (frame, hardware, …). */
export function mergeRules(defaults: FormulaRule[], dbRows: Partial<FormulaRule>[] | null | undefined): FormulaRule[] {
  if (!dbRows || !dbRows.length) return defaults;
  const out = defaults.map((d) => {
    const row = dbRows.find((r) => r.part === d.part);
    if (!row) return d;
    return { ...d, ...row, terms: Array.isArray(row.terms) ? (row.terms as FormulaTerm[]) : d.terms, edited: true } as FormulaRule;
  });
  for (const row of dbRows) {
    if (row.part && !out.some((r) => r.part === row.part)) {
      out.push({
        part: row.part, name: row.name || row.part, terms: (row.terms as FormulaTerm[]) || [],
        constant: row.constant ?? 0, factor: row.factor ?? 1, roundMode: row.roundMode ?? 'NONE',
        roundStep: row.roundStep ?? 1, mode: row.mode ?? 'SUM', minZero: row.minZero ?? true,
        sortOrder: row.sortOrder ?? out.length, active: row.active ?? true,
        when: row.when, group: row.group, edited: true,
      });
    }
  }
  return out;
}
