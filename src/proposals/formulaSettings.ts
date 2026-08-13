/**
 * Business numbers behind the proposal math. Small scalars that belong to the
 * business rather than to code — deposit percentage, how long a proposal stands,
 * and the frame-size bands the configurator counts legs from — editable in
 * Administration → Formulas → Business numbers.
 */

export interface FormulaSettingDef {
  /**
   * True for numbers that re-price future work the moment they change. The editor
   * puts them behind a two-window typed confirmation and the API refuses the change
   * without it. Advisory numbers leave this unset.
   */
  confirm?: boolean;
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
    key: 'depositPct',
    label: 'Deposit required',
    help: 'Percentage of the total due to start production. Shown on the proposal and frozen onto the order when it is locked.',
    unit: '%',
    default: 50,
    min: 0,
    max: 100,
    step: 1,
    group: 'Proposal terms',
  },
  {
    key: 'proposalValidityDays',
    label: 'Proposal valid for',
    help: 'Default expiration date for a new proposal, counted from the proposal date.',
    unit: 'days',
    default: 7,
    min: 1,
    max: 365,
    step: 1,
    group: 'Proposal terms',
  },
  {
    key: 'hardwareRollupDetail',
    label: 'List every fastener on the Hardware Kit line',
    help: 'Off (0): the H-1000 line reads as a single kit with a piece count. On (1): every 6820H-* fastener and its quantity is printed in the line description. The price, cost and weight are the same either way — this only changes what the customer reads.',
    unit: '0 = kit only, 1 = itemize',
    default: 0,
    min: 0,
    max: 1,
    step: 1,
    group: 'Hardware kit',
  },
  {
    key: 'financeTaxRatePct',
    label: 'Customer tax rate for Section 179',
    help: 'Used only on the Ryan Capital financing sheet, to estimate the first-year tax saving. It is the CUSTOMER’s effective rate, not ours, so it is an illustration — the sheet says so and tells them to confirm it with their accountant.',
    unit: '%',
    default: 21,
    min: 0,
    max: 60,
    step: 0.5,
    group: 'Financing',
  },
  {
    key: 'section179CapDollars',
    label: 'Section 179 annual limit',
    help: 'The most a business can expense in one year. Changes most years, which is why it lives here. A purchase above the limit is only deductible up to it, and the financing sheet states that rather than overstating the saving.',
    unit: '$',
    default: 1000000,
    min: 0,
    max: 10000000,
    step: 1000,
    group: 'Financing',
  },
  {
    key: 'matCostPerSqFt325',
    label: 'Mat cost per sq ft — 3.25" thick',
    help: 'Vendor cost for one square foot of 3.25" padding. Sell price is this times the mat markup. Changing it re-prices every Adventure mat quoted from now on, so it asks you to type CONFIRM.',
    unit: '$/sq ft',
    default: 11.78,
    min: 0,
    max: 200,
    step: 0.01,
    group: 'Mat pricing',
    confirm: true,
  },
  {
    key: 'matCostPerSqFt2',
    label: 'Mat cost per sq ft — 2" thick',
    help: 'Vendor cost for one square foot of 2" padding. Sell price is this times the mat markup. Changing it re-prices every Adventure mat quoted from now on, so it asks you to type CONFIRM.',
    unit: '$/sq ft',
    default: 7.65,
    min: 0,
    max: 200,
    step: 0.01,
    group: 'Mat pricing',
    confirm: true,
  },
  {
    key: 'matMarkupMultiplier',
    label: 'Mat markup',
    help: 'Sell price = cost × this. 1.4 is the 140% markup that reproduces the published mat price list. Changing it re-prices every Adventure mat quoted from now on, so it asks you to type CONFIRM.',
    unit: '× cost',
    default: 1.4,
    min: 1,
    max: 5,
    step: 0.01,
    group: 'Mat pricing',
    confirm: true,
  },
  {
    key: 'matOverageIn',
    label: 'Mat overage per side',
    help: 'Inches of padding added to EACH side of the frame footprint before the area is worked out. 14" is the standard. Changing it re-sizes and re-prices every Adventure mat quoted from now on, so it asks you to type CONFIRM.',
    unit: 'in',
    default: 14,
    min: 0,
    max: 60,
    step: 0.5,
    group: 'Mat pricing',
    confirm: true,
  },
  {
    key: 'legsSmallMaxFt',
    label: "Small Frame — 10' or less",
    help: "Upper length of the Small Frame band. Frames longer than 10' always get at least six legs regardless of this setting.",
    unit: 'ft',
    default: 10,
    min: 1,
    max: 100,
    step: 1,
    group: 'Leg count by frame size',
  },
  {
    key: 'legsSmallCount',
    label: 'Small Frame legs',
    help: "Legs on a Small Frame. Only applies at 10' or less.",
    unit: 'legs',
    default: 4,
    min: 2,
    max: 20,
    step: 1,
    group: 'Leg count by frame size',
  },
  {
    key: 'legsMediumMaxFt',
    label: "Medium Size Frame — 11'\u201320'",
    help: 'Upper length of the Medium Size Frame band. Frames above the Small Frame band and up to this length use the medium leg count.',
    unit: 'ft',
    default: 20,
    min: 1,
    max: 200,
    step: 1,
    group: 'Leg count by frame size',
  },
  {
    key: 'legsMediumCount',
    label: 'Medium Size Frame legs',
    help: "Legs on a Medium Size Frame (11'\u201320').",
    unit: 'legs',
    default: 6,
    min: 2,
    max: 20,
    step: 1,
    group: 'Leg count by frame size',
  },
  {
    key: 'legsLargeCount',
    label: 'Large Frame legs',
    help: "Legs on a Large Frame (21'\u201330'), the longest frame quoted.",
    unit: 'legs',
    default: 8,
    min: 2,
    max: 40,
    step: 1,
    group: 'Leg count by frame size',
  },
];

export type FormulaSettings = Record<string, number>;

/**
 * Keys that cannot be saved without a typed CONFIRM. Derived from the definitions
 * above, so marking a setting `confirm: true` is the only place it has to be said.
 */
export const GUARDED_SETTING_KEYS: ReadonlySet<string> = new Set(
  FORMULA_SETTINGS.filter((s) => s.confirm).map((s) => s.key),
);

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
export function mergeSettings(
  rows: { key: string; value: number }[] | null | undefined,
): FormulaSettings {
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

/**
 * A frame longer than this cannot stand on four legs, whatever the settings say.
 * Engineering constraint, not a business preference, so it is not editable.
 */
export const FOUR_LEG_MAX_FT = 10;
export const MIN_LEGS_OVER_FOUR_LEG_MAX = 6;

/**
 * Legs for a frame length, per the configurator's span table.
 *
 * The bands are editable, so a saved override could put a 20' frame in the small
 * band and quote it with four legs — which is what happened. The floor below means
 * the settings can only ever raise the leg count above 10', never drop it under six.
 */
export function legsForLength(lengthFt: number, s: FormulaSettings = defaultSettings()): number {
  const L = Number(lengthFt) || 0;
  const banded =
    L <= setting(s, 'legsSmallMaxFt')
      ? setting(s, 'legsSmallCount')
      : L <= setting(s, 'legsMediumMaxFt')
        ? setting(s, 'legsMediumCount')
        : setting(s, 'legsLargeCount');
  if (L > FOUR_LEG_MAX_FT) return Math.max(banded, MIN_LEGS_OVER_FOUR_LEG_MAX);
  return banded;
}
