import { describe, it, expect } from 'vitest';
import { selectedReferenceDocKeys } from '../../src/proposals/referenceDocuments.js';

describe('selectedReferenceDocKeys', () => {
  it('reads referenceDocKeys out of the meta section', () => {
    const sections = [
      { id: 'meta', data: { referenceDocKeys: ['W9', 'COI'] } },
      { id: 'group1', type: 'GROUP' },
    ];
    expect(selectedReferenceDocKeys(sections)).toEqual(['W9', 'COI']);
  });

  it('answers empty for a version with no meta section at all', () => {
    expect(selectedReferenceDocKeys([{ id: 'group1', type: 'GROUP' }])).toEqual([]);
  });

  it('answers empty when meta exists but never set referenceDocKeys', () => {
    const sections = [{ id: 'meta', data: { contactName: 'Jane' } }];
    expect(selectedReferenceDocKeys(sections)).toEqual([]);
  });

  it('drops non-string entries rather than passing them through', () => {
    const sections = [{ id: 'meta', data: { referenceDocKeys: ['W9', 42, null, 'COI'] } }];
    expect(selectedReferenceDocKeys(sections)).toEqual(['W9', 'COI']);
  });

  it('answers empty for malformed sections input', () => {
    expect(selectedReferenceDocKeys(null)).toEqual([]);
    expect(selectedReferenceDocKeys('not an array')).toEqual([]);
    expect(selectedReferenceDocKeys(undefined)).toEqual([]);
  });
});
