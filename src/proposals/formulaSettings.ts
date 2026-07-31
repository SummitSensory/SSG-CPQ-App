/**
 * Business numbers behind the proposal math. Small scalars that belong to the
 * business rather than to code — deposit percentage, how long a proposal stands,
 * and the leg-count spans the configurator uses — editable in
 * Administration → Formulas → Business numbers.
 */

export interface FormulaSettingDef {
  key: string;
  label: string;
  help: string;
  unit: string;
  default: number;
  min: number;
  max: number;
  step: number;
  group: string;
}

export const FORMULA_SETTINGS: FormulaSettingDef[] = [
  {
    key: 'depositPct', label: 'Deposit required', help: 'Percentage of the total due to start production. Shown on the proposal and frozen onto the order when it is locked.',
    unit: '%', default: 50, min: 0, max: 100, step: 1, group: 'Proposal terms',
  },
  {
    key: 'proposalValidityDays', label: 'Proposal valid for', help: 'Default expiration date for a new proposal, counted from the proposal date.',
    unit: 'days', default: 7, min: 1, max: 365, step: 1, group: 'Proposal terms',
  },
  {
    key: 'hardwareRollupDetail', label: 'List every fastener on the Hardware Kit line',
    help: 'Off (0): the H-1000 line reads as a single kit with a piece count. On (1): every 6820H-* fastener and its quantity is printed in the line description. The price, cost and weight are the same either way — this only changes what the customer reads.',
    unit: '0 = kit only, 1 = itemize', default: 0, min: 0, max: 1, step: 1, group: 'Hardware kit',
  },
  {
    key: 'financeTaxRatePct', label: 'Customer tax rate for Section 179',
    help: 'Used only on the Ryan Capital financing sheet, to estimate the first-year tax saving. It is the CUSTOMER’s effective rate, not ours, so it is an illustration — the sheet says so and tells them to confirm it with their accountant.',
    unit: '%', default: 21, min: 0, max: 60, step: 0.5, group: 'Financing',
  },
  {
    key: 'section179CapDollars', label: 'Section 179 annual limit',
    help: 'The most a business can expense in one year. Changes most years, which is why it lives here. A purchase above the limit is only deductible up to it, and the financing sheet states that rather than overstating the saving.',
    unit: '$', default: 1000000, min: 0, max: 10000000, step: 1000, group: 'Financing',
  },
  {
    key: 'legsSmallMaxFt', label: 'Small frame up to', help: 'Frames up to this length use the small leg count.',
    unit: 'ft', default: 10, min: 1, max: 100, step: 1, group: 'Leg count by frame length',
  },
  {
    key: 'legsSmallCount', label: 'Small frame legs', help: 'Legs on a frame up to the small-frame length.',
    unit: 'legs', default: 4, min: 2, max: 20, step: 1, group: 'Leg count by frame length',
  },
  {
    key: 'legsMediumMaxFt', label: 'Medium frame up to', help: 'Frames up to this length use the medium leg count.',
    unit: 'ft', default: 20, min: 1, max: 200, step: 1, group: 'Leg count by frame length',
  },
  {
    key: 'legsMediumCount', label: 'Medium frame legs', help: 'Legs on a frame up to the medium-frame length.',
    unit: 'legs', default: 6, min: 2, max: 20, step: 1, group: 'Leg count by frame length',
  },
  {
    key: 'legsLargeCount', label: 'Long frame legs', help: 'Legs on a frame longer than the medium-frame length.',
    unit: 'legs', default: 8, min: 2, max: 40, step: 1, group: 'Leg count by frame length',
  },
];

export type FormulaSettings = Record<string, number>;

/** The declared default for every key, so a missing setting still has a real value. */
const DEFAULT_BY_KEY: Record<string, number> = Object.fromEntries(
  FORMULA_SETTINGS.map((s) => [s.key, s.default]),
);

/**
 * Read one setting. FormulaSettings is a Record, so every key is optional to the
 * compiler even though loadFormulaSettings() fills them all — this falls back to the
 * workbook default rather than 0, which would silently change the math.
 */
export function setting(s: FormulaSettings, key: string): number {
  return s[key] ?? DEFAULT_BY_KEY[key] ?? 0;
}

export function defaultSettings(): FormulaSettings {
  const out: FormulaSettings = {};
  for (const s of FORMULA_SETTINGS) out[s.key] = s.default;
  return out;
}

/** Defaults with any saved overrides applied, clamped to each setting's range. */
export function mergeSettings(rows: { key: string; value: number }[] | null | undefined): FormulaSettings {
  const out = defaultSettings();
  for (const r of rows ?? []) {
    const def = FORMULA_SETTINGS.find((s) => s.key === r.key);
    if (!def) continue;
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    out[r.key] = Math.min(def.max, Math.max(def.min, v));
  }
  return out;
}

/** Legs for a frame length, per the configurator's span table. */
export function legsForLength(lengthFt: number, s: FormulaSettings = defaultSettings()): number {
  const L = Number(lengthFt) || 0;
  if (L <= setting(s, 'legsSmallMaxFt')) return setting(s, 'legsSmallCount');
  if (L <= setting(s, 'legsMediumMaxFt')) return setting(s, 'legsMediumCount');
  return setting(s, 'legsLargeCount');
}
