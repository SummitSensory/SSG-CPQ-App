import { describe, it, expect } from 'vitest';
import { normalizeSectionBItems, resolveSectionBItems } from '../../src/crossborder/sectionB.js';
import {
  SUBTEXT_SIZE_MIN,
  SUBTEXT_SIZE_MAX,
  SUBTEXT_SIZE_DEFAULT,
} from '../../src/crossborder/sectionC.js';

describe('normalizeSectionBItems', () => {
  it('drops malformed entries rather than throwing', () => {
    const out = normalizeSectionBItems([
      { label: 'Fine', text: 'Some text', order: 0 },
      { label: '', text: 'No label', order: 1 },
      'not even an object',
      { label: 'Also fine', order: 2 },
    ]);
    expect(out.map((i) => i.label)).toEqual(['Fine', 'Also fine']);
  });

  it('keeps an item even when its text is blank — the document decides whether to print it', () => {
    const out = normalizeSectionBItems([{ label: 'Row', order: 0 }]);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('');
  });

  it('sorts by order', () => {
    const out = normalizeSectionBItems([
      { label: 'Second', order: 2 },
      { label: 'First', order: 0 },
      { label: 'Third', order: 5 },
    ]);
    expect(out.map((i) => i.label)).toEqual(['First', 'Second', 'Third']);
  });

  it('returns an empty array for non-array input', () => {
    expect(normalizeSectionBItems(null)).toEqual([]);
    expect(normalizeSectionBItems(undefined)).toEqual([]);
    expect(normalizeSectionBItems('nope')).toEqual([]);
  });

  it('clamps sizePt to the 7-12pt range and defaults when absent', () => {
    const out = normalizeSectionBItems([
      { label: 'A', text: 'x', order: 0, sizePt: 20 },
      { label: 'B', text: 'x', order: 1 },
    ]);
    expect(out[0]?.sizePt).toBe(SUBTEXT_SIZE_MAX);
    expect(out[1]?.sizePt).toBe(SUBTEXT_SIZE_DEFAULT);
    expect(SUBTEXT_SIZE_MIN).toBeLessThan(SUBTEXT_SIZE_MAX);
  });
});

describe('resolveSectionBItems', () => {
  const template = [{ label: 'Template item', order: 0 }];

  it('falls back to the live admin template when a proposal has never customized its list (null)', () => {
    const out = resolveSectionBItems(null, template);
    expect(out.map((i) => i.label)).toEqual(['Template item']);
  });

  it("uses the proposal's own list once it has one, even if it differs from the template", () => {
    const own = [{ label: 'Proposal-specific item', order: 0 }];
    const out = resolveSectionBItems(own, template);
    expect(out.map((i) => i.label)).toEqual(['Proposal-specific item']);
  });

  it('treats a deliberately emptied list ([]) as "show nothing", distinct from null ("follow the template")', () => {
    const out = resolveSectionBItems([], template);
    expect(out).toEqual([]);
  });
});
