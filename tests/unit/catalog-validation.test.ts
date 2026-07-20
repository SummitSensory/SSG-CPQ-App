import { describe, it, expect } from 'vitest';
import { ProductInput, SKU, Slug } from '../../src/catalog/validation.js';

describe('catalog validation', () => {
  it('requires a category (required-field validation)', () => {
    const r = ProductInput.safeParse({ sku: 'ABC-123', name: 'Swing' });
    expect(r.success).toBe(false);
  });
  it('rejects a bad SKU format', () => {
    expect(SKU.safeParse('ab').success).toBe(false);
    expect(SKU.safeParse('VALID-SKU-1').success).toBe(true);
  });
  it('rejects a bad slug', () => {
    expect(Slug.safeParse('Not A Slug').success).toBe(false);
    expect(Slug.safeParse('sensory-swings').success).toBe(true);
  });
  it('rejects activeTo before activeFrom', () => {
    const r = ProductInput.safeParse({ sku: 'ABC-123', name: 'Swing', categoryId: 'c1', activeFrom: '2026-05-01', activeTo: '2026-01-01' });
    expect(r.success).toBe(false);
  });
  it('rejects negative weight', () => {
    const r = ProductInput.safeParse({ sku: 'ABC-123', name: 'Swing', categoryId: 'c1', weightOz: -1 });
    expect(r.success).toBe(false);
  });
});
