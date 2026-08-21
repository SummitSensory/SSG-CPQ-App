/**
 * Frame & component quantity rules — the second half of the Adventure Series
 * engine, expressed as data so the multipliers can be corrected in the app.
 *
 * Same shape as the hardware rules (see hardwareRules.ts):
 *
 *     qty = round( (Σ coefficientᵢ × sourceᵢ + constant) × factor )
 *
 * with each term optionally gated on a configurator answer (`when`). That covers
 * every frame row of the workbook except two genuinely structural pieces, which
 * stay in code and are listed as such in Administration → Formulas:
 *
 *   • the beam-member calculator (per-length / per-width lookup with the monkey-bar
 *     offset), and
 *   • trolley rail sizing (rail part chosen from the frame length).
 */

import type { FormulaRule, RuleContext } from './hardwareRules.js';
import { FOUR_LEG_MAX_FT, MIN_LEGS_OVER_FOUR_LEG_MAX } from './formulaSettings.js';

const n = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;

/** Configurator answers the frame formulas may reference. */
export const FRAME_INPUTS: { key: string; label: string; kind: 'number' | 'flag' | 'choice' }[] = [
  { key: 'legs', label: '# of legs', kind: 'number' },
  { key: 'ladders', label: '# of ladders', kind: 'number' },
  { key: 'length', label: 'Frame length (ft)', kind: 'number' },
  { key: 'width', label: 'Frame width (ft)', kind: 'number' },
  { key: 'interiorBeams', label: '# of interior beams', kind: 'number' },
  { key: 'zipLines', label: '# of zip lines', kind: 'number' },
  { key: 'climbWalls', label: '# of climbing walls', kind: 'number' },
  { key: 'brackets', label: '# of saddle brackets', kind: 'number' },
  { key: 'config', label: 'Frame shape', kind: 'choice' },
  { key: 'monkeyBars', label: 'Monkey bars chosen', kind: 'flag' },
  { key: 'zipLine', label: 'Zip line chosen', kind: 'flag' },
  { key: 'ballRack', label: 'Ball rack chosen', kind: 'flag' },
  { key: 'slide', label: 'Slide chosen', kind: 'flag' },
  { key: 'slideGray', label: 'Gray slide upcharge', kind: 'flag' },
  { key: 'steamroller', label: 'Steamroller ramp', kind: 'flag' },
  { key: 'slideConvKit', label: 'Slide conversion kit', kind: 'flag' },
  { key: 'slideA2216', label: 'Slide deck (A-2216)', kind: 'flag' },
  // Cargo nets are quantities rather than flags so a hardware formula can be driven
  // off how many are on the job, not merely that one is.
  { key: 'cargoNet10x8', label: "# of 10' x 8' cargo nets", kind: 'number' },
  { key: 'cargoNet8x6', label: "# of 8' x 6' cargo nets", kind: 'number' },
  { key: 'climbFrame', label: 'Frame-mounted climbing wall', kind: 'flag' },
  { key: 'climbWall', label: 'Wall-mounted climbing wall', kind: 'flag' },
  { key: 'climbShield', label: 'Climbing wall safety shield', kind: 'flag' },
  { key: 'trolley', label: 'Trolley chosen', kind: 'flag' },
];

export const FRAME_SHAPES = ['Rectangle', 'Square', 'L-Shape', 'T-Shape'];

type TermSpec = [source: string | null, coefficient: number, when?: FormulaRule['when']];

const R = (
  group: string,
  part: string,
  name: string,
  terms: TermSpec[],
  extra: Partial<FormulaRule> = {},
): FormulaRule => ({
  part,
  name,
  group,
  terms: terms.map(([source, coefficient, when]) => ({
    ...(source ? { source } : {}),
    coefficient,
    ...(when ? { when } : {}),
  })),
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

const shapeIs = (value: string): FormulaRule['when'] => ({ input: 'config', op: '=', value });
const flagOn = (input: string): FormulaRule['when'] => ({ input, op: '=', value: true });

/** The v73 frame quantities. Order matches the BOM/trace output. */
export const DEFAULT_FRAME_RULES: FormulaRule[] = [
  R('Verticals', 'A-2245', 'Vertical Post', [
    ['in:legs', 1],
    ['in:ladders', -1],
  ]),
  R('Verticals', 'A-2246', 'Vertical Post — Ladder Bay', [['in:ladders', 1]]),

  R('Corner posts', 'A-2241', 'Corner Post — T-Shape', [[null, 2, shapeIs('T-Shape')]]),
  R('Corner posts', 'A-2242', 'Corner Post — Standard', [
    [null, 4, { input: 'legs', op: '>', value: 0 }],
    [null, 1, shapeIs('L-Shape')],
  ]),
  R('Corner posts', 'A-2243', 'Corner Post — Mid Run', [
    [null, 2, { input: 'legs', op: '=', value: 6 }],
    [null, 4, { input: 'legs', op: '=', value: 8 }],
    [null, -2, shapeIs('L-Shape')],
  ]),
  R('Corner posts', 'A-2244', 'Corner Post — L-Shape', [[null, 1, shapeIs('L-Shape')]]),

  R('Mid span saddle', 'A-2225', 'Mid Span Saddle', [
    ['in:interiorBeams', 2],
    [null, 2, flagOn('monkeyBars')],
  ]),

  R('Ladders', 'P-2531', 'Ladder Leg', [['in:ladders', 1]]),
  R('Ladders', 'A-2253', 'Ladder Mount', [['in:ladders', 1]]),

  R('Rungs', 'P-2330', 'Rung', [
    [null, 9, flagOn('monkeyBars')],
    ['in:ladders', 5],
  ]),

  R('Base plate shields', 'P-2028', 'Base Plate Shield', [['in:legs', 2]]),

  R('Zip line', 'P-2024', 'Zip Line Tube', [['in:zipLines', 2]], { when: flagOn('zipLine') }),
  R('Zip line', 'A-2530', 'Zip Line Collar', [['in:zipLines', 4]], { when: flagOn('zipLine') }),

  R('Ball rack', 'K-5000', 'Ball Rack', [[null, 1]], { when: flagOn('ballRack') }),

  R('Slide', 'A-2216', 'Slide', [[null, 1]], { when: flagOn('slideA2216') }),
  R('Slide', 'WS8203', 'Slide — Gray Upcharge', [[null, 1]], { when: flagOn('slideGray') }),
  R('Slide', '150045', 'Steamroller Ramp', [[null, 1]], { when: flagOn('steamroller') }),
  R('Slide', 'A-2349', 'Slide Conversion Kit', [[null, 1]], { when: flagOn('slideConvKit') }),

  R('Cargo net', 'B07V3J9S2R', "10' x 8' Climbing Cargo Net", [['in:cargoNet10x8', 1]]),
  R('Cargo net', 'B07TSDMPNQ', "8' x 6' Climbing Cargo Net", [['in:cargoNet8x6', 1]]),

  R('Climbing wall', 'SSG-SA-CFM', 'Climbing Wall — Frame Mounted', [[null, 1]], {
    when: flagOn('climbFrame'),
  }),
  R('Climbing wall', 'SSG-SA-CWM', 'Climbing Wall — Wall Mounted', [[null, 1]], {
    when: flagOn('climbWall'),
  }),
  R('Climbing wall', 'P-2500', 'Climbing Wall Safety Shield', [['in:climbWalls', 1]], {
    when: flagOn('climbShield'),
  }),

  R('Trolley', 'P-2018', 'Trolley Bar', [[null, 1]], { when: flagOn('trolley') }),
  R('Trolley', 'P-2025', 'Trolley Plate', [[null, 2]], { when: flagOn('trolley') }),
  R('Trolley', 'TRH2005', 'Threaded Rod Hanger', [[null, 6]], { when: flagOn('trolley') }),
  R('Trolley', 'TRN2016', 'Rail End Cap', [[null, 4]], { when: flagOn('trolley') }),
  R('Trolley', 'TRT2001', 'Trolley Trolley', [[null, 2]], { when: flagOn('trolley') }),

  R('Hardware', 'P-2124', 'Quick Shift Saddle Bracket', [['in:brackets', 1]]),
].map((r, i) => ({ ...r, sortOrder: i }));

/**
 * The leg count the frame actually gets.
 *
 * An entered count is taken as entered, even below the engineering minimum for the
 * length. It used to be raised silently, which is the worse failure of the two: a rep
 * typed 4 on a 14-foot frame, the parts were generated for 6, and the discrepancy
 * surfaced days later as a leg count on the freight board that nobody could explain.
 * A system that quietly replaces a number a person entered is a system they stop
 * trusting.
 *
 * The floor still applies to a count nobody entered — that is the case it was written
 * for, where an edited band setting could put a 20-foot frame in the small band and
 * derive four legs from it. Derived values get corrected; entered values get
 * questioned, by `legsBelowMinimum` and the warning it raises.
 */
function legsFloor(lengthFt: number, legs: number): number {
  const entered = Number(legs) || 0;
  if (entered > 0) return entered;
  if (lengthFt > FOUR_LEG_MAX_FT) return Math.max(entered, MIN_LEGS_OVER_FOUR_LEG_MAX);
  return entered;
}

/**
 * Is this leg count under the engineering minimum for the length?
 *
 * Reported rather than enforced, so the person building the proposal is told and
 * decides. Null when there is nothing to say.
 */
export function legsBelowMinimum(lengthFt: number, legs: number): string | null {
  const L = Number(lengthFt) || 0;
  const n = Number(legs) || 0;
  if (n <= 0 || L <= FOUR_LEG_MAX_FT || n >= MIN_LEGS_OVER_FOUR_LEG_MAX) return null;
  return `This frame is ${L}' long and is quoted on ${n} legs. Frames over ${FOUR_LEG_MAX_FT}' normally take at least ${MIN_LEGS_OVER_FOUR_LEG_MAX}. The proposal, the parts list and the freight request all use ${n} — confirm the frame with engineering before sending it.`;
}

export interface FrameAnswers {
  length?: number;
  width?: number;
  config?: string;
  legs?: number;
  ladders?: number;
  monkeyBars?: boolean;
  interiorBeams?: boolean;
  interiorBeamsQty?: number;
  trolley?: boolean;
  zipLine?: boolean;
  zipLineQty?: number;
  ballRack?: boolean;
  slide?: boolean;
  slideGray?: boolean;
  steamroller?: boolean;
  slideConvKit?: boolean;
  slideA2216?: boolean;
  cargoNet?: boolean;
  cargoNet10x8?: boolean;
  cargoNet10x8Qty?: number;
  cargoNet8x6?: boolean;
  cargoNet8x6Qty?: number;
  climbFrame?: boolean;
  climbWall?: boolean;
  climbShield?: boolean;
  brackets?: boolean;
  bracketsQty?: number;
}

/**
 * Answers → rule context. Quantities behind a toggle resolve to 0 when the toggle
 * is off, so a rule never has to re-check its own switch.
 */
export function frameContext(a: FrameAnswers, bomQty: (part: string) => number): RuleContext {
  const raw: Record<string, unknown> = {
    // Floored, not taken as given: a frame over 10 ft cannot stand on four legs, and
    // answers saved while the leg-count bands were misconfigured still hold a 4.
    legs: legsFloor(n(a.length), n(a.legs)),
    ladders: n(a.ladders),
    length: n(a.length),
    width: n(a.width),
    config: a.config || 'Rectangle',
    interiorBeams: a.interiorBeams ? n(a.interiorBeamsQty) : 0,
    zipLines: a.zipLine ? n(a.zipLineQty || 1) : 0,
    climbWalls: (a.climbFrame ? 1 : 0) + (a.climbWall ? 1 : 0),
    brackets: a.brackets ? n(a.bracketsQty) : 0,
    // A cargo net's quantity is 0 unless both the section and that size are on, so the
    // rules never re-check their own switches.
    cargoNet10x8: a.cargoNet && a.cargoNet10x8 ? Math.max(1, n(a.cargoNet10x8Qty) || 1) : 0,
    cargoNet8x6: a.cargoNet && a.cargoNet8x6 ? Math.max(1, n(a.cargoNet8x6Qty) || 1) : 0,
    monkeyBars: !!a.monkeyBars,
    zipLine: !!a.zipLine,
    ballRack: !!a.ballRack,
    slide: !!a.slide,
    slideGray: !!(a.slide && a.slideGray),
    steamroller: !!(a.slide && a.steamroller),
    // The conversion kit rides with the ramp. An undefined answer reads as on, so a
    // proposal built before the kit had its own toggle still prices the same way.
    slideConvKit: !!(a.slide && a.steamroller && (a.slideConvKit === undefined || a.slideConvKit)),
    // Undefined reads as on, so a frame quoted before the deck had its own toggle still
    // carries it — see slideA2216On() in adventureSeries.ts.
    slideA2216: !!(a.slide && (a.slideA2216 === undefined || a.slideA2216)),
    climbFrame: !!a.climbFrame,
    climbWall: !!a.climbWall,
    climbShield: !!a.climbShield,
    trolley: !!a.trolley,
  };
  return {
    bom: bomQty,
    input: (key) => {
      const v = raw[key];
      return typeof v === 'boolean' ? (v ? 1 : 0) : n(v);
    },
    raw: (key) => raw[key],
  };
}
