import { describe, it, expect } from 'vitest';
import {
  loadCatalogSeed,
  tiersInInsertOrder,
  type CatalogSeedData,
} from '../../src/catalog/workbook-import.js';
import seedJson from '../../prisma/seed-catalog.json' with { type: 'json' };

const base = {
  productLines: [
    { name: 'Adventure Series', slug: 'adventure-series', sortOrder: 10, isActive: true },
  ],
  manufacturers: [
    { name: 'Goldberg Brothers', code: 'goldberg-brothers', isThirdParty: true, isActive: true },
  ],
  products: [
    {
      sku: 'A-2245',
      name: 'Vertical Tall',
      productLine: 'Adventure Series',
      defaultQuantity: 1,
      unitPriceMinor: 55775,
      showDimensions: false,
    },
  ],
  tiers: [
    { slug: 'frame', name: 'FRAME', productLine: 'Adventure Series', tierLevel: 1, parentSlug: null, sku: null, sortOrder: 10 },
    { slug: 'frame--a-2245', name: 'Vertical Tall', productLine: 'Adventure Series', tierLevel: 2, parentSlug: 'frame', sku: 'A-2245', sortOrder: 20 },
  ],
  notes: [],
  costs: [{ sku: 'A-2245', unitCostMinor: 24250, currency: 'USD', uom: 'EA', effectiveDate: '2026-07-25' }],
  sourcing: [{ sku: 'A-2245', manufacturer: 'Goldberg Brothers', isPrimary: true }],
};

const clone = (): typeof base => JSON.parse(JSON.stringify(base));

describe('catalog seed validation', () => {
  it('accepts a well-formed seed', () => {
    const { report } = loadCatalogSeed(base);
    expect(report.ok).toBe(true);
  });

  it('rejects a tier pointing at an unknown SKU', () => {
    const d = clone();
    d.tiers[1]!.sku = 'NOPE';
    expect(loadCatalogSeed(d).report.ok).toBe(false);
  });

  it('rejects an orphaned tier parent', () => {
    const d = clone();
    d.tiers[1]!.parentSlug = 'ghost';
    expect(loadCatalogSeed(d).report.ok).toBe(false);
  });

  it('rejects a product placed at tier 1', () => {
    const d = clone();
    d.tiers.push({
      slug: 'bad', name: 'Bad', productLine: 'Adventure Series',
      tierLevel: 1, parentSlug: null, sku: 'A-2245', sortOrder: 30,
    });
    expect(loadCatalogSeed(d).report.ok).toBe(false);
  });

  it('rejects an unknown manufacturer', () => {
    const d = clone();
    d.sourcing[0]!.manufacturer = 'Ghost Co';
    expect(loadCatalogSeed(d).report.ok).toBe(false);
  });

  it('rejects two primary manufacturers for one SKU', () => {
    const d = clone();
    d.manufacturers.push({ name: 'TFH', code: 'tfh', isThirdParty: true, isActive: true });
    d.sourcing.push({ sku: 'A-2245', manufacturer: 'TFH', isPrimary: true });
    expect(loadCatalogSeed(d).report.ok).toBe(false);
  });

  it('rejects duplicate SKUs', () => {
    const d = clone();
    d.products.push({ ...d.products[0]! });
    expect(loadCatalogSeed(d).report.ok).toBe(false);
  });

  it('warns — but does not fail — on a product with no cost', () => {
    const d = clone();
    d.costs = [];
    const { report } = loadCatalogSeed(d);
    expect(report.ok).toBe(true);
    expect(report.issues.some((i) => i.severity === 'warning' && i.message.includes('no cost'))).toBe(true);
  });

  it('orders tiers parents-before-children', () => {
    const ordered = tiersInInsertOrder(base.tiers as CatalogSeedData['tiers']);
    expect(ordered.map((t) => t.tierLevel)).toEqual([1, 2]);
  });
});

describe('the real workbook seed', () => {
  it('loads and validates with no errors', () => {
    const { report } = loadCatalogSeed(seedJson);
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors, JSON.stringify(errors.slice(0, 5))).toHaveLength(0);
    expect(report.counts.products).toBeGreaterThan(300);
    expect(report.counts.tierPlacements).toBeGreaterThan(250);
  });

  it('every tier parent resolves', () => {
    const { data } = loadCatalogSeed(seedJson);
    const slugs = new Set(data.tiers.map((t) => t.slug));
    expect(data.tiers.filter((t) => t.parentSlug && !slugs.has(t.parentSlug))).toHaveLength(0);
  });
});
