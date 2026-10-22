/**
 * The proposal's two "clarity pages" for the Summit Adventure Series:
 *
 *   What's Included — the frame code decoded piece by piece, then the components and
 *                     padding on the proposal.
 *   Before You Sign — the total and deposit, what is outside Summit's scope, and what
 *                     happens after signing.
 *
 * Nothing on either page is fixed in code except the defaults below. The wording, and
 * what each letter of the code is called, live in the frame naming convention
 * (frameCode.ts, `page`), so they are versioned with the letters themselves and edited
 * in the same place: Administration → Frame naming.
 *
 * The pages are computed here, from the code the proposal PRINTS and the lines on it,
 * never re-derived from the configurator: the page has to describe the document it sits
 * in. The builder keeps the result on the proposal (meta.clarityPages.snapshot), so a
 * released proposal prints the same pages however the convention changes later.
 */

import { z } from 'zod';
import {
  FRAME_DIMS_RE,
  FRAME_FEATURE_KEYS,
  FRAME_SHAPE_KEYS,
  LEGACY_FRAME_CODE_CONVENTION,
  formatFeet,
  joinFrameCodeParts,
  parseFrameCodeWith,
  partsOfParsedFrameCode,
  type FrameCodeConvention,
  type FrameCodePart,
  type FrameFeatureKey,
  type FrameSegmentKey,
  type FrameShapeKey,
} from './frameCode.js';
import { parseMatSku } from './matPricing.js';

/** The line icons the document can draw (public/proposal-document.js CLARITY_ICONS). */
export const CLARITY_ICON_KEYS = [
  'frame',
  'beams',
  'monkey',
  'ladder',
  'zip',
  'trolley',
  'rack',
  'slide',
  'wall',
  'mat',
  'net',
  'tiles',
] as const;
export type ClarityIconKey = (typeof CLARITY_ICON_KEYS)[number];

/**
 * What the page says about one piece of the frame code.
 *
 * Templates take {count}, {s} (an "s" when count is not 1), {kind} (Dual / Single, for
 * the trolley), {length} and {width}. `specTemplateMany` replaces `specTemplate` when
 * the count is over one — "Complete kit" but "2 complete kits".
 */
export interface ClarityFeatureText {
  displayName: string;
  shortLabel: string;
  description: string;
  specTemplate: string;
  specTemplateMany?: string;
  iconKey: ClarityIconKey;
  pageOrder: number;
}

export interface ClarityShapeText {
  displayName: string;
  shortLabel: string;
  description: string;
}

/**
 * A component shown under "Components, Safety & Padding". It is on the page when any
 * of its part numbers is on the proposal with a quantity. `variants` swap in a more
 * specific description when every listed part is present; the first match wins.
 */
export interface ClarityComponent {
  key: string;
  displayName: string;
  description: string;
  variants: Array<{ allSkus: string[]; description: string }>;
  specTemplate: string;
  iconKey: ClarityIconKey;
  pageOrder: number;
  active: boolean;
  skus: string[];
}

export interface ClarityMats {
  displayName: string;
  description: string;
  iconKey: ClarityIconKey;
  pageOrder: number;
  active: boolean;
  /** {length}, {width}, {thickness} — from the floor mat's part number. */
  matSpecTemplate: string;
  columnWrapSkus: string[];
  ladderWrapSkus: string[];
  /** {count}, {s}. */
  columnWrapLabel: string;
  ladderWrapLabel: string;
}

export interface ClarityScopeItem {
  key: string;
  title: string;
  description: string;
  active: boolean;
  /** Left off a proposal carrying a line whose name, heading or part number contains
   *  this text (case-insensitive) — "install" hides "Installation not included" from a
   *  proposal that quotes installation. Empty: always shown. */
  hideWhenLineMatches: string;
  /** Wording Summit has not confirmed yet. Flagged in the builder; prints as written. */
  placeholder: boolean;
}

export interface ClarityStep {
  key: string;
  title: string;
  description: string;
  /** Appended to the description when the proposal carries the mat system. */
  matsNote: string;
  placeholder: boolean;
}

export interface ClarityPageText {
  includedEyebrow: string;
  includedHeading: string;
  includedIntro: string;
  includedFooter: string;
  modelLabel: string;
  frameSectionTitle: string;
  frameSectionNote: string;
  componentSectionTitle: string;
  componentSectionNote: string;
  signEyebrow: string;
  signHeading: string;
  signIntro: string;
  signFooter: string;
  investmentTitle: string;
  investmentNote: string;
  totalLabel: string;
  depositLabel: string;
  /** {pct} — the proposal's deposit percentage. */
  depositNote: string;
  notIncludedTitle: string;
  notIncludedNote: string;
  nextTitle: string;
  nextNote: string;
  contactHeading: string;
  contactBody: string;
}

export interface ClarityPageConfig {
  text: ClarityPageText;
  shapes: Record<FrameShapeKey, ClarityShapeText>;
  /** The frame (shape) row. specNote takes {heights}. */
  frame: { iconKey: ClarityIconKey; pageOrder: number; specTemplate: string; specNote: string };
  /** Frame height options, printed in the frame row's note. */
  heights: string[];
  /** Label under the dimensions in the code panel: {length}, {width}. */
  dimensions: { shortLabel: string };
  features: Record<FrameFeatureKey, ClarityFeatureText>;
  components: ClarityComponent[];
  mats: ClarityMats;
  /** In print order. */
  notIncluded: ClarityScopeItem[];
  /** In print order. */
  steps: ClarityStep[];
}

const FRAME_DESCRIPTION = 'Free-standing, engineered, and load-analyzed for therapy use.';

/**
 * The wording the pages print until a system admin changes it (mockup:
 * Proposal_Clarity_Pages_Mockup, reference proposal P-2026-000144). Versions 0 and 1
 * and every version saved before the pages existed read as this, so do not reword it
 * in place once proposals carry it; change it in Administration → Frame naming.
 */
export const DEFAULT_CLARITY_PAGE: ClarityPageConfig = {
  text: {
    includedEyebrow: 'Your System, Decoded',
    includedHeading: "What's Included in Your Proposal",
    includedIntro:
      'Your model code describes your Summit Adventure Series frame. Each letter and number stands for a specific part of your system, giving everyone involved one clear definition of scope.',
    includedFooter: "What's Included",
    modelLabel: 'Your Model',
    frameSectionTitle: 'Frame Configuration',
    frameSectionNote: 'Defined by your model code',
    componentSectionTitle: 'Components, Safety & Padding',
    componentSectionNote: 'Added to your system',
    signEyebrow: 'Before You Sign',
    signHeading: 'Your Investment, Scope & Next Steps',
    signIntro:
      'A one-page summary for your team and anyone reviewing this proposal for approval: your investment, what falls outside Summit’s scope, and what happens once you sign.',
    signFooter: 'Before You Sign',
    investmentTitle: 'Your Investment',
    investmentNote: 'Full itemization on the pricing pages',
    totalLabel: 'Total investment',
    depositLabel: 'Deposit to begin production',
    depositNote: '{pct}% at signing · balance due prior to shipment',
    notIncludedTitle: "What's Not Included",
    notIncludedNote: 'Outside Summit’s scope for this proposal',
    nextTitle: 'What Happens Next',
    nextNote: 'From signature to installation',
    contactHeading: 'Questions before you sign?',
    contactBody:
      'If anything in this proposal doesn’t match what you expected, let us know and we’ll update it before you sign.',
  },
  shapes: {
    Square: {
      displayName: 'Square Frame',
      shortLabel: 'Square frame',
      description: FRAME_DESCRIPTION,
    },
    Rectangle: {
      displayName: 'Rectangle Frame',
      shortLabel: 'Rectangle frame',
      description: FRAME_DESCRIPTION,
    },
    'L-Shape': {
      displayName: 'L-Shape Frame',
      shortLabel: 'L-shape frame',
      description: FRAME_DESCRIPTION,
    },
    'T-Shape': {
      displayName: 'T-Shape Frame',
      shortLabel: 'T-shape frame',
      description: FRAME_DESCRIPTION,
    },
  },
  frame: {
    iconKey: 'frame',
    pageOrder: 10,
    specTemplate: "{length}' L × {width}' W",
    specNote: 'Height: {heights}',
  },
  heights: ["7'", '7\'6"', "8'"],
  dimensions: { shortLabel: "{length}' length × {width}' width" },
  features: {
    beams: {
      displayName: 'Interior Horizontal Beams',
      shortLabel: 'Interior horizontal beams',
      description: 'Add suspension and attachment points across the interior of the frame.',
      specTemplate: '{count} beam{s}',
      iconKey: 'beams',
      pageOrder: 20,
    },
    monkeyBars: {
      displayName: 'Monkey Bars',
      shortLabel: 'Monkey bars',
      description: 'Overhead rungs for hanging, upper-extremity strength, and motor planning.',
      specTemplate: 'Included',
      specTemplateMany: '{count} sets',
      iconKey: 'monkey',
      pageOrder: 30,
    },
    ladders: {
      displayName: 'Ladder',
      shortLabel: '{count} ladder set{s}',
      description:
        'A vertical ladder set for climbing, transitions, and access to overhead activities.',
      specTemplate: '{count} ladder set{s}',
      iconKey: 'ladder',
      pageOrder: 40,
    },
    trolley: {
      displayName: '{kind} Trolley',
      shortLabel: '{kind} trolley',
      description: 'An overhead track and trolley for gliding and suspended movement.',
      specTemplate: '{kind} trolley system',
      iconKey: 'trolley',
      pageOrder: 50,
    },
    zipLine: {
      displayName: 'Zip Line',
      shortLabel: 'Zip line',
      description:
        'Complete kit with tandem pulley, noise-reducing cable sleeve, and safety cover.',
      specTemplate: 'Complete kit',
      specTemplateMany: '{count} complete kits',
      iconKey: 'zip',
      pageOrder: 60,
    },
    ballRack: {
      displayName: 'Ball Rack',
      shortLabel: 'Ball rack',
      description: 'Frame-mounted storage for therapy balls.',
      specTemplate: 'Included',
      specTemplateMany: '{count} racks',
      iconKey: 'rack',
      pageOrder: 70,
    },
  },
  components: [
    {
      key: 'slide_system',
      displayName: 'Summit Adventure Slide System',
      description: 'Frame-mounted slide for the Summit Adventure Series.',
      variants: [
        {
          allSkus: ['150045', 'A-2349'],
          description: 'Steamroller ramp with the scooter board conversion kit.',
        },
        { allSkus: ['150045'], description: 'Slide with the steamroller ramp.' },
      ],
      specTemplate: 'Included',
      iconKey: 'slide',
      pageOrder: 110,
      active: true,
      skus: ['A-2216', 'WS8203', '150045', 'A-2349'],
    },
    {
      key: 'climbing_wall_frame',
      displayName: 'Climbing Wall: Frame Mounted',
      description: 'Adventure climbing wall mounted to the frame, including climbing holds.',
      variants: [],
      specTemplate: 'Included',
      iconKey: 'wall',
      pageOrder: 120,
      active: true,
      skus: ['SSG-SA-CFM'],
    },
    {
      key: 'climbing_wall_wall',
      displayName: 'Climbing Wall: Wall Mounted',
      description: 'Adventure climbing wall for metal-stud walls, including climbing holds.',
      variants: [],
      specTemplate: 'Included',
      iconKey: 'wall',
      pageOrder: 130,
      active: true,
      skus: ['SSG-SA-CWM'],
    },
  ],
  mats: {
    displayName: 'Adventure Mat System & Column Wraps',
    description: 'Floor padding under the frame, plus column and ladder leg wraps.',
    iconKey: 'mat',
    pageOrder: 140,
    active: true,
    matSpecTemplate: "{length}' × {width}' × {thickness}\" mat",
    columnWrapSkus: ['SSUSP67', 'SSCW67'],
    ladderWrapSkus: ['SSUSP72'],
    columnWrapLabel: '{count} column wrap{s}',
    ladderWrapLabel: '{count} ladder wrap{s}',
  },
  notIncluded: [
    {
      key: 'suspended_equipment',
      title: 'Swings & suspended equipment',
      description:
        'Swings, harnesses, and other suspended equipment shown in photos are not included unless listed in this proposal.',
      active: true,
      hideWhenLineMatches: '',
      placeholder: false,
    },
    {
      key: 'installation',
      title: 'Installation',
      description:
        'Not included in this proposal. Professional installation can be quoted separately.',
      active: true,
      hideWhenLineMatches: 'install',
      placeholder: true,
    },
    {
      key: 'receiving',
      title: 'Receiving & interior moving',
      description:
        'Delivery is to the nearest carrier-accessible entrance. Moving components into the room is handled by your facility.',
      active: true,
      hideWhenLineMatches: '',
      placeholder: false,
    },
    {
      key: 'permits',
      title: 'Permits & site preparation',
      description:
        'Any required permits, approvals, and site preparation are the customer’s responsibility.',
      active: true,
      hideWhenLineMatches: '',
      placeholder: false,
    },
    {
      key: 'colors',
      title: 'Color selection',
      description:
        'Frame and padding colors are selected after signing. Premium paint colors are priced separately.',
      active: true,
      hideWhenLineMatches: '',
      placeholder: false,
    },
  ],
  steps: [
    {
      key: 'sign',
      title: 'Sign & deposit',
      description: 'Approve the proposal and submit the deposit to begin production.',
      matsNote: '',
      placeholder: false,
    },
    {
      key: 'design',
      title: 'Finalize design',
      description: 'Confirm frame height, colors, and final layout with our team.',
      matsNote: '',
      placeholder: false,
    },
    {
      key: 'production',
      title: 'Production',
      description: 'Your structure is fabricated.',
      matsNote: 'Mats take 8–10 weeks.',
      placeholder: false,
    },
    {
      key: 'shipment',
      title: 'Balance & shipment',
      description: 'Final balance and actual freight are invoiced before shipping.',
      matsNote: '',
      placeholder: false,
    },
    {
      key: 'delivery',
      title: 'Delivery & install',
      description: 'Delivery to your facility and installation per your project plan.',
      matsNote: '',
      placeholder: true,
    },
  ],
};

/* ---------------- validation ---------------- */

const Str = (max: number) => z.string().max(max);
const Icon = z.enum(CLARITY_ICON_KEYS);
const Order = z.number().int().min(0).max(100_000);
const Skus = z.array(z.string().trim().min(1).max(60)).max(50);

const FeatureTextSchema = z.object({
  displayName: Str(80),
  shortLabel: Str(60),
  description: Str(240),
  specTemplate: Str(80),
  specTemplateMany: Str(80).optional(),
  iconKey: Icon,
  pageOrder: Order,
});
const ShapeTextSchema = z.object({
  displayName: Str(80),
  shortLabel: Str(60),
  description: Str(240),
});

/** The shape of `page` the admin screen saves. Meaning is checked by clarityPageProblems. */
export const ClarityPageSchema = z.object({
  text: z.object({
    includedEyebrow: Str(80),
    includedHeading: Str(120),
    includedIntro: Str(600),
    includedFooter: Str(60),
    modelLabel: Str(40),
    frameSectionTitle: Str(80),
    frameSectionNote: Str(80),
    componentSectionTitle: Str(80),
    componentSectionNote: Str(80),
    signEyebrow: Str(80),
    signHeading: Str(120),
    signIntro: Str(600),
    signFooter: Str(60),
    investmentTitle: Str(80),
    investmentNote: Str(120),
    totalLabel: Str(60),
    depositLabel: Str(60),
    depositNote: Str(160),
    notIncludedTitle: Str(80),
    notIncludedNote: Str(120),
    nextTitle: Str(80),
    nextNote: Str(120),
    contactHeading: Str(120),
    contactBody: Str(400),
  }),
  shapes: z.object({
    Square: ShapeTextSchema,
    Rectangle: ShapeTextSchema,
    'L-Shape': ShapeTextSchema,
    'T-Shape': ShapeTextSchema,
  }),
  frame: z.object({
    iconKey: Icon,
    pageOrder: Order,
    specTemplate: Str(80),
    specNote: Str(120),
  }),
  heights: z.array(Str(20)).max(8),
  dimensions: z.object({ shortLabel: Str(80) }),
  features: z.object({
    beams: FeatureTextSchema,
    monkeyBars: FeatureTextSchema,
    ladders: FeatureTextSchema,
    trolley: FeatureTextSchema,
    zipLine: FeatureTextSchema,
    ballRack: FeatureTextSchema,
  }),
  components: z
    .array(
      z.object({
        key: z.string().trim().max(40),
        displayName: Str(80),
        description: Str(240),
        variants: z
          .array(z.object({ allSkus: Skus, description: Str(240) }))
          .max(10)
          .default([]),
        specTemplate: Str(80),
        iconKey: Icon,
        pageOrder: Order,
        active: z.boolean(),
        skus: Skus,
      }),
    )
    .max(30),
  mats: z.object({
    displayName: Str(80),
    description: Str(240),
    iconKey: Icon,
    pageOrder: Order,
    active: z.boolean(),
    matSpecTemplate: Str(80),
    columnWrapSkus: Skus,
    ladderWrapSkus: Skus,
    columnWrapLabel: Str(60),
    ladderWrapLabel: Str(60),
  }),
  notIncluded: z
    .array(
      z.object({
        key: z.string().trim().max(40),
        title: Str(80),
        description: Str(300),
        active: z.boolean(),
        hideWhenLineMatches: Str(60).default(''),
        placeholder: z.boolean().default(false),
      }),
    )
    .max(12),
  steps: z
    .array(
      z.object({
        key: z.string().trim().max(40),
        title: Str(60),
        description: Str(200),
        matsNote: Str(120).default(''),
        placeholder: z.boolean().default(false),
      }),
    )
    .max(6),
});

/** Every reason the page wording cannot be saved. Empty means valid. */
export function clarityPageProblems(p: ClarityPageConfig): string[] {
  const out: string[] = [];
  const need = (v: string, what: string) => {
    if (!v || !v.trim()) out.push(`${what} cannot be empty.`);
  };
  need(p.text.includedHeading, "The What's Included heading");
  need(p.text.signHeading, 'The Before You Sign heading');
  for (const k of FRAME_SHAPE_KEYS) need(p.shapes[k].displayName, `${k}: the frame name`);
  for (const k of FRAME_FEATURE_KEYS) need(p.features[k].displayName, `${k}: the name`);

  // Two rows with one position would print in whichever order the sort happened to
  // leave them — an order nobody chose.
  const dup = (rows: Array<{ label: string; order: number }>, where: string) => {
    const seen = new Map<number, string>();
    for (const r of rows) {
      const other = seen.get(r.order);
      if (other) out.push(`${where}: ${other} and ${r.label} both have page order ${r.order}.`);
      else seen.set(r.order, r.label);
    }
  };
  dup(
    [
      { label: 'the frame', order: p.frame.pageOrder },
      ...FRAME_FEATURE_KEYS.map((k) => ({
        label: p.features[k].displayName || k,
        order: p.features[k].pageOrder,
      })),
    ],
    'Frame Configuration',
  );
  dup(
    [
      ...p.components.map((c) => ({ label: c.displayName || c.key, order: c.pageOrder })),
      { label: p.mats.displayName || 'the mat system', order: p.mats.pageOrder },
    ],
    'Components',
  );

  const keys = (list: Array<{ key: string }>, where: string) => {
    const seen = new Set<string>();
    for (const it of list) {
      if (!/^[a-z0-9_]{1,40}$/.test(it.key)) {
        out.push(`${where}: "${it.key}" is not a valid key (lowercase letters, digits, _).`);
      } else if (seen.has(it.key)) out.push(`${where}: the key ${it.key} is used twice.`);
      seen.add(it.key);
    }
  };
  keys(p.components, 'Components');
  keys(p.notIncluded, "What's Not Included");
  keys(p.steps, 'What Happens Next');
  p.components.forEach((c) => {
    need(c.displayName, `Component ${c.key}: the name`);
    if (!c.skus.length) out.push(`Component ${c.key}: list at least one part number.`);
  });
  p.notIncluded.forEach((it) => need(it.title, `What's Not Included ${it.key}: the title`));
  p.steps.forEach((s) => need(s.title, `What Happens Next ${s.key}: the title`));
  return out;
}

/**
 * The page wording a convention carries, with anything it lacks taken from the
 * default — a version saved before a field existed still renders.
 */
export function clarityPageOf(c: Pick<FrameCodeConvention, 'page'>): ClarityPageConfig {
  const p = c.page;
  const d = DEFAULT_CLARITY_PAGE;
  if (!p) return d;
  return {
    text: { ...d.text, ...p.text },
    shapes: { ...d.shapes, ...p.shapes },
    frame: { ...d.frame, ...p.frame },
    heights: Array.isArray(p.heights) ? p.heights : d.heights,
    dimensions: { ...d.dimensions, ...p.dimensions },
    features: { ...d.features, ...p.features },
    components: Array.isArray(p.components) ? p.components : d.components,
    mats: { ...d.mats, ...p.mats },
    notIncluded: Array.isArray(p.notIncluded) ? p.notIncluded : d.notIncluded,
    steps: Array.isArray(p.steps) ? p.steps : d.steps,
  };
}

/* ---------------- decoding the printed code ---------------- */

export interface ConventionVersion {
  version: number;
  convention: FrameCodeConvention;
}

export interface DecodedFrameCode {
  version: number;
  convention: FrameCodeConvention;
  shape: FrameShapeKey;
  parts: FrameCodePart[];
  length: number | null;
  width: number | null;
}

/**
 * Read the code a proposal prints, piece by piece, and say which convention version
 * wrote it. Newest version first, so a draft reads by today's wording wherever its code
 * still fits today's letters.
 *
 * A code from before dimensions were part of it (version 0) prints with them added —
 * `R-2MBL1Z` + 10 × 8 → `R-2MBL1Z-10x8` (normalizeFrameCode) — and is read that way
 * too: the trailing size is taken off, the rest read by version 0.
 */
export function decodeFrameCode(
  code: string,
  versions: ConventionVersion[],
): DecodedFrameCode | null {
  const raw = String(code || '').trim();
  if (!raw) return null;
  const newestFirst = [...versions].sort((a, b) => b.version - a.version);
  for (const v of newestFirst) {
    const parsed = parseFrameCodeWith(raw, v.convention);
    if (parsed) {
      return {
        version: v.version,
        convention: v.convention,
        shape: parsed.shape,
        parts: partsOfParsedFrameCode(parsed, v.convention),
        length: parsed.length,
        width: parsed.width,
      };
    }
  }
  const pieces = raw.split('-');
  const dims = FRAME_DIMS_RE.exec(pieces[pieces.length - 1] ?? '');
  if (!dims || pieces.length < 2) return null;
  const legacy = versions.find((v) => v.version === 0) ?? {
    version: 0,
    convention: LEGACY_FRAME_CODE_CONVENTION,
  };
  const parsed = parseFrameCodeWith(pieces.slice(0, -1).join('-'), legacy.convention);
  if (!parsed) return null;
  const length = Number(dims[1]);
  const width = Number(dims[2]);
  return {
    version: legacy.version,
    convention: legacy.convention,
    shape: parsed.shape,
    parts: [
      ...partsOfParsedFrameCode(parsed, legacy.convention),
      {
        segment: 'dimensions',
        key: 'dimensions',
        text: `${formatFeet(length)}x${formatFeet(width)}`,
        count: 1,
      },
    ],
    length,
    width,
  };
}

/* ---------------- the pages ---------------- */

/** A proposal line, as much of it as the pages read. */
export interface ClarityLine {
  lineType?: string;
  name?: string;
  sku?: string;
  quantity?: number;
}

export interface ClarityInput {
  /** The model code as the proposal prints it (the itemized heading). */
  code: string;
  lines: ClarityLine[];
  /** The configurator's Frame Dimensions and trolley answer, when the proposal has them. */
  answers?: { length?: number; width?: number; trolleyType?: string } | null;
}

export interface ClarityRow {
  key: string;
  /** The code piece in the badge; null for a component (dashed, empty badge). */
  badge: string | null;
  iconKey: ClarityIconKey;
  name: string;
  description: string;
  spec: string;
  specNote: string;
}

export interface ClaritySnapshot {
  conventionVersion: number;
  code: string;
  /** The code panel, in code order. */
  parts: Array<{ segment: FrameSegmentKey; text: string; label: string }>;
  frameRows: ClarityRow[];
  componentRows: ClarityRow[];
  /** Every applicable item; the builder can hide any of them on one proposal. */
  notIncluded: Array<{ key: string; title: string; description: string; placeholder: boolean }>;
  steps: Array<{ key: string; title: string; description: string; placeholder: boolean }>;
  text: ClarityPageText;
}

/** Fill a template's {tokens}. Unknown tokens print empty rather than as braces. */
export function fillTemplate(tpl: string, vars: Record<string, string | number>): string {
  const count = Number(vars.count);
  return String(tpl || '')
    .replace(/\{s\}/g, Number.isFinite(count) && count !== 1 ? 's' : '')
    .replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] == null ? '' : String(vars[k])))
    .trim();
}

/** "7', 7'6\", or 8'" */
function listWithOr(items: string[]): string {
  const xs = items.filter((s) => s && s.trim());
  if (xs.length <= 1) return xs.join('');
  if (xs.length === 2) return `${xs[0]} or ${xs[1]}`;
  return `${xs.slice(0, -1).join(', ')}, or ${xs[xs.length - 1]}`;
}

const qtyOf = (l: ClarityLine): number => {
  const q = Number(l.quantity);
  return Number.isFinite(q) ? q : 0;
};
const isProduct = (l: ClarityLine) => (l.lineType || 'PRODUCT') === 'PRODUCT' && qtyOf(l) > 0;
const skuOf = (l: ClarityLine) =>
  String(l.sku || '')
    .trim()
    .toUpperCase();

/** Total quantity on the proposal of any of these part numbers. */
export function quantityOfSkus(lines: ClarityLine[], skus: string[]): number {
  const want = new Set(skus.map((s) => s.trim().toUpperCase()));
  return lines.reduce((s, l) => (isProduct(l) && want.has(skuOf(l)) ? s + qtyOf(l) : s), 0);
}

/** The floor mat on the proposal, read from its part number (matPricing.ts). */
export function matOnProposal(
  lines: ClarityLine[],
): { lengthFt: number; widthFt: number; thickness: string } | null {
  for (const l of lines) {
    if (!isProduct(l)) continue;
    const m = parseMatSku(l.sku);
    if (m) return m;
  }
  return null;
}

/** "Adventure Mat System — CUSTOM": a mat with no size yet. */
const customMatOn = (lines: ClarityLine[]) =>
  lines.some((l) => isProduct(l) && /adventure mat system\s*[—-]\s*custom/i.test(l.name || ''));

/**
 * Both pages' content for one proposal, or null when its code cannot be read (not an
 * Adventure Series proposal, or a heading a rep has retyped into something else).
 */
export function computeClarityPages(
  input: ClarityInput,
  versions: ConventionVersion[],
): ClaritySnapshot | null {
  const decoded = decodeFrameCode(input.code, versions);
  if (!decoded) return null;
  const page = clarityPageOf(decoded.convention);
  const lines = Array.isArray(input.lines) ? input.lines : [];

  // Frame Dimensions as the configurator holds them; the code's own size only when the
  // proposal has no configurator answers to read.
  const aL = Number(input.answers?.length);
  const aW = Number(input.answers?.width);
  const L = aL > 0 ? aL : decoded.length;
  const W = aW > 0 ? aW : decoded.width;
  const dimVars = {
    length: L != null ? formatFeet(L) : '',
    width: W != null ? formatFeet(W) : '',
  };
  // A code named before dimensions were part of it (version 0, `R-2MBL1Z`) prints with
  // the frame's size added at the end, as normalizeFrameCode does everywhere else:
  // R-2MBL1Z-10x8. Its own letters are kept.
  if (!decoded.parts.some((p) => p.segment === 'dimensions') && L != null && W != null && W <= L) {
    decoded.parts.push({
      segment: 'dimensions',
      key: 'dimensions',
      text: `${formatFeet(L)}x${formatFeet(W)}`,
      count: 1,
    });
  }

  const trolleyCount = decoded.parts.find((p) => p.key === 'trolley')?.count ?? 0;
  const kind =
    input.answers?.trolleyType === 'Single' || input.answers?.trolleyType === 'Dual'
      ? input.answers.trolleyType
      : trolleyCount === 1 &&
          decoded.convention.features.find((f) => f.key === 'trolley')?.qty !== 'NEVER'
        ? 'Single'
        : 'Dual';

  const shapeText = page.shapes[decoded.shape];
  const parts = decoded.parts.map((p) => {
    let label = '';
    if (p.segment === 'shape') label = shapeText.shortLabel;
    else if (p.segment === 'dimensions') label = fillTemplate(page.dimensions.shortLabel, dimVars);
    else {
      const f = page.features[p.key as FrameFeatureKey];
      label = f ? fillTemplate(f.shortLabel, { count: p.count, kind, ...dimVars }) : '';
    }
    return { segment: p.segment, text: p.text, label };
  });

  const frameRows: Array<ClarityRow & { order: number }> = [];
  const shapePart = decoded.parts.find((p) => p.segment === 'shape');
  frameRows.push({
    key: 'frame',
    order: page.frame.pageOrder,
    badge: shapePart ? shapePart.text : null,
    iconKey: page.frame.iconKey,
    name: shapeText.displayName,
    description: shapeText.description,
    spec: L != null && W != null ? fillTemplate(page.frame.specTemplate, dimVars) : '',
    specNote: fillTemplate(page.frame.specNote, { heights: listWithOr(page.heights) }),
  });
  for (const p of decoded.parts) {
    if (p.segment !== 'features') continue;
    const f = page.features[p.key as FrameFeatureKey];
    if (!f) continue;
    const vars = { count: p.count, kind, ...dimVars };
    frameRows.push({
      key: p.key,
      order: f.pageOrder,
      badge: p.text,
      iconKey: f.iconKey,
      name: fillTemplate(f.displayName, vars),
      description: fillTemplate(f.description, vars),
      spec: fillTemplate(
        p.count > 1 && f.specTemplateMany ? f.specTemplateMany : f.specTemplate,
        vars,
      ),
      specNote: '',
    });
  }

  const onProposal = new Set(lines.filter(isProduct).map(skuOf));
  const componentRows: Array<ClarityRow & { order: number }> = [];
  for (const c of page.components) {
    if (!c.active) continue;
    const count = quantityOfSkus(lines, c.skus);
    if (count <= 0) continue;
    const variant = c.variants.find(
      (v) => v.allSkus.length > 0 && v.allSkus.every((s) => onProposal.has(s.trim().toUpperCase())),
    );
    componentRows.push({
      key: c.key,
      order: c.pageOrder,
      badge: null,
      iconKey: c.iconKey,
      name: c.displayName,
      description: variant ? variant.description : c.description,
      spec: fillTemplate(c.specTemplate, { count }),
      specNote: '',
    });
  }

  const mat = matOnProposal(lines);
  const columnWraps = quantityOfSkus(lines, page.mats.columnWrapSkus);
  const ladderWraps = quantityOfSkus(lines, page.mats.ladderWrapSkus);
  const matsOn = !!mat || customMatOn(lines) || columnWraps > 0 || ladderWraps > 0;
  if (page.mats.active && matsOn) {
    const wraps = [
      columnWraps > 0 ? fillTemplate(page.mats.columnWrapLabel, { count: columnWraps }) : '',
      ladderWraps > 0 ? fillTemplate(page.mats.ladderWrapLabel, { count: ladderWraps }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const matSpec = mat
      ? fillTemplate(page.mats.matSpecTemplate, {
          length: formatFeet(mat.lengthFt),
          width: formatFeet(mat.widthFt),
          thickness: mat.thickness,
        })
      : '';
    componentRows.push({
      key: 'mats',
      order: page.mats.pageOrder,
      badge: null,
      iconKey: page.mats.iconKey,
      name: page.mats.displayName,
      description: page.mats.description,
      spec: matSpec || wraps,
      specNote: matSpec ? wraps : '',
    });
  }

  const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;
  const strip = ({ order: _order, ...row }: ClarityRow & { order: number }): ClarityRow => row;

  const lineText = lines.map((l) => `${l.name || ''} ${l.sku || ''}`.toLowerCase());
  const notIncluded = page.notIncluded
    .filter((it) => it.active)
    .filter((it) => {
      const needle = (it.hideWhenLineMatches || '').trim().toLowerCase();
      return !needle || !lineText.some((t) => t.includes(needle));
    })
    .map((it) => ({
      key: it.key,
      title: it.title,
      description: it.description,
      placeholder: !!it.placeholder,
    }));

  const steps = page.steps.map((s) => ({
    key: s.key,
    title: s.title,
    description: [s.description, matsOn && s.matsNote ? s.matsNote : '']
      .filter((x) => x && x.trim())
      .join(' '),
    placeholder: !!s.placeholder,
  }));

  return {
    conventionVersion: decoded.version,
    code: joinFrameCodeParts(decoded.parts),
    parts,
    frameRows: frameRows.sort(byOrder).map(strip),
    componentRows: componentRows.sort(byOrder).map(strip),
    notIncluded,
    steps,
    text: page.text,
  };
}
