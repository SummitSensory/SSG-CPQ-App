import { describe, it, expect } from 'vitest';
import { normalizeSectionCItems, resolveSectionCItems } from '../../src/crossborder/sectionC.js';

describe('normalizeSectionCItems', () => {
  it('drops malformed entries rather than throwing', () => {
    const out = normalizeSectionCItems([
      { kind: 'TEXT', label: 'Fine', order: 0 },
      { kind: 'NOT_A_KIND', label: 'Bad kind', order: 1 },
      { kind: 'BOUND', label: 'No boundField', order: 2 },
      { kind: 'BOUND', boundField: 'not_a_real_field', label: 'Unknown boundField', order: 3 },
      { kind: 'TEXT', label: '', order: 4 },
      'not even an object',
      { kind: 'BOUND', boundField: 'importerOfRecord', label: 'Importer of record', order: 5 },
    ]);
    expect(out.map((i) => i.label)).toEqual(['Fine', 'Importer of record']);
  });

  it('sorts by order', () => {
    const out = normalizeSectionCItems([
      { kind: 'TEXT', label: 'Second', order: 2 },
      { kind: 'TEXT', label: 'First', order: 0 },
      { kind: 'TEXT', label: 'Third', order: 5 },
    ]);
    expect(out.map((i) => i.label)).toEqual(['First', 'Second', 'Third']);
  });

  it('returns an empty array for non-array input', () => {
    expect(normalizeSectionCItems(null)).toEqual([]);
    expect(normalizeSectionCItems(undefined)).toEqual([]);
    expect(normalizeSectionCItems('nope')).toEqual([]);
  });
});

describe('resolveSectionCItems', () => {
  const template = [{ kind: 'TEXT', label: 'Template row', order: 0 }];

  it('falls back to the live admin template when a proposal has never customized its list (null)', () => {
    const out = resolveSectionCItems(null, template);
    expect(out.map((i) => i.label)).toEqual(['Template row']);
  });

  it("uses the proposal's own list once it has one, even if it differs from the template", () => {
    const own = [{ kind: 'TEXT', label: 'Proposal-specific row', order: 0 }];
    const out = resolveSectionCItems(own, template);
    expect(out.map((i) => i.label)).toEqual(['Proposal-specific row']);
  });

  it('treats a deliberately emptied list ([]) as "show nothing", distinct from null ("follow the template")', () => {
    const out = resolveSectionCItems([], template);
    expect(out).toEqual([]);
  });
});
