import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { checkPartIntegrity, formatIntegrityReport } from '../../src/catalog/partIntegrity.js';

/**
 * Audit: does `checkPartIntegrity` (the engine behind `prisma/check-part-integrity.ts`
 * and `pnpm db:check:integrity`) catch every Product <-> Sku drift case it claims to?
 *
 * Each test builds one drift case in a read-only stub and asserts the rule id and
 * severity. Rules are asserted by id, never by prose. A `it.fails` test documents a
 * drift case the checker currently MISSES (a confirmed gap, see the audit report).
 */
interface ProductRow {
  id: string;
  sku: string;
  name: string;
  status: string;
  categoryId: string | null;
}
interface SkuRow {
  part: string;
  manufacturer: string | null;
  category: string | null;
  active: boolean;
}
interface SourcingRow {
  manufacturerId: string;
  isPrimary: boolean;
  product: { sku: string } | null;
  manufacturer: { name: string } | null;
}
interface Rows {
  products?: ProductRow[];
  skus?: SkuRow[];
  sourcing?: SourcingRow[];
}

function db(r: Rows): PrismaClient {
  return {
    product: { findMany: async () => r.products ?? [] },
    sku: { findMany: async () => r.skus ?? [] },
    productSourcing: { findMany: async () => r.sourcing ?? [] },
    productCategory: { findMany: async () => [] },
  } as unknown as PrismaClient;
}

const product = (sku: string, over: Partial<ProductRow> = {}): ProductRow => ({
  id: 'p-' + sku,
  sku,
  name: sku + ' name',
  status: 'ACTIVE',
  categoryId: 'tree-node-1',
  ...over,
});
const priced = (part: string, over: Partial<SkuRow> = {}): SkuRow => ({
  part,
  manufacturer: 'Goldberg Brothers',
  category: 'FRAME',
  active: true,
  ...over,
});
const link = (sku: string, name: string, isPrimary = true): SourcingRow => ({
  manufacturerId: 'm-' + name,
  isPrimary,
  product: { sku },
  manufacturer: { name },
});

async function run(r: Rows) {
  const report = await checkPartIntegrity(db(r));
  const rules = report.violations.map((v) => `${v.rule}:${v.severity}`).sort();
  return { report, rules };
}

describe('audit: integrity checker — each drift case is detected', () => {
  it('a whole, agreeing part produces no violations', async () => {
    const { report } = await run({
      products: [product('A-1')],
      skus: [priced('A-1')],
      sourcing: [link('A-1', 'Goldberg Brothers')],
    });
    expect(report.violations).toEqual([]);
    expect(report.checked).toEqual({ products: 1, skus: 1, sourcing: 1 });
  });

  it.each([
    ['ACTIVE', 'blocking'],
    ['DRAFT', 'warning'],
    ['INACTIVE', 'warning'],
    ['ARCHIVED', 'warning'],
  ])('Product with no Sku, status %s -> product-without-sku (%s)', async (status, severity) => {
    const { rules, report } = await run({ products: [product('A-1', { status })] });
    expect(rules).toEqual([`product-without-sku:${severity}`]);
    expect(report.blocking).toBe(severity === 'blocking' ? 1 : 0);
  });

  it('a product-without-sku is not ALSO judged on vendor/active rules', async () => {
    // The checker `continue`s after the half-part rule; one defect = one violation.
    const { rules } = await run({
      products: [product('A-1')],
      sourcing: [link('A-1', 'Someone Else')],
    });
    expect(rules).toEqual(['product-without-sku:blocking']);
  });

  it('Sku with no Product -> sku-without-product (warning)', async () => {
    const { rules } = await run({ skus: [priced('ORPHAN-1')] });
    expect(rules).toEqual(['sku-without-product:warning']);
  });

  it('Sku names a vendor but there is no sourcing link -> vendor-not-linked (warning)', async () => {
    const { rules } = await run({ products: [product('A-1')], skus: [priced('A-1')] });
    expect(rules).toEqual(['vendor-not-linked:warning']);
  });

  it('Sku with no vendor and no sourcing is not a violation', async () => {
    const { rules } = await run({
      products: [product('A-1')],
      skus: [priced('A-1', { manufacturer: null })],
    });
    expect(rules).toEqual([]);
  });

  it('Sku vendor not among the sourcing vendors -> vendor-not-sourced (blocking)', async () => {
    const { rules, report } = await run({
      products: [product('A-1')],
      skus: [priced('A-1', { manufacturer: 'Resilite' })],
      sourcing: [link('A-1', 'Goldberg Brothers')],
    });
    expect(rules).toEqual(['vendor-not-sourced:blocking']);
    expect(report.violations[0]!.detail).toContain('Goldberg Brothers');
  });

  it('ProductSourcing many-to-many: two vendors, one primary = the ordered one -> clean', async () => {
    const { rules } = await run({
      products: [product('A-1')],
      skus: [priced('A-1', { manufacturer: 'Productive Tool Products' })],
      sourcing: [
        link('A-1', 'Goldberg Brothers', false),
        link('A-1', 'Productive Tool Products', true),
      ],
    });
    expect(rules).toEqual([]);
  });

  it('many-to-many is not collapsed regardless of row ORDER (ordered vendor listed first or last)', async () => {
    for (const order of [
      [link('A-1', 'Goldberg Brothers', false), link('A-1', 'Productive Tool Products', true)],
      [link('A-1', 'Productive Tool Products', true), link('A-1', 'Goldberg Brothers', false)],
    ]) {
      const { rules } = await run({
        products: [product('A-1')],
        skus: [priced('A-1', { manufacturer: 'Productive Tool Products' })],
        sourcing: order,
      });
      expect(rules).toEqual([]);
    }
  });

  it('several rows all flagged primary (the @default(true) case) -> vendor-multiple-primary (warning)', async () => {
    const { rules } = await run({
      products: [product('A-1')],
      skus: [priced('A-1')],
      sourcing: [link('A-1', 'Goldberg Brothers'), link('A-1', 'Productive Tool Products')],
    });
    expect(rules).toEqual(['vendor-multiple-primary:warning']);
  });

  it('ordered from a listed, non-primary vendor -> vendor-not-primary (warning)', async () => {
    const { rules } = await run({
      products: [product('A-1')],
      skus: [priced('A-1')],
      sourcing: [
        link('A-1', 'Goldberg Brothers', false),
        link('A-1', 'Productive Tool Products', true),
      ],
    });
    expect(rules).toEqual(['vendor-not-primary:warning']);
  });

  it('ACTIVE product with an inactive Sku -> active-mismatch (warning)', async () => {
    const { rules } = await run({
      products: [product('A-1')],
      skus: [priced('A-1', { active: false, manufacturer: null })],
    });
    expect(rules).toEqual(['active-mismatch:warning']);
  });

  it.each(['INACTIVE', 'ARCHIVED', 'DRAFT'])(
    '%s product with an active Sku -> active-mismatch (warning)',
    async (status) => {
      const { rules } = await run({
        products: [product('A-1', { status })],
        skus: [priced('A-1', { manufacturer: null })],
      });
      expect(rules).toEqual(['active-mismatch:warning']);
    },
  );

  it('part-number and vendor joins are trimmed and case-insensitive', async () => {
    const { rules } = await run({
      products: [product('a-1')],
      skus: [priced(' A-1 ', { manufacturer: ' goldberg brothers ' })],
      sourcing: [link('A-1', 'Goldberg Brothers')],
    });
    expect(rules).toEqual([]);
  });

  it('three category fields are NOT compared (tree position vs part type)', async () => {
    const { rules } = await run({
      products: [product('A-1', { categoryId: 'adventure-series-frame' })],
      skus: [priced('A-1', { category: 'FRAME' })],
      sourcing: [link('A-1', 'Goldberg Brothers')],
    });
    expect(rules).toEqual([]);
  });

  it('sourcing rows whose product or manufacturer is missing are ignored, not crashed on', async () => {
    const { rules } = await run({
      products: [product('A-1')],
      skus: [priced('A-1')],
      sourcing: [
        { manufacturerId: 'x', isPrimary: true, product: null, manufacturer: { name: 'X' } },
        { manufacturerId: 'y', isPrimary: true, product: { sku: 'A-1' }, manufacturer: null },
        link('A-1', 'Goldberg Brothers'),
      ],
    });
    expect(rules).toEqual([]);
  });

  it('counts blocking and warnings separately and groups byRule', async () => {
    const { report } = await run({
      products: [product('A-1'), product('B-1'), product('C-1', { status: 'DRAFT' })],
      skus: [priced('B-1', { manufacturer: 'Resilite' }), priced('Z-9')],
      sourcing: [link('B-1', 'Goldberg Brothers')],
    });
    expect(report.blocking).toBe(2); // A-1 half part, B-1 vendor-not-sourced
    expect(report.warnings).toBe(2); // C-1 draft half part, Z-9 orphan sku
    expect(report.byRule).toEqual({
      'product-without-sku': 2,
      'vendor-not-sourced': 1,
      'sku-without-product': 1,
    });
  });

  it('formatIntegrityReport truncates long rule lists at the limit', async () => {
    const products = Array.from({ length: 30 }, (_, i) => product(`H-${i}`));
    const { report } = await run({ products });
    const text = formatIntegrityReport(report, 5);
    expect(text).toContain('product-without-sku  [BLOCKING]  30');
    expect(text).toContain('… +25 more');
  });

  /*
   * CONFIRMED GAP. Product.sku and Sku.part are unique CASE-SENSITIVELY in Postgres, and
   * POST /catalog/items checks duplicates with an exact-case findUnique — so "abc-1" and
   * "ABC-1" can both exist. The checker keys its maps by lower-cased part number, so the
   * second Product silently matches the first one's Sku: an ACTIVE Product with no Sku of
   * its own (quotable at $0.00 by exact-match lookups) is reported as clean.
   */
  it.fails(
    'BUG: case-variant duplicate Products are reported (second one has no Sku of its own)',
    async () => {
      const { rules } = await run({
        products: [product('ABC-1'), product('abc-1', { id: 'p-lower' })],
        skus: [priced('ABC-1', { manufacturer: null })],
      });
      expect(rules.length).toBeGreaterThan(0);
    },
  );

  it.fails(
    'BUG: case-variant duplicate Skus are reported (two priced rows for one part)',
    async () => {
      const { rules } = await run({
        products: [product('ABC-1')],
        skus: [priced('ABC-1', { manufacturer: null }), priced('abc-1', { manufacturer: null })],
      });
      expect(rules.length).toBeGreaterThan(0);
    },
  );
});
