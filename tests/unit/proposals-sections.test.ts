import { describe, it, expect } from 'vitest';
import { resolveVisibleSections, reorderSections, type ProposalSection } from '../../src/proposals/sections.js';

const s = (id: string, order: number, over: Partial<ProposalSection> = {}): ProposalSection => ({
  id, type: 'EXECUTIVE_SUMMARY', title: id, order, enabled: true, ...over,
});

describe('proposal sections — layout, reorder, conditional', () => {
  it('sorts visible sections by order', () => {
    const out = resolveVisibleSections([s('c', 2), s('a', 0), s('b', 1)]);
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('omits disabled sections', () => {
    const out = resolveVisibleSections([s('a', 0), s('b', 1, { enabled: false })]);
    expect(out.map((x) => x.id)).toEqual(['a']);
  });

  it('shows a conditional section only when the condition is met', () => {
    const cond = s('opt', 0, { condition: { field: 'hasOptional', equals: true } });
    expect(resolveVisibleSections([cond], { hasOptional: false })).toHaveLength(0);
    expect(resolveVisibleSections([cond], { hasOptional: true })).toHaveLength(1);
  });

  it('reorders sections by explicit id order and renumbers', () => {
    const out = reorderSections([s('a', 0), s('b', 1), s('c', 2)], ['c', 'a', 'b']);
    expect(out.map((x) => [x.id, x.order])).toEqual([['c', 0], ['a', 1], ['b', 2]]);
  });

  it('appends sections missing from the order list', () => {
    const out = reorderSections([s('a', 0), s('b', 1), s('c', 2)], ['b']);
    expect(out.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('drops unknown ids in the order list', () => {
    const out = reorderSections([s('a', 0)], ['zzz', 'a']);
    expect(out.map((x) => x.id)).toEqual(['a']);
  });
});
