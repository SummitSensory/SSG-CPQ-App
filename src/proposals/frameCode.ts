/**
 * The Summit Adventure Series frame code — the model name printed on the proposal,
 * its PDF file name and everything downstream of those, e.g. `SQ-H2MBL2T2-10x10`.
 *
 * This is the only place a frame code is built or read. The naming convention is
 * data, not code: which letter each feature prints as, whether a quantity follows the
 * letter, the order of the features, and where the dimensions sit are all set in
 * Administration → Frame naming by a system admin (src/routes/frameCode.ts), and every
 * change is kept as a numbered version. A proposal stamps the version that named it on
 * its itemized heading, so a code can always be read back by the convention that wrote
 * it, whatever the convention says today.
 *
 * Which answers a feature counts — beams, monkey bars, ladders, trolley units, zip
 * lines, ball racks — is fixed here. Only how they print is configurable.
 */

import type { ClarityPageConfig } from './clarityPages.js';

export const FRAME_FEATURE_KEYS = [
  'beams',
  'monkeyBars',
  'ladders',
  'trolley',
  'zipLine',
  'ballRack',
] as const;
export type FrameFeatureKey = (typeof FRAME_FEATURE_KEYS)[number];

export const FRAME_SEGMENT_KEYS = ['shape', 'features', 'dimensions'] as const;
export type FrameSegmentKey = (typeof FRAME_SEGMENT_KEYS)[number];

export const FRAME_SHAPE_KEYS = ['Square', 'Rectangle', 'L-Shape', 'T-Shape'] as const;
export type FrameShapeKey = (typeof FRAME_SHAPE_KEYS)[number];

/**
 * When a feature's count prints after its letter:
 *   ALWAYS   — `L1`, `L2`
 *   OVER_ONE — `Z` for one zip line, `Z2` for two
 *   NEVER    — the letter alone, whatever the count
 */
export const FRAME_QTY_MODES = ['ALWAYS', 'OVER_ONE', 'NEVER'] as const;
export type FrameQtyMode = (typeof FRAME_QTY_MODES)[number];

export interface FrameFeatureSpec {
  key: FrameFeatureKey;
  /** Uppercase letters. Empty only for the first feature, and only with qty ALWAYS —
   *  the bare leading number the original convention used for beams (`2MBL2`). */
  letter: string;
  qty: FrameQtyMode;
}

export interface FrameCodeConvention {
  /** The order the three segments print in, hyphen-separated. */
  segments: FrameSegmentKey[];
  shapes: Record<FrameShapeKey, string>;
  /** Print order of the features segment. Every feature appears exactly once. */
  features: FrameFeatureSpec[];
  /**
   * Count the monkey bar run as a beam (+1 when monkey bars are on, however many
   * sets): it occupies its own bay. On reproduces the beam number the code has always
   * printed — 1 interior beam with monkey bars is beam 2.
   */
  monkeyBarsCountAsBeam: boolean;
  /**
   * What the proposal's "What's Included" and "Before You Sign" pages say about each
   * piece of the code, and the rest of those pages' wording (clarityPages.ts). Absent
   * on versions 0 and 1 and on any version saved before the pages existed, which read
   * as DEFAULT_CLARITY_PAGE.
   */
  page?: ClarityPageConfig;
}

/** Display labels for Administration and error messages. */
export const FRAME_FEATURE_LABELS: Record<FrameFeatureKey, string> = {
  beams: 'Interior beams',
  monkeyBars: 'Monkey bars',
  ladders: 'Ladders',
  trolley: 'Trolley (Dual = 2, Single = 1)',
  zipLine: 'Zip line',
  ballRack: 'Ball rack',
};
export const FRAME_SEGMENT_LABELS: Record<FrameSegmentKey, string> = {
  shape: 'Shape',
  features: 'Features',
  dimensions: 'Dimensions (length x width)',
};

/**
 * Version 0: the convention every proposal before 2026-10 was named with —
 * `SQ-2MBL2T`, no dimensions, beams as a bare leading number, T only for a Dual
 * trolley. Read-only; it exists so those codes can still be parsed.
 */
export const LEGACY_FRAME_CODE_CONVENTION: FrameCodeConvention = {
  segments: ['shape', 'features'],
  shapes: { Square: 'SQ', Rectangle: 'R', 'L-Shape': 'L', 'T-Shape': 'T' },
  features: [
    { key: 'beams', letter: '', qty: 'ALWAYS' },
    { key: 'monkeyBars', letter: 'MB', qty: 'NEVER' },
    { key: 'ladders', letter: 'L', qty: 'ALWAYS' },
    { key: 'trolley', letter: 'T', qty: 'NEVER' },
    { key: 'zipLine', letter: 'Z', qty: 'NEVER' },
    { key: 'ballRack', letter: 'R', qty: 'NEVER' },
  ],
  monkeyBarsCountAsBeam: true,
};

/**
 * Version 1, in force until a system admin saves a change: SHAPE-FEATURES-LxW with
 * interior beams as `H` and monkey bars as `MB` (Bryan, 2026-10-22).
 *
 * Never edit this once proposals carry version 1 — they would be re-read by the new
 * rules. Change the convention in Administration instead; that writes version 2+.
 */
export const DEFAULT_FRAME_CODE_CONVENTION: FrameCodeConvention = {
  segments: ['shape', 'features', 'dimensions'],
  shapes: { Square: 'SQ', Rectangle: 'R', 'L-Shape': 'L', 'T-Shape': 'T' },
  features: [
    { key: 'beams', letter: 'H', qty: 'ALWAYS' },
    { key: 'monkeyBars', letter: 'MB', qty: 'OVER_ONE' },
    { key: 'ladders', letter: 'L', qty: 'ALWAYS' },
    { key: 'trolley', letter: 'T', qty: 'ALWAYS' },
    { key: 'zipLine', letter: 'Z', qty: 'OVER_ONE' },
    { key: 'ballRack', letter: 'R', qty: 'OVER_ONE' },
  ],
  monkeyBarsCountAsBeam: true,
};

export const LEGACY_FRAME_CODE_VERSION = 0;
export const DEFAULT_FRAME_CODE_VERSION = 1;

export class FrameCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameCodeError';
  }
}

/** The configurator answers a frame code is built from (a subset of AdvAnswers). */
export interface FrameCodeAnswers {
  length?: number;
  width?: number;
  config?: string;
  ladders?: number;
  monkeyBars?: boolean;
  monkeyBarsQty?: number;
  interiorBeams?: boolean;
  interiorBeamsQty?: number;
  trolley?: boolean;
  trolleyType?: string;
  zipLine?: boolean;
  zipLineQty?: number;
  ballRack?: boolean;
  ballRackQty?: number;
}

export interface ParsedFrameCode {
  shape: FrameShapeKey;
  /** Counts. 0 = not on the frame. A feature printed without its number (qty NEVER,
   *  or OVER_ONE showing one) reads as 1. */
  beams: number;
  monkeyBars: number;
  ladders: number;
  trolley: number;
  zipLine: number;
  ballRack: number;
  /** Null when the code carries no dimensions (a version-0 code). */
  length: number | null;
  width: number | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** How many of each feature the answers put on the frame. Shared by build and the
 *  admin preview, so the two can never disagree. */
export function frameFeatureCounts(
  a: FrameCodeAnswers,
  c: Pick<FrameCodeConvention, 'monkeyBarsCountAsBeam'>,
): Record<FrameFeatureKey, number> {
  return {
    beams:
      (a.interiorBeams ? num(a.interiorBeamsQty) : 0) +
      (c.monkeyBarsCountAsBeam && a.monkeyBars ? 1 : 0),
    monkeyBars: a.monkeyBars ? num(a.monkeyBarsQty) || 1 : 0,
    ladders: num(a.ladders),
    // The same unit count the trolley parts are priced on (frameRules.ts trolleyUnits).
    trolley: a.trolley ? (a.trolleyType === 'Single' ? 1 : 2) : 0,
    zipLine: a.zipLine ? num(a.zipLineQty) || 1 : 0,
    ballRack: a.ballRack ? num(a.ballRackQty) || 1 : 0,
  };
}

/** Feet as printed: whole numbers bare, decimals without trailing zeros (10.5, never 10.50). */
export function formatFeet(v: number): string {
  return String(Number(v.toFixed(2)));
}

function shapeOf(config: string | undefined): FrameShapeKey {
  return (FRAME_SHAPE_KEYS as readonly string[]).includes(config || '')
    ? (config as FrameShapeKey)
    : 'Rectangle';
}

/**
 * Width must not exceed length — length is the long side by definition. Thrown rather
 * than swapped: a silently swapped frame is a different frame from the one the rep
 * chose, and the rule says so.
 */
export function assertFrameDimensions(length: unknown, width: unknown): void {
  const L = num(length);
  const W = num(width);
  if (!(L > 0) || !(W > 0)) {
    throw new FrameCodeError('The frame needs a length and a width before it can be named.');
  }
  if (W > L) {
    throw new FrameCodeError(
      `The frame width (${formatFeet(W)} ft) is greater than its length (${formatFeet(L)} ft). Length is the long side — correct the Frame Dimensions.`,
    );
  }
}

/**
 * One printed piece of a frame code, in print order: the shape, each feature present
 * (`MB`, `L2`), then the dimensions. Joined back together they are exactly the code.
 * They exist so the proposal's "What's Included" page can label each piece without a
 * second builder (src/proposals/clarityPages.ts).
 */
export interface FrameCodePart {
  segment: FrameSegmentKey;
  /** The shape, the feature, or 'dimensions'. */
  key: FrameShapeKey | FrameFeatureKey | 'dimensions';
  text: string;
  /** The feature's count; 1 for the shape and the dimensions. */
  count: number;
}

function partsFrom(
  shape: FrameShapeKey,
  counts: Record<FrameFeatureKey, number>,
  dims: { length: number; width: number } | null,
  convention: FrameCodeConvention,
): FrameCodePart[] {
  const parts: FrameCodePart[] = [];
  for (const seg of convention.segments) {
    if (seg === 'shape') {
      parts.push({ segment: 'shape', key: shape, text: convention.shapes[shape], count: 1 });
    } else if (seg === 'features') {
      for (const f of convention.features) {
        const count = counts[f.key];
        if (count <= 0) continue;
        const showQty = f.qty === 'ALWAYS' || (f.qty === 'OVER_ONE' && count > 1);
        parts.push({
          segment: 'features',
          key: f.key,
          text: f.letter + (showQty ? String(count) : ''),
          count,
        });
      }
    } else if (dims) {
      parts.push({
        segment: 'dimensions',
        key: 'dimensions',
        text: `${formatFeet(dims.length)}x${formatFeet(dims.width)}`,
        count: 1,
      });
    }
  }
  return parts;
}

/** Parts back into the code: segments hyphen-separated, the features run together.
 *  No features at all prints no segment: SQ-10x10, never SQ--10x10. */
export function joinFrameCodeParts(parts: FrameCodePart[]): string {
  const out: string[] = [];
  let prev: FrameSegmentKey | null = null;
  for (const p of parts) {
    if (p.segment === 'features' && prev === 'features') out[out.length - 1] += p.text;
    else out.push(p.text);
    prev = p.segment;
  }
  return out.join('-');
}

/** The frame code for a configuration, piece by piece. Throws FrameCodeError. */
export function buildFrameCodeParts(
  a: FrameCodeAnswers,
  convention: FrameCodeConvention = DEFAULT_FRAME_CODE_CONVENTION,
): FrameCodePart[] {
  const wantsDims = convention.segments.includes('dimensions');
  if (wantsDims) assertFrameDimensions(a.length, a.width);
  return partsFrom(
    shapeOf(a.config),
    frameFeatureCounts(a, convention),
    wantsDims ? { length: num(a.length), width: num(a.width) } : null,
    convention,
  );
}

/** Build the frame code for a configuration under a convention. Throws FrameCodeError. */
export function buildFrameCode(
  a: FrameCodeAnswers,
  convention: FrameCodeConvention = DEFAULT_FRAME_CODE_CONVENTION,
): string {
  return joinFrameCodeParts(buildFrameCodeParts(a, convention));
}

/** The parts of a code that parseFrameCodeWith read under the same convention. */
export function partsOfParsedFrameCode(
  parsed: ParsedFrameCode,
  convention: FrameCodeConvention,
): FrameCodePart[] {
  return partsFrom(
    parsed.shape,
    parsed,
    parsed.length != null && parsed.width != null
      ? { length: parsed.length, width: parsed.width }
      : null,
    convention,
  );
}

export const FRAME_DIMS_RE = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i;

function parseFeatures(
  text: string,
  convention: FrameCodeConvention,
): Record<FrameFeatureKey, number> | null {
  const out = { beams: 0, monkeyBars: 0, ladders: 0, trolley: 0, zipLine: 0, ballRack: 0 };
  let rest = text.toUpperCase();
  let next = 0;
  while (rest) {
    let matched = false;
    for (let i = next; i < convention.features.length; i++) {
      const f = convention.features[i]!;
      const startsHere = f.letter ? rest.startsWith(f.letter) : /^\d/.test(rest);
      if (!startsHere) continue;
      rest = rest.slice(f.letter.length);
      const digits = /^\d+/.exec(rest)?.[0] ?? '';
      if (f.qty === 'NEVER' && digits) return null;
      if (f.qty === 'ALWAYS' && !digits) return null;
      if (f.qty === 'OVER_ONE' && digits === '1') return null;
      rest = rest.slice(digits.length);
      out[f.key] = digits ? Number(digits) : 1;
      next = i + 1;
      matched = true;
      break;
    }
    if (!matched) return null;
  }
  return out;
}

/** Read a code under one convention. Null when it does not fit that convention. */
export function parseFrameCodeWith(
  code: string,
  convention: FrameCodeConvention,
): ParsedFrameCode | null {
  const parts = String(code || '')
    .trim()
    .split('-');
  // The features segment is the only optional one.
  const segs =
    parts.length === convention.segments.length
      ? convention.segments
      : parts.length === convention.segments.length - 1
        ? convention.segments.filter((s) => s !== 'features')
        : null;
  if (!segs) return null;
  let shape: FrameShapeKey | null = null;
  let feats: Record<FrameFeatureKey, number> = {
    beams: 0,
    monkeyBars: 0,
    ladders: 0,
    trolley: 0,
    zipLine: 0,
    ballRack: 0,
  };
  let length: number | null = null;
  let width: number | null = null;
  for (let i = 0; i < segs.length; i++) {
    const text = parts[i] ?? '';
    if (!text) return null;
    if (segs[i] === 'shape') {
      shape =
        FRAME_SHAPE_KEYS.find((k) => convention.shapes[k].toUpperCase() === text.toUpperCase()) ??
        null;
      if (!shape) return null;
    } else if (segs[i] === 'features') {
      const f = parseFeatures(text, convention);
      if (!f) return null;
      feats = f;
    } else {
      const m = FRAME_DIMS_RE.exec(text);
      if (!m) return null;
      length = Number(m[1]);
      width = Number(m[2]);
      if (width > length) return null;
    }
  }
  if (!shape) return null;
  return { shape, ...feats, length, width };
}

/**
 * Read a code. `conventions` are tried in order — pass the version that stamped it
 * first when it is known — then the version-0 legacy convention. Case-insensitive.
 * Null when no convention reads it.
 */
export function parseFrameCode(
  code: string,
  conventions: FrameCodeConvention[] = [DEFAULT_FRAME_CODE_CONVENTION],
): ParsedFrameCode | null {
  for (const c of [...conventions, LEGACY_FRAME_CODE_CONVENTION]) {
    const parsed = parseFrameCodeWith(code, c);
    if (parsed) return parsed;
  }
  return null;
}

export function isValidFrameCode(
  code: string,
  conventions: FrameCodeConvention[] = [DEFAULT_FRAME_CODE_CONVENTION],
): boolean {
  return parseFrameCode(code, conventions) !== null;
}

/**
 * Canonical casing — uppercase but for the dimension `x` — with the dimensions added
 * to a code that has none (a version-0 code), at the end: `SQ-2MBL2T` + 10 × 10 →
 * `SQ-2MBL2T-10x10`. The code's own letters are kept: a legacy code is not re-spelt in
 * today's convention, because its trolley count (for one) was never recorded in it.
 * Returns the input trimmed when it is not a frame code at all.
 */
export function normalizeFrameCode(
  code: string,
  dims?: { length?: number | null; width?: number | null },
  conventions: FrameCodeConvention[] = [DEFAULT_FRAME_CODE_CONVENTION],
): string {
  const raw = String(code || '').trim();
  const parsed = parseFrameCode(raw, conventions);
  if (!parsed) return raw;
  const canonical = raw
    .split('-')
    .map((p) => (FRAME_DIMS_RE.test(p) ? p.toLowerCase() : p.toUpperCase()))
    .join('-');
  if (parsed.length != null) return canonical;
  const L = num(dims?.length ?? undefined);
  const W = num(dims?.width ?? undefined);
  if (!(L > 0) || !(W > 0) || W > L) return canonical;
  return `${canonical}-${formatFeet(L)}x${formatFeet(W)}`;
}

/**
 * Every reason a convention cannot be saved. Empty means valid.
 *
 * The one rule that is not obvious: no letter may be the start of another (B and BR),
 * and no shape letter may repeat. Either makes some codes readable two ways, and a code
 * that cannot be read back cannot be checked, normalised or matched.
 */
export function conventionProblems(c: FrameCodeConvention): string[] {
  const out: string[] = [];
  const segs = Array.isArray(c?.segments) ? c.segments : [];
  if (
    segs.length !== FRAME_SEGMENT_KEYS.length ||
    FRAME_SEGMENT_KEYS.some((k) => !segs.includes(k))
  ) {
    out.push('Shape, Features and Dimensions must each appear exactly once.');
  }
  const shapeLetters: string[] = [];
  for (const k of FRAME_SHAPE_KEYS) {
    const s = c?.shapes?.[k];
    if (typeof s !== 'string' || !/^[A-Z]{1,3}$/.test(s)) {
      out.push(`${k}: the shape code must be 1–3 capital letters.`);
    } else if (shapeLetters.includes(s)) {
      out.push(`${k}: the shape code ${s} is already used by another shape.`);
    } else shapeLetters.push(s);
  }
  const feats = Array.isArray(c?.features) ? c.features : [];
  if (
    feats.length !== FRAME_FEATURE_KEYS.length ||
    FRAME_FEATURE_KEYS.some((k) => feats.filter((f) => f?.key === k).length !== 1)
  ) {
    out.push('Every feature must appear exactly once in the feature order.');
    return out;
  }
  feats.forEach((f, i) => {
    const label = FRAME_FEATURE_LABELS[f.key];
    if (!(FRAME_QTY_MODES as readonly string[]).includes(f.qty)) {
      out.push(`${label}: choose when the quantity prints.`);
    }
    if (typeof f.letter !== 'string' || !/^[A-Z]{0,3}$/.test(f.letter)) {
      out.push(`${label}: the letter must be up to 3 capital letters.`);
    } else if (!f.letter && (i !== 0 || f.qty !== 'ALWAYS')) {
      out.push(
        `${label}: only the first feature may go without a letter, and then its quantity must always print.`,
      );
    }
  });
  const letters = feats.filter((f) => f.letter);
  for (const a of letters) {
    for (const b of letters) {
      if (a === b) continue;
      if (a.letter === b.letter) {
        if (FRAME_FEATURE_KEYS.indexOf(a.key) < FRAME_FEATURE_KEYS.indexOf(b.key)) {
          out.push(
            `${FRAME_FEATURE_LABELS[a.key]} and ${FRAME_FEATURE_LABELS[b.key]} both use the letter ${a.letter}.`,
          );
        }
      } else if (b.letter.startsWith(a.letter)) {
        out.push(
          `${FRAME_FEATURE_LABELS[a.key]} (${a.letter}) is the start of ${FRAME_FEATURE_LABELS[b.key]} (${b.letter}), so some codes could be read two ways.`,
        );
      }
    }
  }
  if (typeof c?.monkeyBarsCountAsBeam !== 'boolean') {
    out.push('Choose whether monkey bars count as a beam.');
  }
  return out;
}

/**
 * The configurations the Administration preview names — the reference proposal
 * (P-2026-000194) and the spec's test cases — so a change is judged on real codes.
 */
export const FRAME_CODE_SAMPLES: Array<{ label: string; answers: FrameCodeAnswers }> = [
  {
    label: "10' × 10' square, 1 interior beam, monkey bars, 2 ladders, dual trolley",
    answers: {
      length: 10,
      width: 10,
      config: 'Square',
      interiorBeams: true,
      interiorBeamsQty: 1,
      monkeyBars: true,
      monkeyBarsQty: 1,
      ladders: 2,
      trolley: true,
      trolleyType: 'Dual',
    },
  },
  {
    label:
      "12' × 10' rectangle, 1 interior beam, monkey bars, 2 ladders, dual trolley, zip line, ball rack",
    answers: {
      length: 12,
      width: 10,
      config: 'Rectangle',
      interiorBeams: true,
      interiorBeamsQty: 1,
      monkeyBars: true,
      ladders: 2,
      trolley: true,
      trolleyType: 'Dual',
      zipLine: true,
      zipLineQty: 1,
      ballRack: true,
      ballRackQty: 1,
    },
  },
  {
    label: "10' × 8' rectangle, 1 interior beam, 1 ladder, zip line",
    answers: {
      length: 10,
      width: 8,
      config: 'Rectangle',
      interiorBeams: true,
      interiorBeamsQty: 1,
      ladders: 1,
      zipLine: true,
      zipLineQty: 1,
    },
  },
  { label: "10' × 10' square, no options", answers: { length: 10, width: 10, config: 'Square' } },
  {
    label: "14' × 10' rectangle, monkey bars only",
    answers: { length: 14, width: 10, config: 'Rectangle', monkeyBars: true, monkeyBarsQty: 1 },
  },
  {
    label: "16' × 10' rectangle, 2 monkey bar sets, single trolley, 2 zip lines, 2 ball racks",
    answers: {
      length: 16,
      width: 10,
      config: 'Rectangle',
      monkeyBars: true,
      monkeyBarsQty: 2,
      trolley: true,
      trolleyType: 'Single',
      zipLine: true,
      zipLineQty: 2,
      ballRack: true,
      ballRackQty: 2,
    },
  },
];
