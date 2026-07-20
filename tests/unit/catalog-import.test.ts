import { describe, it, expect } from 'vitest';
import { validateImportBatch } from '../../src/catalog/import.js';

describe('import validation & duplicate prevention', () => {
  it('accepts a clean batch', () => {
    const res = validateImportBatch([
      { sku: 'AAA-001', name: 'Item A', categoryId: 'c1' },
      { sku: 'AAA-002', name: 'Item B', categoryId: 'c1' },
    ]);
    expect(res.valid).toBe(true);
    expect(res.validRows).toBe(2);
  });
  it('flags in-batch duplicate SKUs', () => {
    const res = validateImportBatch([
      { sku: 'DUP-001', name: 'A', categoryId: 'c1' },
      { sku: 'DUP-001', name: 'B', categoryId: 'c1' },
    ]);
    expect(res.valid).toBe(false);
    expect(res.issues.some((i) => i.field === 'sku')).toBe(true);
  });
  it('reports required-field errors with row numbers', () => {
    const res = validateImportBatch([{ name: 'No sku or category' }]);
    expect(res.valid).toBe(false);
    expect(res.issues[0].row).toBe(1);
  });
});
