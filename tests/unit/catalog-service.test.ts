import { describe, it, expect } from 'vitest';
import {
  canTransition,
  canHardDelete,
  deriveTiers,
  descendantIds,
  resolveCategoryTier,
} from '../../src/catalog/service.js';
import type { ProductCategory } from '@prisma/client';

describe('catalog status & delete policy', () => {
  it('allows valid status transitions only', () => {
    expect(canTransition('DRAFT', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'INACTIVE')).toBe(true);
    expect(canTransition('ARCHIVED', 'ACTIVE')).toBe(false);
    expect(canTransition('DRAFT', 'INACTIVE')).toBe(false);
  });
  it('protects ever-active or referenced products from hard delete', () => {
    expect(canHardDelete(false, 0)).toBe(true); // draft, unreferenced
    expect(canHardDelete(true, 0)).toBe(false); // was active -> archive only
    expect(canHardDelete(false, 2)).toBe(false); // referenced by bundles/components
  });
});

describe('category tiers', () => {
  const nodes = [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'b' },
    { id: 'd', parentId: 'c' },
    { id: 'e', parentId: 'd' },
    { id: 'x', parentId: 'y' },
    { id: 'y', parentId: 'x' },
    { id: 'orphan', parentId: 'missing' },
  ];

  it('derives the tier from the parent chain, and null for a loop or a missing parent', () => {
    const t = deriveTiers(nodes);
    expect([t.get('a'), t.get('b'), t.get('c'), t.get('d'), t.get('e')]).toEqual([1, 2, 3, 4, 5]);
    expect(t.get('x')).toBeNull();
    expect(t.get('y')).toBeNull();
    expect(t.get('orphan')).toBeNull();
  });

  it('lists every descendant, and terminates on a loop', () => {
    expect(descendantIds(nodes, 'b').sort()).toEqual(['c', 'd', 'e']);
    expect(descendantIds(nodes, 'x')).toEqual(['y']);
  });

  it('places a child at parent + 1 and refuses a fifth tier or a contradicting tier', () => {
    const parent = (tierLevel: number) =>
      ({ id: 'p', tierLevel, productLineId: null }) as unknown as ProductCategory;
    expect(resolveCategoryTier({}, parent(2)).tierLevel).toBe(3);
    expect(() => resolveCategoryTier({}, parent(4))).toThrow(/Maximum tier depth/);
    expect(() => resolveCategoryTier({ tierLevel: 1 }, parent(1))).toThrow(/tierLevel must be 2/);
    expect(() => resolveCategoryTier({ tierLevel: 2 }, null)).toThrow(/top-level/);
  });
});
