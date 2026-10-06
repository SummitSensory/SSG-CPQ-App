import { describe, it, expect } from 'vitest';
import skuData from '../../src/proposals/adventure-skus.json' with { type: 'json' };
import {
  computeAdventureProposal,
  CARABINER_PART,
  COMPONENTS_GROUP,
  COMPONENTS_GROUP_LEGACY,
  MAT_GROUP,
  type AdvAnswers,
  type SkuRec,
} from '../../src/proposals/adventureSeries.js';

/**
 * The printed proposal steps a section heading down a size once its name plus
 * "· OPTIONAL" runs past 40 characters (proposal-document.js). The optional Adventure
 * tiers are named to stay under that, so every heading prints at the same size.
 */

const frame = (over: Partial<AdvAnswers> = {}): AdvAnswers => ({
  length: 12,
  width: 10,
  config: 'Rectangle',
  legs: 6,
  ladders: 0,
  ...over,
});

const printedLength = (name: string, optional: boolean) =>
  (name + (optional ? ' · OPTIONAL' : '')).length;

const groups = (a: AdvAnswers, skuMap?: Record<string, SkuRec>) =>
  computeAdventureProposal(a, skuMap).lines.filter((l) => l.lineType === 'GROUP');

describe('Adventure section headings', () => {
  it('names the components section "Adventure Components"', () => {
    const g = groups(frame({ slide: true })).find((l) => l.name === COMPONENTS_GROUP);
    expect(g).toMatchObject({ optional: true });
    expect(printedLength(g!.name, true)).toBeLessThanOrEqual(40);
  });

  it('carries "Highly Recommended" in the mat heading note, not its name', () => {
    const { lines } = computeAdventureProposal(frame({ matColumn: true, uShaped: 2 }));
    const g = lines.find((l) => l.lineType === 'GROUP' && l.name === MAT_GROUP);
    expect(g).toMatchObject({ optional: true, description: 'Highly Recommended' });
    expect(printedLength(g!.name, true)).toBeLessThanOrEqual(40);
    // No sub-heading that only repeats the section name.
    expect(lines.some((l) => l.lineType === 'SUBGROUP' && l.name === MAT_GROUP)).toBe(false);
  });

  it('files a part whose catalog group still has the old name under the new heading', () => {
    const skuMap: Record<string, SkuRec> = {};
    for (const s of skuData as SkuRec[]) skuMap[s.part] = { ...s };
    skuMap[CARABINER_PART] = {
      ...skuMap[CARABINER_PART]!,
      proposalGroup: COMPONENTS_GROUP_LEGACY,
    };
    const { lines } = computeAdventureProposal(frame({ slide: true, carabiner: 1 }), skuMap);
    const names = lines.filter((l) => l.lineType === 'GROUP').map((l) => l.name);
    expect(names).toContain(COMPONENTS_GROUP);
    expect(names).not.toContain(COMPONENTS_GROUP_LEGACY);
    const head = lines.findIndex((l) => l.lineType === 'GROUP' && l.name === COMPONENTS_GROUP);
    const next = lines.findIndex((l, i) => i > head && l.lineType === 'GROUP');
    const at = lines.findIndex((l) => l.sku === CARABINER_PART);
    expect(at).toBeGreaterThan(head);
    if (next >= 0) expect(at).toBeLessThan(next);
  });
});
