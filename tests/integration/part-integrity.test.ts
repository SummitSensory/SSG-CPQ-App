import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { checkPartIntegrity, formatIntegrityReport } from '../../src/catalog/partIntegrity.js';

/**
 * The catalog's invariants, pinned.
 *
 * Every serious defect in the audit was one defect in different clothes: the same fact
 * stored twice, with nothing checking the two agreed. A Product with no Sku (194 of them,
 * 192 offered to reps at $0.00 because GET /catalog/items reports a Sku-less Product as
 * `unitPriceMinor: 0, active: true`). A vendor named one thing on `Sku.manufacturer` and
 * another on `ProductSourcing` (7 parts).
 *
 * Each was found by a person reading code, which is neither repeatable nor a guarantee.
 * These tests fix the RULES in place so a future change cannot quietly stop detecting a
 * class of drift; `prisma/check-part-integrity.ts` runs the same rules against the real
 * database and fails `pnpm check` on a blocking violation.
 *
 * Prisma is a plain stub rather than a mock library: the checker only reads, so a fake
 * that returns arrays is the whole dependency, and the test stays about the rules.
 */
interface Rows {
  products?: Array<{
    id: string;
    sku: string;
    name: string;
    status: string;
    categoryId: string | null;
  }>;
  skus?: Array<{
    part: string;
    manufacturer: string | null;
    category: string | null;
    active: boolean;
  }>;
  sourcing?: Array<{
    manufacturerId: string;
    product: { sku: string } | null;
    manufacturer: { name: string } | null;
  }>;
  categories?: Array<{ id: string; name: string }>;
}

function db(r: Rows): PrismaClient {
  return {
    product: { findMany: async () => r.products ?? [] },
    sku: { findMany: async () => r.skus ?? [] },
    productSourcing: { findMany: async () => r.sourcing ?? [] },
    productCategory: { findMany: async () => r.categories ?? [] },
  } as unknown as PrismaClient;
}

/*
 * `Rows` declares its arrays optional, so `Rows['products']` is `T[] | undefined` and
 * cannot be indexed with `[number]`. NonNullable strips the undefined before the lookup.
 * Named aliases rather than inlining it twice, so the builders below stay readable.
 */
type ProductRow = NonNullable<Rows['products']>[number];
type SkuRow = NonNullable<Rows['skus']>[number];

const product = (sku: string, over: Partial<ProductRow> = {}) => ({
  id: 'p-' + sku,
  sku,
  name: sku + ' name',
  status: 'ACTIVE',
  categoryId: 'c1',
  ...over,
});
const priced = (part: string, over: Partial<SkuRow> = {}) => ({
  part,
  manufacturer: 'Resilite',
  category: 'Mats',
  active: true,
  ...over,
});
/**
 * One sourcing row. `ProductSourcing` is a many-to-many with an `isPrimary` flag, so a
 * part can carry several of these — which is exactly what an earlier version of the
 * checker got wrong by collapsing them to one vendor per part.
 */
const link = (sku: string, name: string, isPrimary = true) => ({
  manufacturerId: 'm-' + name,
  isPrimary,
  product: { sku },
  manufacturer: { name },
});
const cats = [{ id: 'c1', name: 'Mats' }];

const rules = (v: Awaited<ReturnType<typeof checkPartIntegrity>>) =>
  v.violations.map((x) => x.rule).sort();

describe('catalog integrity rules', () => {
  it('passes a part that is whole and agrees with itself', async () => {
    const r = await checkPartIntegrity(
      db({
        products: [product('P-1')],
        skus: [priced('P-1')],
        sourcing: [link('P-1', 'Resilite')],
        categories: cats,
      }),
    );
    expect(r.violations).toEqual([]);
    expect(r.blocking).toBe(0);
    expect(formatIntegrityReport(r)).toContain('No violations');
  });

  describe('a part existing as only half of itself', () => {
    it('BLOCKS an ACTIVE product with no priced record', async () => {
      // The 192-part case. Blocking because the builder will offer it at $0.00.
      const r = await checkPartIntegrity(db({ products: [product('P-1')], categories: cats }));
      expect(rules(r)).toEqual(['product-without-sku']);
      expect(r.blocking).toBe(1);
      expect(r.violations[0]!.detail).toMatch(/\$0\.00/);
    });

    it('only WARNS when that product is not ACTIVE', async () => {
      // Same missing record, but a DRAFT product is not in the picker, so it cannot
      // misprice anything. Blocking on it would train people to ignore the check.
      const r = await checkPartIntegrity(
        db({ products: [product('P-1', { status: 'DRAFT' })], categories: cats }),
      );
      expect(rules(r)).toEqual(['product-without-sku']);
      expect(r.blocking).toBe(0);
      expect(r.warnings).toBe(1);
    });

    it('warns on a priced record with no catalog record', async () => {
      const r = await checkPartIntegrity(db({ skus: [priced('P-9')], categories: cats }));
      expect(rules(r)).toEqual(['sku-without-product']);
      expect(r.blocking).toBe(0);
    });
  });

  describe('one fact, two records', () => {
    it('says nothing when a part has a SECOND source and orders from the primary', async () => {
      /*
       * The real shape of the 7 tracking-rail parts, and the case an earlier version of
       * the checker got wrong.
       *
       * It built one vendor per part with a `Map.set` in a loop, so for a part with two
       * sourcing rows whichever the database returned last silently won — and it then
       * reported a "disagreement" against an arbitrarily chosen alternate. Those 7 parts
       * list both Goldberg Brothers and Productive Tool Products, which is what a second
       * source is for, and none of them was wrong.
       */
      const r = await checkPartIntegrity(
        db({
          products: [product('P-1')],
          skus: [priced('P-1', { manufacturer: 'Goldberg Brothers' })],
          sourcing: [
            link('P-1', 'Goldberg Brothers', true),
            link('P-1', 'Productive Tool Products', false),
          ],
          categories: cats,
        }),
      );
      expect(r.violations).toEqual([]);
    });

    it('BLOCKS ordering from a vendor that is not a listed source', async () => {
      // The genuine defect: the Bill of Materials follows `Sku.manufacturer`, so a
      // purchase order goes to a company the catalog does not associate with the part.
      const r = await checkPartIntegrity(
        db({
          products: [product('P-1')],
          skus: [priced('P-1', { manufacturer: 'Goldberg Brothers' })],
          sourcing: [link('P-1', 'Productive Tool Products')],
          categories: cats,
        }),
      );
      expect(rules(r)).toEqual(['vendor-not-sourced']);
      expect(r.blocking).toBe(1);
      expect(r.violations[0]!.detail).toContain('Goldberg Brothers');
      expect(r.violations[0]!.detail).toContain('Productive Tool Products');
    });

    it('warns when several sources are all flagged primary', async () => {
      /*
       * THE ACTUAL CONDITION on the 7 tracking-rail parts, found only when the repair
       * script reported "nothing to change" while the check was still flagging them.
       *
       * `isPrimary` is `@default(true)` in the schema, so every sourcing row added
       * without explicitly setting it becomes primary. A part with two sources therefore
       * has two primaries, and "the primary source" does not exist for it.
       *
       * Two earlier versions of the checker collapsed a collection to a scalar here —
       * first the vendor list, then the primary flag — and each time named an arbitrary
       * winner and reported a defect that was not there. This asserts the honest reading.
       */
      const r = await checkPartIntegrity(
        db({
          products: [product('P-1')],
          skus: [priced('P-1', { manufacturer: 'Goldberg Brothers' })],
          sourcing: [
            link('P-1', 'Goldberg Brothers', true),
            link('P-1', 'Productive Tool Products', true),
          ],
          categories: cats,
        }),
      );
      expect(rules(r)).toEqual(['vendor-multiple-primary']);
      expect(r.blocking).toBe(0);
      expect(r.violations[0]!.detail).toContain('2 sources are all flagged primary');
    });

    it('warns when the ordering vendor is listed but not the primary', async () => {
      // Exactly one primary, and it is not the one being ordered from. The distinction
      // from the case above is the whole reason `primaries` is a list.
      const r = await checkPartIntegrity(
        db({
          products: [product('P-1')],
          skus: [priced('P-1', { manufacturer: 'Productive Tool Products' })],
          sourcing: [
            link('P-1', 'Goldberg Brothers', true),
            link('P-1', 'Productive Tool Products', false),
          ],
          categories: cats,
        }),
      );
      expect(rules(r)).toEqual(['vendor-not-primary']);
      expect(r.blocking).toBe(0);
    });

    it('treats vendor names case-insensitively rather than flagging a spelling', async () => {
      const r = await checkPartIntegrity(
        db({
          products: [product('P-1')],
          skus: [priced('P-1', { manufacturer: 'resilite' })],
          sourcing: [link('P-1', 'Resilite')],
          categories: cats,
        }),
      );
      expect(r.violations).toEqual([]);
    });

    it('warns when a named vendor has no sourcing link at all', async () => {
      const r = await checkPartIntegrity(
        db({ products: [product('P-1')], skus: [priced('P-1')], categories: cats }),
      );
      expect(rules(r)).toEqual(['vendor-not-linked']);
      expect(r.blocking).toBe(0);
    });

    it('says nothing when neither record names a vendor', async () => {
      // Legitimate: a bundle, a discount line, an hourly service.
      const r = await checkPartIntegrity(
        db({
          products: [product('P-1')],
          skus: [priced('P-1', { manufacturer: null })],
          categories: cats,
        }),
      );
      expect(r.violations).toEqual([]);
    });

    it('does NOT flag a type code that differs from the tree section', async () => {
      /*
       * The rule this replaces was wrong, and pinning its absence is worth a test.
       *
       * An earlier version flagged `Sku.category` disagreeing with the tree, on the
       * stated grounds that it was the proposal heading. It is not:
       * `src/reporting/dataset.ts` documents `Sku.proposalGroup` as "the tier heading the
       * builder files this part under", and `Sku.category` as a part type used for
       * filtering and reporting. 219 parts here sit under "ADVENTURE SERIES FRAME" in the
       * tree and are typed "FRAME" — correct on both counts.
       *
       * Two records holding DIFFERENT facts is not duplication, however similar the
       * shapes look from outside.
       */
      const r = await checkPartIntegrity(
        db({
          products: [product('P-1')],
          skus: [priced('P-1', { category: 'FRAME' })],
          sourcing: [link('P-1', 'Resilite')],
          categories: [{ id: 'c1', name: 'ADVENTURE SERIES FRAME' }],
        }),
      );
      expect(r.violations).toEqual([]);
    });

    it('warns when a part is live in the tree but inactive in the price list', async () => {
      const r = await checkPartIntegrity(
        db({
          products: [product('P-1')],
          skus: [priced('P-1', { active: false })],
          sourcing: [link('P-1', 'Resilite')],
          categories: cats,
        }),
      );
      expect(rules(r)).toEqual(['active-mismatch']);
    });
  });

  it('reports every violation on a part, not just the first', async () => {
    const r = await checkPartIntegrity(
      db({
        products: [product('P-1')],
        skus: [
          priced('P-1', {
            manufacturer: 'Goldberg Brothers',
            category: 'Flooring',
            active: false,
          }),
        ],
        sourcing: [link('P-1', 'Productive Tool Products')],
        categories: cats,
      }),
    );
    expect(rules(r)).toEqual(['active-mismatch', 'vendor-not-sourced']);
    // Ordering from an unlisted vendor can send a purchase order to the wrong company;
    // the active mismatch cannot reach anyone outside the building.
    expect(r.blocking).toBe(1);
  });

  it('counts and groups so a summary does not print every row', async () => {
    const many = Array.from({ length: 40 }, (_, i) => product('P-' + i));
    const r = await checkPartIntegrity(db({ products: many, categories: cats }));
    expect(r.byRule['product-without-sku']).toBe(40);
    expect(formatIntegrityReport(r, 5)).toContain('+35 more');
  });
});
