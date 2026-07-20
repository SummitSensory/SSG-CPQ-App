import { describe, it, expect } from 'vitest';
import { normalizeOrgName } from '../../src/crm/duplicates.js';

describe('org name normalization (duplicate detection)', () => {
  it('treats suffix/punctuation/case variants as the same key', () => {
    const a = normalizeOrgName('Summit Sensory, Inc.');
    const b = normalizeOrgName('summit  sensory llc');
    const c = normalizeOrgName('The Summit Sensory Co');
    expect(a).toBe('summit sensory');
    expect(b).toBe('summit sensory');
    expect(c).toBe('summit sensory');
  });
  it('distinguishes genuinely different names', () => {
    expect(normalizeOrgName('Summit Sensory')).not.toBe(normalizeOrgName('Valley Therapy'));
  });
});
