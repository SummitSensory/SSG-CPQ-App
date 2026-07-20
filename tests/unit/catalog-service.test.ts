import { describe, it, expect } from 'vitest';
import { canTransition, canHardDelete } from '../../src/catalog/service.js';

describe('catalog status & delete policy', () => {
  it('allows valid status transitions only', () => {
    expect(canTransition('DRAFT', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'INACTIVE')).toBe(true);
    expect(canTransition('ARCHIVED', 'ACTIVE')).toBe(false);
    expect(canTransition('DRAFT', 'INACTIVE')).toBe(false);
  });
  it('protects ever-active or referenced products from hard delete', () => {
    expect(canHardDelete(false, 0)).toBe(true);   // draft, unreferenced
    expect(canHardDelete(true, 0)).toBe(false);   // was active -> archive only
    expect(canHardDelete(false, 2)).toBe(false);  // referenced by bundles/components
  });
});
