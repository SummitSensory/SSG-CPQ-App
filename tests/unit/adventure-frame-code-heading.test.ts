import { describe, it, expect } from 'vitest';
import {
  computeAdventureProposal,
  computeAdventureBOM,
  explainAdventure,
  type AdvAnswers,
} from '../../src/proposals/adventureSeries.js';
import { DEFAULT_FRAME_CODE_CONVENTION } from '../../src/proposals/frameCode.js';

/**
 * The itemized frame heading carries the frame code under the convention in force,
 * stamps the version that named it, and keeps the "Frame Dimensions" note (a Canadian
 * proposal's Section A description is read from it). The ball rack is priced per rack.
 */

const frame = (over: Partial<AdvAnswers> = {}): AdvAnswers => ({
  length: 10,
  width: 10,
  config: 'Square',
  legs: 4,
  ladders: 2,
  monkeyBars: true,
  interiorBeams: true,
  interiorBeamsQty: 1,
  trolley: true,
  trolleyType: 'Dual',
  ...over,
});

const headingOf = (lines: ReturnType<typeof computeAdventureProposal>['lines']) =>
  lines.find((l) => l.lineType === 'GROUP' && /itemized/i.test(l.name))!;

describe('itemized frame heading', () => {
  it('prints the default-convention code and stamps version 1', () => {
    const h = headingOf(computeAdventureProposal(frame()).lines);
    expect(h.name).toBe('SQ-H2MBL2T2-10x10 — Itemized');
    expect(h.description).toBe("Frame Dimensions: 10' × 10'");
    expect(h).toMatchObject({
      frameCode: 'SQ-H2MBL2T2-10x10',
      frameCodeVersion: 1,
      frameLength: 10,
      frameWidth: 10,
    });
  });

  it('follows a saved convention and stamps its version', () => {
    const convention = {
      ...DEFAULT_FRAME_CODE_CONVENTION,
      segments: ['shape', 'dimensions', 'features'] as const,
      features: DEFAULT_FRAME_CODE_CONVENTION.features.map((f) =>
        f.key === 'monkeyBars' ? { ...f, letter: 'B' } : f,
      ),
    };
    const h = headingOf(
      computeAdventureProposal(frame(), undefined, undefined, undefined, undefined, undefined, {
        version: 7,
        convention: { ...convention, segments: [...convention.segments] },
      }).lines,
    );
    expect(h.name).toBe('SQ-10x10-H2BL2T2 — Itemized');
    expect(h.frameCodeVersion).toBe(7);
  });

  it('names no code for width greater than length, and keeps the note', () => {
    const h = headingOf(computeAdventureProposal(frame({ length: 8, width: 10 })).lines);
    expect(h.name).toBe('Frame Configuration — Itemized');
    expect(h.frameCode).toBeUndefined();
    expect(h.description).toMatch(/Frame Dimensions/);
  });

  it('the calculation trace reports the same code', () => {
    expect(explainAdventure(frame()).model).toBe('SQ-H2MBL2T2-10x10');
  });
});

describe('ball rack quantity', () => {
  const k5000 = (a: AdvAnswers) =>
    computeAdventureBOM(a)
      .filter((b) => b.part === 'K-5000')
      .reduce((s, b) => s + b.qty, 0);

  it('prices one K-5000 per rack', () => {
    expect(k5000(frame({ ballRack: true, ballRackQty: 3 }))).toBe(3);
  });

  it('a proposal saved before the quantity existed keeps its one rack', () => {
    expect(k5000(frame({ ballRack: true }))).toBe(1);
  });

  it('no rack, no K-5000', () => {
    expect(k5000(frame({ ballRack: false, ballRackQty: 2 }))).toBe(0);
  });
});
