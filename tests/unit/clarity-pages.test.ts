import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLARITY_PAGE,
  clarityPageProblems,
  computeClarityPages,
  decodeFrameCode,
  fillTemplate,
  type ClarityLine,
  type ClarityPageConfig,
  type ConventionVersion,
} from '../../src/proposals/clarityPages.js';
import {
  DEFAULT_FRAME_CODE_CONVENTION,
  LEGACY_FRAME_CODE_CONVENTION,
  buildFrameCode,
  buildFrameCodeParts,
  joinFrameCodeParts,
  type FrameCodeConvention,
} from '../../src/proposals/frameCode.js';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const BUILT_IN: ConventionVersion[] = [
  { version: 0, convention: LEGACY_FRAME_CODE_CONVENTION },
  { version: 1, convention: DEFAULT_FRAME_CODE_CONVENTION },
];

const P = (sku: string, quantity = 1, name = ''): ClarityLine => ({
  lineType: 'PRODUCT',
  sku,
  quantity,
  name,
});

/** P-2026-000144 Rev 1, The Baby Fold — the mockup's reference proposal. */
const BABY_FOLD_LINES: ClarityLine[] = [
  { lineType: 'GROUP', name: 'R-2MBL1Z — Itemized' },
  P('A-2245', 4),
  { lineType: 'GROUP', name: 'Adventure Components' },
  { lineType: 'SUBGROUP', name: 'Summit Adventure Slide System' },
  P('A-2216'),
  P('150045'),
  P('A-2349'),
  { lineType: 'SUBGROUP', name: 'Climbing Wall & Safety Accessories' },
  P('SSG-SA-CWM'),
  { lineType: 'GROUP', name: 'Adventure Mat System' },
  P('R-SSG-1008CLM', 1, "Adventure Floor Mat System (10' x 8' x 3.25\")"),
  P('SSUSP67', 4),
  P('SSUSP72', 1),
  { lineType: 'NOTE', name: 'Mat System' },
];

describe('frame code parts', () => {
  it('join back into exactly the code buildFrameCode prints', () => {
    const a = {
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
      zipLineQty: 2,
    };
    for (const c of [DEFAULT_FRAME_CODE_CONVENTION, LEGACY_FRAME_CODE_CONVENTION]) {
      expect(joinFrameCodeParts(buildFrameCodeParts(a, c))).toBe(buildFrameCode(a, c));
    }
    expect(buildFrameCode(a)).toBe('R-H2MBL2T2Z2-12x10');
  });

  it('a frame with no options has no features segment', () => {
    expect(buildFrameCode({ length: 10, width: 10, config: 'Square' })).toBe('SQ-10x10');
  });
});

describe('decodeFrameCode', () => {
  it('reads a pre-dimension code with its size appended by version 0', () => {
    const d = decodeFrameCode('R-2MBL1Z-10x8', BUILT_IN)!;
    expect(d.version).toBe(0);
    expect(d.parts.map((p) => p.text)).toEqual(['R', '2', 'MB', 'L1', 'Z', '10x8']);
  });

  it('reads a current code by the newest version it fits', () => {
    const d = decodeFrameCode('SQ-H2MBL2T2-10x10', BUILT_IN)!;
    expect(d.version).toBe(1);
    expect(d.parts.map((p) => p.text)).toEqual(['SQ', 'H2', 'MB', 'L2', 'T2', '10x10']);
  });

  it('returns null for a heading that is not a frame code', () => {
    expect(decodeFrameCode('Frame Configuration', BUILT_IN)).toBeNull();
    expect(decodeFrameCode('', BUILT_IN)).toBeNull();
  });
});

describe('What’s Included — The Baby Fold (P-2026-000144 Rev 1)', () => {
  const s = computeClarityPages(
    { code: 'R-2MBL1Z-10x8', lines: BABY_FOLD_LINES, answers: { length: 10, width: 8 } },
    BUILT_IN,
  )!;

  it('prints the model code and one panel column per piece, dimensions last', () => {
    expect(s.code).toBe('R-2MBL1Z-10x8');
    expect(s.parts.map((p) => [p.text, p.label])).toEqual([
      ['R', 'Rectangle frame'],
      ['2', 'Interior horizontal beams'],
      ['MB', 'Monkey bars'],
      ['L1', '1 ladder set'],
      ['Z', 'Zip line'],
      ['10x8', "10' length × 8' width"],
    ]);
  });

  it('section 01 rows: R, 2, MB, L1, Z with their specs', () => {
    expect(s.frameRows.map((r) => r.badge)).toEqual(['R', '2', 'MB', 'L1', 'Z']);
    expect(s.frameRows[0]).toMatchObject({
      name: 'Rectangle Frame',
      spec: "10' L × 8' W",
      specNote: "Height: 7', 7'6\", or 8'",
    });
    expect(s.frameRows.map((r) => r.spec)).toEqual([
      "10' L × 8' W",
      '2 beams',
      'Included',
      '1 ladder set',
      'Complete kit',
    ]);
  });

  it('section 02: slide (steamroller + kit), wall-mounted wall, mats with wrap counts', () => {
    expect(s.componentRows.map((r) => r.name)).toEqual([
      'Summit Adventure Slide System',
      'Climbing Wall: Wall Mounted',
      'Adventure Mat System & Column Wraps',
    ]);
    expect(s.componentRows[0]!.description).toBe(
      'Steamroller ramp with the scooter board conversion kit.',
    );
    expect(s.componentRows.every((r) => r.badge === null)).toBe(true);
    expect(s.componentRows[2]).toMatchObject({
      spec: "10' × 8' × 3.25\" mat",
      specNote: '4 column wraps · 1 ladder wrap',
    });
  });

  it('Before You Sign: all five scope items (no installation line) and the mats note', () => {
    expect(s.notIncluded.map((i) => i.key)).toEqual([
      'suspended_equipment',
      'installation',
      'receiving',
      'permits',
      'colors',
    ]);
    expect(s.steps[2]!.description).toBe('Your structure is fabricated. Mats take 8–10 weeks.');
    expect(s.steps.map((x) => x.placeholder)).toEqual([false, false, false, false, true]);
  });
});

describe('What’s Included — Soar Autism Center (P-2026-000194)', () => {
  const s = computeClarityPages(
    {
      code: 'SQ-2MBL2T-10x10',
      lines: [P('SSG-SA-CWM')],
      answers: { length: 10, width: 10, trolleyType: 'Dual' },
    },
    BUILT_IN,
  )!;
  it('2 ladder sets, Dual Trolley and the wall-mounted climbing wall', () => {
    expect(s.frameRows.map((r) => r.badge)).toEqual(['SQ', '2', 'MB', 'L2', 'T']);
    expect(s.frameRows.find((r) => r.key === 'ladders')!.spec).toBe('2 ladder sets');
    expect(s.frameRows.find((r) => r.key === 'trolley')!.name).toBe('Dual Trolley');
    expect(s.componentRows.map((r) => r.name)).toEqual(['Climbing Wall: Wall Mounted']);
  });
  it('no mats: no mat row and no mats note', () => {
    expect(s.componentRows.some((r) => r.key === 'mats')).toBe(false);
    expect(s.steps[2]!.description).toBe('Your structure is fabricated.');
  });
});

describe('a heading named before dimensions were in the code', () => {
  it('R-2MBL1Z + Frame Dimensions 10 × 8 prints R-2MBL1Z-10x8, dimensions last', () => {
    const s = computeClarityPages(
      { code: 'R-2MBL1Z', lines: BABY_FOLD_LINES, answers: { length: 10, width: 8 } },
      BUILT_IN,
    )!;
    expect(s.conventionVersion).toBe(0);
    expect(s.code).toBe('R-2MBL1Z-10x8');
    expect(s.parts.map((p) => p.text)).toEqual(['R', '2', 'MB', 'L1', 'Z', '10x8']);
    expect(s.parts[5]!.label).toBe("10' length × 8' width");
  });
});

describe('edge cases', () => {
  it('no options (SQ-10x10): only the frame row, no components', () => {
    const s = computeClarityPages({ code: 'SQ-10x10', lines: [] }, BUILT_IN)!;
    expect(s.parts.map((p) => p.text)).toEqual(['SQ', '10x10']);
    expect(s.frameRows.map((r) => r.key)).toEqual(['frame']);
    expect(s.frameRows[0]!.spec).toBe("10' L × 10' W");
    expect(s.componentRows).toEqual([]);
  });

  it('a single trolley on the current convention reads Single', () => {
    const s = computeClarityPages({ code: 'R-T1-12x10', lines: [] }, BUILT_IN)!;
    expect(s.frameRows.find((r) => r.key === 'trolley')!.name).toBe('Single Trolley');
  });

  it('an installation line drops "Installation" from What’s Not Included', () => {
    const s = computeClarityPages(
      { code: 'SQ-10x10', lines: [P('INSTALL-1', 1, 'Professional Installation')] },
      BUILT_IN,
    )!;
    expect(s.notIncluded.map((i) => i.key)).not.toContain('installation');
  });

  it('wraps without a floor mat still show the mat row, wraps as the spec', () => {
    const s = computeClarityPages(
      { code: 'SQ-10x10', lines: [P('SSCW67', 2), P('SSUSP67', 2)] },
      BUILT_IN,
    )!;
    expect(s.componentRows[0]).toMatchObject({ spec: '4 column wraps', specNote: '' });
  });

  it('a component with quantity 0 is not included', () => {
    const s = computeClarityPages({ code: 'SQ-10x10', lines: [P('SSG-SA-CFM', 0)] }, BUILT_IN)!;
    expect(s.componentRows).toEqual([]);
  });

  it('the largest configuration keeps every feature row, in page order', () => {
    const code = buildFrameCode({
      length: 20,
      width: 10,
      config: 'Rectangle',
      interiorBeams: true,
      interiorBeamsQty: 3,
      monkeyBars: true,
      monkeyBarsQty: 2,
      ladders: 4,
      trolley: true,
      trolleyType: 'Dual',
      zipLine: true,
      zipLineQty: 2,
      ballRack: true,
      ballRackQty: 2,
    });
    const s = computeClarityPages(
      {
        code,
        lines: [P('A-2216'), P('SSG-SA-CFM'), P('SSG-SA-CWM'), P('R-SSG-2010CLM-2')],
      },
      BUILT_IN,
    )!;
    expect(s.frameRows.map((r) => r.key)).toEqual([
      'frame',
      'beams',
      'monkeyBars',
      'ladders',
      'trolley',
      'zipLine',
      'ballRack',
    ]);
    expect(s.componentRows).toHaveLength(4);
    expect(s.componentRows[3]!.spec).toBe("20' × 10' × 2\" mat");
  });
});

describe('the convention is data', () => {
  /** Admin changes MB → M and moves ladders ahead of monkey bars, as version 2. */
  const v2: FrameCodeConvention = (() => {
    const c = clone(DEFAULT_FRAME_CODE_CONVENTION);
    c.features.find((f) => f.key === 'monkeyBars')!.letter = 'M';
    const li = c.features.findIndex((f) => f.key === 'ladders');
    const mi = c.features.findIndex((f) => f.key === 'monkeyBars');
    [c.features[li], c.features[mi]] = [c.features[mi]!, c.features[li]!];
    const page = clone(DEFAULT_CLARITY_PAGE);
    page.features.monkeyBars.displayName = 'Overhead Monkey Bars';
    page.features.ladders.pageOrder = 25;
    c.page = page;
    return c;
  })();
  const versions = [...BUILT_IN, { version: 2, convention: v2 }];
  const answers = {
    length: 10,
    width: 8,
    config: 'Rectangle',
    interiorBeams: true,
    interiorBeamsQty: 1,
    monkeyBars: true,
    ladders: 1,
  };

  it('a new code uses the new letter and order; the panel and rows follow', () => {
    const code = buildFrameCode(answers, v2);
    expect(code).toBe('R-H2L1M-10x8');
    const s = computeClarityPages({ code, lines: [] }, versions)!;
    expect(s.conventionVersion).toBe(2);
    expect(s.parts.map((p) => p.text)).toEqual(['R', 'H2', 'L1', 'M', '10x8']);
    expect(s.frameRows.map((r) => r.badge)).toEqual(['R', 'H2', 'L1', 'M']);
    expect(s.frameRows.find((r) => r.key === 'monkeyBars')!.name).toBe('Overhead Monkey Bars');
  });

  it('a code named before the change still reads by its own version and wording', () => {
    const code = buildFrameCode(answers, DEFAULT_FRAME_CODE_CONVENTION);
    expect(code).toBe('R-H2MBL1-10x8');
    const s = computeClarityPages({ code, lines: [] }, versions)!;
    expect(s.conventionVersion).toBe(1);
    expect(s.frameRows.map((r) => r.badge)).toEqual(['R', 'H2', 'MB', 'L1']);
    expect(s.frameRows.find((r) => r.key === 'monkeyBars')!.name).toBe('Monkey Bars');
  });
});

describe('clarityPageProblems', () => {
  it('the default wording is valid', () => {
    expect(clarityPageProblems(DEFAULT_CLARITY_PAGE)).toEqual([]);
  });
  it('refuses duplicate page orders and duplicate keys', () => {
    const p: ClarityPageConfig = clone(DEFAULT_CLARITY_PAGE);
    p.features.ladders.pageOrder = p.features.beams.pageOrder;
    p.notIncluded.push({ ...p.notIncluded[0]! });
    const problems = clarityPageProblems(p);
    expect(problems.some((x) => /page order 20/.test(x))).toBe(true);
    expect(problems.some((x) => /suspended_equipment is used twice/.test(x))).toBe(true);
  });
});

describe('fillTemplate', () => {
  it('fills tokens and plurals', () => {
    expect(fillTemplate('{count} ladder set{s}', { count: 1 })).toBe('1 ladder set');
    expect(fillTemplate('{count} ladder set{s}', { count: 2 })).toBe('2 ladder sets');
    expect(fillTemplate('{pct}% at signing', { pct: 50 })).toBe('50% at signing');
    expect(fillTemplate('{nope}x', {})).toBe('x');
  });
});
