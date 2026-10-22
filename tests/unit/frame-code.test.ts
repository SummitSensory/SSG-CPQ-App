import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FRAME_CODE_CONVENTION,
  LEGACY_FRAME_CODE_CONVENTION,
  FrameCodeError,
  buildFrameCode,
  conventionProblems,
  isValidFrameCode,
  normalizeFrameCode,
  parseFrameCode,
  type FrameCodeAnswers,
  type FrameCodeConvention,
} from '../../src/proposals/frameCode.js';

/**
 * The frame naming convention (Administration → Frame naming). Everything about how a
 * code prints is data; these tests pin the default (version 1), the spec's own format,
 * and conventions an admin might choose instead.
 */

const D = DEFAULT_FRAME_CODE_CONVENTION;

/** The spec's format (Frame_Code_Implementation_Prompt_1.md): bare beam digit, MB, L#,
 *  T, Z, R, dimensions last — reproducible purely as configuration. */
const SPEC: FrameCodeConvention = {
  ...D,
  features: [
    { key: 'beams', letter: '', qty: 'ALWAYS' },
    { key: 'monkeyBars', letter: 'MB', qty: 'NEVER' },
    { key: 'ladders', letter: 'L', qty: 'ALWAYS' },
    { key: 'trolley', letter: 'T', qty: 'NEVER' },
    { key: 'zipLine', letter: 'Z', qty: 'NEVER' },
    { key: 'ballRack', letter: 'R', qty: 'NEVER' },
  ],
};

const sq10: FrameCodeAnswers = {
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
};

describe('buildFrameCode — the spec test cases (spec format as configuration)', () => {
  // "2 beams" in the spec is the printed beam number: 1 interior beam + the monkey bar
  // bay, the rule the code has always used (monkeyBarsCountAsBeam).
  it.each([
    [sq10, 'SQ-2MBL2T-10x10'],
    [
      {
        length: 12,
        width: 10,
        config: 'Rectangle',
        interiorBeams: true,
        interiorBeamsQty: 1,
        monkeyBars: true,
        ladders: 2,
        trolley: true,
        zipLine: true,
        ballRack: true,
      },
      'R-2MBL2TZR-12x10',
    ],
    [
      {
        length: 10,
        width: 8,
        config: 'Rectangle',
        interiorBeams: true,
        interiorBeamsQty: 1,
        ladders: 1,
        zipLine: true,
      },
      'R-1L1Z-10x8',
    ],
    [{ length: 10, width: 10, config: 'Square' }, 'SQ-10x10'],
    [{ length: 14, width: 10, config: 'Rectangle', monkeyBars: true }, 'R-1MB-14x10'],
  ] as Array<[FrameCodeAnswers, string]>)('%#: %s', (a, expected) => {
    expect(buildFrameCode(a, SPEC)).toBe(expected);
  });

  it('refuses width greater than length — no code, no silent swap', () => {
    expect(() => buildFrameCode({ length: 8, width: 10, config: 'Rectangle' }, SPEC)).toThrow(
      FrameCodeError,
    );
  });

  it('never prints a double hyphen', () => {
    expect(buildFrameCode({ length: 10, width: 10, config: 'Square' }, D)).toBe('SQ-10x10');
  });
});

describe('buildFrameCode — the default convention (version 1)', () => {
  it('prints beams as H with their count, monkey bars as MB, trolley units', () => {
    expect(buildFrameCode(sq10, D)).toBe('SQ-H2MBL2T2-10x10');
  });

  it('shows a quantity over one where the feature says "when more than 1"', () => {
    expect(
      buildFrameCode(
        {
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
        D,
      ),
    ).toBe('R-H1MB2T1Z2R2-16x10');
  });

  it('prints decimals without trailing zeros', () => {
    expect(buildFrameCode({ length: 10.5, width: 8, config: 'Rectangle' }, D)).toBe('R-10.5x8');
  });

  it('uses the lowercase x and uppercase everything else', () => {
    const code = buildFrameCode(sq10, D);
    expect(code.replace('x', '')).toBe(code.replace('x', '').toUpperCase());
  });
});

describe('buildFrameCode — conventions an admin can choose', () => {
  it('B in place of MB, dimensions in the middle', () => {
    const c: FrameCodeConvention = {
      ...D,
      segments: ['shape', 'dimensions', 'features'],
      features: D.features.map((f) => (f.key === 'monkeyBars' ? { ...f, letter: 'B' } : f)),
    };
    expect(buildFrameCode(sq10, c)).toBe('SQ-10x10-H2BL2T2');
  });

  it('monkey bars not counted as a beam', () => {
    expect(buildFrameCode(sq10, { ...D, monkeyBarsCountAsBeam: false })).toBe('SQ-H1MBL2T2-10x10');
  });

  it('feature order is honoured', () => {
    const c: FrameCodeConvention = { ...D, features: [...D.features].reverse() };
    expect(buildFrameCode(sq10, c)).toBe('SQ-T2L2MBH2-10x10');
  });
});

describe('parseFrameCode', () => {
  it('reads a default-convention code back to its counts', () => {
    expect(parseFrameCode('SQ-H2MBL2T2-10x10', [D])).toEqual({
      shape: 'Square',
      beams: 2,
      monkeyBars: 1,
      ladders: 2,
      trolley: 2,
      zipLine: 0,
      ballRack: 0,
      length: 10,
      width: 10,
    });
  });

  it('is case-insensitive', () => {
    expect(parseFrameCode('sq-h2mbl2t2-10X10', [D])?.length).toBe(10);
  });

  it('reads a legacy code (no dimensions)', () => {
    const p = parseFrameCode('SQ-2MBL2T', [D]);
    expect(p).toMatchObject({ shape: 'Square', beams: 2, monkeyBars: 1, ladders: 2, trolley: 1 });
    expect(p?.length).toBeNull();
  });

  it.each(['SQ-1L1', 'R-3MBL2Z', 'L-5MBL2Z', 'T-1', 'R-1L1'])('reads legacy %s', (code) => {
    expect(isValidFrameCode(code, [D])).toBe(true);
  });

  it('round-trips every sample under the default and the spec conventions', () => {
    for (const c of [D, SPEC]) {
      const code = buildFrameCode(sq10, c);
      expect(parseFrameCode(code, [c])).not.toBeNull();
    }
  });

  it('rejects what is not a frame code', () => {
    expect(isValidFrameCode('A-2245', [D])).toBe(false);
    expect(isValidFrameCode('R-SSG-1010CLM', [D])).toBe(false);
    expect(isValidFrameCode('SQ-H2MBL2T2-8x10', [D])).toBe(false);
    expect(isValidFrameCode('SQ--10x10', [D])).toBe(false);
  });
});

describe('normalizeFrameCode', () => {
  it('upgrades a legacy code with its stored dimensions', () => {
    expect(normalizeFrameCode('SQ-2MBL2T', { length: 10, width: 10 }, [D])).toBe('SQ-2MBL2T-10x10');
  });

  it('canonicalises casing', () => {
    expect(normalizeFrameCode('sq-h2mbl2t2-10X10', undefined, [D])).toBe('SQ-H2MBL2T2-10x10');
  });

  it('leaves a code that already has dimensions alone', () => {
    expect(normalizeFrameCode('SQ-H2MBL2T2-10x10', { length: 12, width: 10 }, [D])).toBe(
      'SQ-H2MBL2T2-10x10',
    );
  });

  it('does not add impossible dimensions', () => {
    expect(normalizeFrameCode('SQ-2MBL2T', { length: 8, width: 10 }, [D])).toBe('SQ-2MBL2T');
  });
});

describe('conventionProblems', () => {
  it('accepts the shipped conventions', () => {
    expect(conventionProblems(D)).toEqual([]);
    expect(conventionProblems(SPEC)).toEqual([]);
  });

  it('refuses a letter that is the start of another', () => {
    const c: FrameCodeConvention = {
      ...D,
      features: D.features.map((f) =>
        f.key === 'monkeyBars'
          ? { ...f, letter: 'B' }
          : f.key === 'ballRack'
            ? { ...f, letter: 'BR' }
            : f,
      ),
    };
    expect(conventionProblems(c).join(' ')).toMatch(/start of/);
  });

  it('refuses a repeated letter, a missing segment, and a blank letter out of first place', () => {
    expect(
      conventionProblems({
        ...D,
        features: D.features.map((f) => (f.key === 'zipLine' ? { ...f, letter: 'T' } : f)),
      }).join(' '),
    ).toMatch(/both use the letter T/);
    expect(conventionProblems({ ...D, segments: ['shape', 'features'] }).length).toBeGreaterThan(0);
    expect(
      conventionProblems({
        ...D,
        features: D.features.map((f) => (f.key === 'ladders' ? { ...f, letter: '' } : f)),
      }).join(' '),
    ).toMatch(/only the first feature/);
  });

  it('the legacy convention is read-only and has no dimensions segment', () => {
    expect(conventionProblems(LEGACY_FRAME_CODE_CONVENTION).length).toBeGreaterThan(0);
  });
});
