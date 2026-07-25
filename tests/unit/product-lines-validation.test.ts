import { describe, it, expect } from 'vitest';
import {
  ProductLineInput,
  TierNodeInput,
  ProductNoteInput,
  ManufacturerInput,
  ProductSourcingInput,
} from '../../src/catalog/validation.js';

describe('product line validation', () => {
  it('accepts a valid product line', () => {
    expect(ProductLineInput.safeParse({ name: 'Adventure Series', slug: 'adventure-series' }).success).toBe(true);
  });
  it('rejects a bad slug', () => {
    expect(ProductLineInput.safeParse({ name: 'Adventure Series', slug: 'Adventure Series' }).success).toBe(false);
  });
});

describe('tier node validation', () => {
  const base = { name: 'Swings', slug: 'swings', productLineId: 'pl1' };

  it('tier 1 is a top-level header', () => {
    expect(TierNodeInput.safeParse({ ...base, tierLevel: 1 }).success).toBe(true);
  });
  it('rejects a product on tier 1', () => {
    expect(TierNodeInput.safeParse({ ...base, tierLevel: 1, productId: 'p1' }).success).toBe(false);
  });
  it('rejects a parent on tier 1', () => {
    expect(TierNodeInput.safeParse({ ...base, tierLevel: 1, parentId: 'c1' }).success).toBe(false);
  });
  it('requires a parent below tier 1', () => {
    expect(TierNodeInput.safeParse({ ...base, tierLevel: 2 }).success).toBe(false);
    expect(TierNodeInput.safeParse({ ...base, tierLevel: 2, parentId: 'c1' }).success).toBe(true);
  });
  it('allows a product placement at tiers 2-4', () => {
    expect(TierNodeInput.safeParse({ ...base, tierLevel: 3, parentId: 'c1', productId: 'p1' }).success).toBe(true);
  });
  it('rejects tier 5', () => {
    expect(TierNodeInput.safeParse({ ...base, tierLevel: 5, parentId: 'c1' }).success).toBe(false);
  });
});

describe('note / manufacturer / sourcing validation', () => {
  it('rejects an empty note body', () => {
    expect(ProductNoteInput.safeParse({ productId: 'p1', body: '   ' }).success).toBe(false);
  });
  it('accepts a note', () => {
    expect(ProductNoteInput.safeParse({ productId: 'p1', body: '* Mat color selected at order.' }).success).toBe(true);
  });
  it('requires a manufacturer name', () => {
    expect(ManufacturerInput.safeParse({ name: 'A' }).success).toBe(false);
    expect(ManufacturerInput.safeParse({ name: 'Summit Fabrication' }).success).toBe(true);
  });
  it('rejects a negative lead time', () => {
    expect(ProductSourcingInput.safeParse({ productId: 'p1', manufacturerId: 'm1', leadTimeDays: -5 }).success).toBe(false);
  });
  it('rejects a zero minimum order quantity', () => {
    expect(ProductSourcingInput.safeParse({ productId: 'p1', manufacturerId: 'm1', minOrderQty: 0 }).success).toBe(false);
  });
});
