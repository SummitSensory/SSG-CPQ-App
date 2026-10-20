import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcurementSeed } from '../../src/handoff/lock.js';

/**
 * src/handoff/bomBuild.ts's two rules: kit components, and the Processing Service
 * Supplier (which replaced free issue and "also on vendor"). A processing part must
 * appear on BOTH vendors' sheets — the purchase line stays on the Procurement
 * Supplier and ONE more line is added on the processing supplier's. Prisma is a plain
 * stub, not a mock library, matching this repo's existing integration-test convention
 * (see tests/integration/part-integrity.test.ts's own note on it).
 */

interface SkuRow {
  part: string;
  keepParentOnBom?: boolean;
  processingEnabled?: boolean;
  secondaryVendor?: string | null;
  secondaryVendorCostMinor?: number | null;
  processingFeeBasis?: 'PER_UNIT' | 'PER_ORDER';
  processingSku?: string | null;
  description?: string;
  unitCostMinor?: number;
  weightLbs?: number;
  manufacturer?: string | null;
}

let SKUS: SkuRow[] = [];
let COMPONENTS: Array<{
  parentPart: string;
  childPart: string;
  quantity: number;
  active: boolean;
}> = [];
const LINES = new Map<string, Record<string, unknown>[]>();
const EVENTS: Array<Record<string, unknown>> = [];
let SUBMITTED: Array<{ orderId: string; vendor: string }> = [];
let nextId = 0;
const newId = (): string => 'line-' + ++nextId;

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    skuComponent: {
      findMany: async ({ where }: { where?: { active?: boolean } } = {}) =>
        COMPONENTS.filter((c) => (where?.active === undefined ? true : c.active === where.active)),
    },
    sku: {
      findMany: async ({
        where,
      }: {
        where?: { part?: { in: string[] }; OR?: Array<Record<string, unknown>> };
      } = {}) => {
        let rows = SKUS.slice();
        if (where?.part?.in) {
          const set = new Set(where.part.in.map((p) => p.toUpperCase()));
          rows = rows.filter((r) => set.has(r.part.toUpperCase()));
        }
        if (where?.OR) {
          const or = where.OR;
          rows = rows.filter((r) =>
            or.some((cond) => {
              if ('keepParentOnBom' in cond) return r.keepParentOnBom === true;
              if ('processingEnabled' in cond) return !!r.processingEnabled && !!r.secondaryVendor;
              return false;
            }),
          );
        }
        return rows;
      },
    },
    product: { findMany: async () => [] },
    productCost: { findMany: async () => [] },
    productSourcing: { findMany: async () => [] },
    procurementLine: {
      findMany: async ({ where }: { where: { orderId: string } }) => LINES.get(where.orderId) ?? [],
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const row of data) {
          const orderId = row.orderId as string;
          const list = LINES.get(orderId) ?? [];
          list.push({ id: newId(), ...row });
          LINES.set(orderId, list);
        }
        return { count: data.length };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const orderId = data.orderId as string;
        const row = { id: newId(), ...data };
        LINES.set(orderId, (LINES.get(orderId) ?? []).concat(row));
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        for (const list of LINES.values()) {
          const row = list.find((l) => l.id === where.id);
          if (row) return Object.assign(row, data);
        }
        throw new Error('no such line ' + where.id);
      },
      delete: async ({ where }: { where: { id: string } }) => {
        for (const [orderId, list] of LINES) {
          const row = list.find((l) => l.id === where.id);
          if (row) {
            LINES.set(
              orderId,
              list.filter((l) => l !== row),
            );
            return row;
          }
        }
        throw new Error('no such line ' + where.id);
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        for (const [orderId, list] of LINES) {
          LINES.set(
            orderId,
            list.filter((l) => !where.id.in.includes(l.id as string)),
          );
        }
        return { count: 0 };
      },
    },
    bomVendorSection: {
      findMany: async ({ where }: { where: { orderId: string } }) =>
        SUBMITTED.filter((r) => r.orderId === where.orderId),
    },
    orderEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        EVENTS.push(data);
        return data;
      },
    },
  },
}));

const { expandBomBuild, applyBomBuildToOrder, loadBuildTables, processingLineData } =
  await import('../../src/handoff/bomBuild.js');

const seed = (over: Partial<ProcurementSeed> = {}): ProcurementSeed => ({
  productId: null,
  sku: 'PLAIN-1',
  name: 'Plain part',
  quantity: 1,
  ...over,
});

/** Goldberg Brothers repackages ABC at $7.50 a unit under their own part number. */
const goldberg = (over: Partial<SkuRow> = {}): SkuRow => ({
  part: 'ABC',
  processingEnabled: true,
  secondaryVendor: 'Goldberg Brothers',
  secondaryVendorCostMinor: 750,
  processingFeeBasis: 'PER_UNIT',
  processingSku: 'GB-REPACK-ABC',
  ...over,
});

beforeEach(() => {
  SKUS = [];
  COMPONENTS = [];
  LINES.clear();
  EVENTS.length = 0;
  SUBMITTED = [];
});

describe('loadBuildTables', () => {
  it('reads keep-parent and processing rules from the SKU master', async () => {
    SKUS = [
      { part: 'KIT-1', keepParentOnBom: true },
      goldberg({ part: 'sec-1', processingFeeBasis: 'PER_ORDER', processingSku: '  ' }),
    ];
    const t = await loadBuildTables();
    expect(t.keepParent.has('KIT-1')).toBe(true);
    expect(t.processing.get('SEC-1')).toEqual({
      vendor: 'Goldberg Brothers',
      costMinor: 750,
      perOrder: true,
      vendorPartNo: null,
    });
    expect(t).not.toHaveProperty('freeIssueVendor');
  });

  it('ignores a processing supplier whose checkbox is off', async () => {
    SKUS = [{ part: 'OFF-1', processingEnabled: false, secondaryVendor: 'Goldberg Brothers' }];
    const t = await loadBuildTables();
    expect(t.processing.size).toBe(0);
  });
});

describe('expandBomBuild — unaffected parts (regression guard)', () => {
  it('leaves a plain part with no rule completely unchanged', async () => {
    const out = await expandBomBuild([seed()]);
    expect(out).toEqual([seed()]);
  });

  it('does nothing at all when the rule tables are empty', async () => {
    const seeds = [seed({ sku: 'A' }), seed({ sku: 'B', quantity: 3 })];
    const out = await expandBomBuild(seeds);
    expect(out).toEqual(seeds);
  });
});

describe('expandBomBuild — kit components (existing rule)', () => {
  it('replaces the parent with its components, quantities multiplied through', async () => {
    SKUS = [{ part: 'CHILD-1', unitCostMinor: 250, weightLbs: 1.5 }];
    COMPONENTS = [{ parentPart: 'KIT-1', childPart: 'CHILD-1', quantity: 2, active: true }];
    const out = await expandBomBuild([seed({ sku: 'KIT-1', quantity: 3 })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sku: 'CHILD-1', quantity: 6, kitSku: 'KIT-1' });
  });

  it('keeps the parent beside its components when keepParentOnBom is set', async () => {
    SKUS = [{ part: 'KIT-1', keepParentOnBom: true }, { part: 'CHILD-1' }];
    COMPONENTS = [{ parentPart: 'KIT-1', childPart: 'CHILD-1', quantity: 1, active: true }];
    const out = await expandBomBuild([seed({ sku: 'KIT-1' })]);
    expect(out.map((s) => s.sku)).toEqual(['KIT-1', 'CHILD-1']);
  });
});

describe('expandBomBuild — processing service supplier', () => {
  it('keeps the purchase line and adds ONE processing line on the processing supplier', async () => {
    SKUS = [goldberg()];
    const original = seed({ sku: 'ABC', name: 'Product A', quantity: 4 });
    const out = await expandBomBuild([original]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(original);
    expect(out[1]).toMatchObject({
      sku: 'ABC',
      name: 'Product A',
      quantity: 4,
      vendorOverride: 'Goldberg Brothers',
      forcedUnitCostMinor: 750,
      secondaryOfSku: 'ABC',
      costPerOrder: false,
      vendorPartNo: 'GB-REPACK-ABC',
    });
    expect(out.some((s) => 'freeIssue' in s)).toBe(false);
  });

  it('two seeds of the same part → exactly one processing seed with the summed quantity', async () => {
    SKUS = [goldberg()];
    const a = seed({ sku: 'ABC', name: 'Product A', quantity: 3, proposalLineOrder: 2 });
    const b = seed({ sku: 'abc', name: 'Product A', quantity: 5, proposalLineOrder: 9 });
    const out = await expandBomBuild([a, b]);
    // Both purchase seeds untouched — the part stays on the Procurement Supplier's sheet.
    expect(out.slice(0, 2)).toEqual([a, b]);
    const processing = out.filter((s) => s.secondaryOfSku);
    expect(processing).toHaveLength(1);
    expect(processing[0]).toMatchObject({
      quantity: 8,
      vendorOverride: 'Goldberg Brothers',
      proposalLineOrder: 2,
    });
  });

  it('a per-order fee sets costPerOrder on the processing seed', async () => {
    SKUS = [goldberg({ processingFeeBasis: 'PER_ORDER', secondaryVendorCostMinor: 2500 })];
    const out = await expandBomBuild([seed({ sku: 'ABC', quantity: 10 })]);
    expect(out[1]).toMatchObject({ costPerOrder: true, forcedUnitCostMinor: 2500, quantity: 10 });
  });

  it('defaults the fee to $0 when none is set', async () => {
    SKUS = [goldberg({ secondaryVendorCostMinor: null, processingSku: null })];
    const out = await expandBomBuild([seed({ sku: 'ABC' })]);
    expect(out[1]?.forcedUnitCostMinor).toBe(0);
    expect(out[1]?.vendorPartNo).toBeNull();
  });

  it('adds nothing when the processing checkbox is off, even with a supplier on file', async () => {
    SKUS = [goldberg({ processingEnabled: false })];
    const out = await expandBomBuild([seed({ sku: 'ABC' })]);
    expect(out).toHaveLength(1);
  });

  it('adds nothing for a part with no processing supplier', async () => {
    SKUS = [goldberg({ secondaryVendor: null })];
    const out = await expandBomBuild([seed({ sku: 'ABC' })]);
    expect(out).toHaveLength(1);
  });

  it('adds nothing for a zero-quantity line', async () => {
    SKUS = [goldberg()];
    const out = await expandBomBuild([seed({ sku: 'ABC', quantity: 0 })]);
    expect(out).toHaveLength(1);
  });

  it('applies to a kit component that carries the rule, at the exploded quantity', async () => {
    SKUS = [goldberg({ part: 'CHILD-1', secondaryVendorCostMinor: 100 })];
    COMPONENTS = [{ parentPart: 'KIT-1', childPart: 'CHILD-1', quantity: 2, active: true }];
    const out = await expandBomBuild([seed({ sku: 'KIT-1', quantity: 3 })]);
    expect(out.map((s) => s.sku)).toEqual(['CHILD-1', 'CHILD-1']);
    expect(out[0]).toMatchObject({ kitSku: 'KIT-1', quantity: 6 });
    expect(out[1]).toMatchObject({
      vendorOverride: 'Goldberg Brothers',
      forcedUnitCostMinor: 100,
      quantity: 6,
      secondaryOfSku: 'CHILD-1',
      kitSku: null,
    });
  });
});

describe('processingLineData', () => {
  it('builds the row with the fee, basis, Repackaging SKU and procurement supplier', async () => {
    SKUS = [goldberg({ processingFeeBasis: 'PER_ORDER' })];
    const out = await expandBomBuild([seed({ sku: 'ABC', name: 'Product A', quantity: 4 })]);
    const s = out[1];
    if (!s) throw new Error('expected a processing seed');
    expect(processingLineData('order-x', s, 'Amazon')).toMatchObject({
      orderId: 'order-x',
      sku: 'ABC',
      quantity: 4,
      quantityOriginal: 4,
      vendor: 'Goldberg Brothers',
      purchaseVendor: 'Amazon',
      unitCostMinor: 750,
      secondaryOfSku: 'ABC',
      costPerOrder: true,
      vendorPartNo: 'GB-REPACK-ABC',
    });
  });
});

describe('applyBomBuildToOrder — retroactive processing line', () => {
  const amazonLine = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'l1',
    sku: 'ABC',
    name: 'Product A',
    quantity: 4,
    vendor: 'Amazon',
    secondaryOfSku: null,
    ...over,
  });
  const linesOf = (orderId: string): Record<string, unknown>[] => LINES.get(orderId) ?? [];

  it('adds the processing line to an already-locked order, and is idempotent on re-run', async () => {
    SKUS = [goldberg()];
    LINES.set('order-1', [amazonLine()]);

    const first = await applyBomBuildToOrder('order-1', 'user-1');
    expect(first.secondaryAdded).toBe(1);
    expect(first).not.toHaveProperty('redirected');
    expect(linesOf('order-1')).toHaveLength(2);
    // The purchase line never moves.
    expect(linesOf('order-1')[0]).toMatchObject({ vendor: 'Amazon', quantity: 4 });
    const added = linesOf('order-1').find((l) => l.secondaryOfSku === 'ABC');
    expect(added).toMatchObject({
      vendor: 'Goldberg Brothers',
      purchaseVendor: 'Amazon',
      unitCostMinor: 750,
      quantity: 4,
      vendorPartNo: 'GB-REPACK-ABC',
      costPerOrder: false,
    });
    expect(EVENTS.at(-1)?.detail).toMatchObject({ secondaryAdded: 1 });

    const second = await applyBomBuildToOrder('order-1', 'user-1');
    expect(second.secondaryAdded).toBe(0);
    expect(second.secondaryTopUps).toEqual([]);
    expect(linesOf('order-1')).toHaveLength(2);
  });

  it('tops up a short processing line to cover the purchase lines', async () => {
    SKUS = [goldberg()];
    LINES.set('order-6', [
      amazonLine(),
      amazonLine({ id: 'l2', quantity: 2 }),
      { id: 'p1', sku: 'ABC', quantity: 4, vendor: 'Goldberg Brothers', secondaryOfSku: 'ABC' },
    ]);
    const r = await applyBomBuildToOrder('order-6', 'user-1');
    expect(r.secondaryAdded).toBe(0);
    expect(r.secondaryTopUps).toEqual(['ABC']);
    expect(linesOf('order-6').find((l) => l.id === 'p1')?.quantity).toBe(6);
  });

  it('skips a part whose processing supplier’s sheet is submitted, and says so', async () => {
    SKUS = [goldberg()];
    SUBMITTED = [{ orderId: 'order-7', vendor: 'Goldberg Brothers' }];
    LINES.set('order-7', [amazonLine()]);
    const r = await applyBomBuildToOrder('order-7', 'user-1');
    expect(r.secondaryAdded).toBe(0);
    expect(r.secondarySkipped).toHaveLength(1);
    expect(r.secondarySkipped[0]).toContain('Goldberg Brothers');
    expect(linesOf('order-7')).toHaveLength(1);
  });

  it('adds no processing line beside a purchase line already on the processing supplier', async () => {
    SKUS = [goldberg()];
    LINES.set('order-8', [amazonLine({ vendor: 'Goldberg Brothers' })]);
    const r = await applyBomBuildToOrder('order-8', 'user-1');
    expect(r.secondaryAdded).toBe(0);
    expect(linesOf('order-8')).toHaveLength(1);
  });

  it('never explodes a processing line into kit components', async () => {
    SKUS = [goldberg({ part: 'KIT-1' }), { part: 'CHILD-1' }];
    COMPONENTS = [{ parentPart: 'KIT-1', childPart: 'CHILD-1', quantity: 1, active: true }];
    LINES.set('order-9', [
      { id: 'c1', sku: 'CHILD-1', kitSku: 'KIT-1', quantity: 1, vendor: 'Amazon' },
      { id: 'p1', sku: 'KIT-1', quantity: 1, vendor: 'Goldberg Brothers', secondaryOfSku: 'KIT-1' },
    ]);
    const r = await applyBomBuildToOrder('order-9', 'user-1');
    expect(r.exploded).toEqual([]);
    expect(linesOf('order-9').map((l) => l.id)).toEqual(['c1', 'p1']);
  });

  it('does not touch an order with no matching rule', async () => {
    SKUS = [];
    LINES.set('order-2', [
      { id: 'l1', sku: 'PLAIN-1', name: 'Plain', quantity: 1, vendor: 'Vendor A' },
    ]);
    const result = await applyBomBuildToOrder('order-2', 'user-1');
    expect(result.secondaryAdded).toBe(0);
    expect(linesOf('order-2')).toHaveLength(1);
  });
});

describe('applyBomBuildToOrder — retired free-issue lines', () => {
  /** Locked under free issue: the purchase MOVED to the receiving vendor at its cost. */
  const freeIssueLine = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'f1',
    sku: 'ABC',
    name: 'Product A',
    quantity: 3,
    vendor: 'Goldberg Brothers',
    unitCostMinor: 900,
    freeIssue: true,
    purchaseVendor: 'Amazon',
    secondaryOfSku: null,
    ...over,
  });
  const linesOf = (orderId: string): Record<string, unknown>[] => LINES.get(orderId) ?? [];

  it('moves the line back to its purchase vendor and adds the processing line, once', async () => {
    SKUS = [goldberg({ manufacturer: 'Amazon' })];
    LINES.set('fi-1', [freeIssueLine()]);
    const r = await applyBomBuildToOrder('fi-1', 'user-1');
    expect(r.freeIssueRestored).toEqual(['ABC']);
    expect(r.secondaryAdded).toBe(1);
    expect(linesOf('fi-1').find((l) => l.id === 'f1')).toMatchObject({
      vendor: 'Amazon',
      freeIssue: false,
      purchaseVendor: null,
      unitCostMinor: 900,
      quantity: 3,
    });
    expect(linesOf('fi-1').find((l) => l.secondaryOfSku === 'ABC')).toMatchObject({
      vendor: 'Goldberg Brothers',
      purchaseVendor: 'Amazon',
      quantity: 3,
      unitCostMinor: 750,
    });
    expect(EVENTS.at(-1)?.detail).toMatchObject({ freeIssueRestored: ['ABC'] });

    const again = await applyBomBuildToOrder('fi-1', 'user-1');
    expect(again.freeIssueRestored).toEqual([]);
    expect(again.secondaryAdded).toBe(0);
    expect(linesOf('fi-1')).toHaveLength(2);
  });

  it('falls back to the catalog vendor when the line recorded no purchase vendor', async () => {
    SKUS = [goldberg({ manufacturer: 'Amazon' })];
    LINES.set('fi-2', [freeIssueLine({ purchaseVendor: null })]);
    const r = await applyBomBuildToOrder('fi-2', 'user-1');
    expect(r.freeIssueRestored).toEqual(['ABC']);
    expect(linesOf('fi-2').find((l) => l.id === 'f1')?.vendor).toBe('Amazon');
  });

  it('leaves a free-issue line alone when its part has no processing rule', async () => {
    SKUS = [
      goldberg({ processingEnabled: false, manufacturer: 'Amazon' }),
      { part: 'KEEP-1', keepParentOnBom: true },
    ];
    LINES.set('fi-3', [freeIssueLine()]);
    const r = await applyBomBuildToOrder('fi-3', 'user-1');
    expect(r.freeIssueRestored).toEqual([]);
    expect(linesOf('fi-3')[0]).toMatchObject({ vendor: 'Goldberg Brothers', freeIssue: true });
  });

  it.each([['Goldberg Brothers'], ['Amazon']])(
    'leaves a free-issue line alone when the %s sheet is submitted',
    async (vendor) => {
      SKUS = [goldberg({ manufacturer: 'Amazon' })];
      SUBMITTED = [{ orderId: 'fi-4', vendor }];
      LINES.set('fi-4', [freeIssueLine()]);
      const r = await applyBomBuildToOrder('fi-4', 'user-1');
      expect(r.freeIssueRestored).toEqual([]);
      expect(linesOf('fi-4').find((l) => l.id === 'f1')).toMatchObject({
        vendor: 'Goldberg Brothers',
        freeIssue: true,
        purchaseVendor: 'Amazon',
      });
    },
  );

  /**
   * Was a bug: the skip was pushed onto result.secondarySkipped, and then
   * `result.secondarySkipped = sync.skipped` (reconcile's own list) overwrites it, so the
   * caller is never told the free-issue line was left on a submitted sheet.
   */
  it('reports a free-issue line skipped for a submitted sheet', async () => {
    SKUS = [goldberg({ manufacturer: 'Amazon' })];
    SUBMITTED = [{ orderId: 'fi-5', vendor: 'Goldberg Brothers' }];
    LINES.set('fi-5', [freeIssueLine()]);
    const r = await applyBomBuildToOrder('fi-5', 'user-1');
    expect(r.secondarySkipped.some((s) => s.includes('free-issue'))).toBe(true);
  });
});

describe('applyBomBuildToOrder — a processing kit parent exploded after lock', () => {
  const linesOf = (orderId: string): Record<string, unknown>[] => LINES.get(orderId) ?? [];

  it('removes the parent’s processing line once none of the parent is bought', async () => {
    SKUS = [goldberg({ part: 'KIT-1' }), { part: 'CHILD-1', manufacturer: 'Amazon' }];
    COMPONENTS = [{ parentPart: 'KIT-1', childPart: 'CHILD-1', quantity: 2, active: true }];
    LINES.set('kp-1', [
      { id: 'k1', sku: 'KIT-1', name: 'Kit', quantity: 3, vendor: 'Amazon', secondaryOfSku: null },
      {
        id: 'p1',
        sku: 'KIT-1',
        quantity: 3,
        vendor: 'Goldberg Brothers',
        secondaryOfSku: 'KIT-1',
      },
    ]);
    const r = await applyBomBuildToOrder('kp-1', 'user-1');
    expect(r.exploded).toEqual(['KIT-1']);
    expect(linesOf('kp-1').map((l) => [l.sku, l.quantity, l.secondaryOfSku ?? null])).toEqual([
      ['CHILD-1', 6, null],
    ]);
  });

  it('keeps it when the parent stays on the sheet beside its components', async () => {
    SKUS = [
      goldberg({ part: 'KIT-1', keepParentOnBom: true }),
      { part: 'CHILD-1', manufacturer: 'Amazon' },
    ];
    COMPONENTS = [{ parentPart: 'KIT-1', childPart: 'CHILD-1', quantity: 2, active: true }];
    LINES.set('kp-2', [
      { id: 'k1', sku: 'KIT-1', name: 'Kit', quantity: 3, vendor: 'Amazon', secondaryOfSku: null },
      {
        id: 'p1',
        sku: 'KIT-1',
        quantity: 3,
        vendor: 'Goldberg Brothers',
        secondaryOfSku: 'KIT-1',
      },
    ]);
    await applyBomBuildToOrder('kp-2', 'user-1');
    expect(linesOf('kp-2').some((l) => l.id === 'p1')).toBe(true);
  });

  it('keeps it when the processing sheet is submitted', async () => {
    SKUS = [goldberg({ part: 'KIT-1' }), { part: 'CHILD-1', manufacturer: 'Amazon' }];
    COMPONENTS = [{ parentPart: 'KIT-1', childPart: 'CHILD-1', quantity: 2, active: true }];
    SUBMITTED = [{ orderId: 'kp-3', vendor: 'Goldberg Brothers' }];
    LINES.set('kp-3', [
      { id: 'k1', sku: 'KIT-1', name: 'Kit', quantity: 3, vendor: 'Amazon', secondaryOfSku: null },
      {
        id: 'p1',
        sku: 'KIT-1',
        quantity: 3,
        vendor: 'Goldberg Brothers',
        secondaryOfSku: 'KIT-1',
      },
    ]);
    await applyBomBuildToOrder('kp-3', 'user-1');
    expect(linesOf('kp-3').some((l) => l.id === 'p1')).toBe(true);
  });
});

describe('applyBomBuildToOrder — a parent kept after the order was locked', () => {
  /**
   * A-2216 explodes into two scoop slides. "Keep the parent line" was switched on after
   * orders were already locked, so those orders hold the slides but not the deck, and
   * re-applying skipped the part as already expanded.
   */
  const slideRule = (): void => {
    SKUS = [
      {
        part: 'A-2216',
        keepParentOnBom: true,
        description: 'Summit Adventure Slide',
        unitCostMinor: 5000,
        manufacturer: 'Goldberg Brothers',
      },
    ];
    COMPONENTS = [
      { parentPart: 'A-2216', childPart: 'B01MUEBGVK', quantity: 1, active: true },
      { parentPart: 'A-2216', childPart: 'B0018L8RJG', quantity: 1, active: true },
    ];
  };

  it('puts the parent back beside its components, once', async () => {
    slideRule();
    LINES.set('order-3', [
      {
        id: 'k1',
        sku: 'B01MUEBGVK',
        kitSku: 'A-2216',
        quantity: 2,
        quantityOriginal: 2,
        proposalLineOrder: 7,
      },
      {
        id: 'k2',
        sku: 'B0018L8RJG',
        kitSku: 'A-2216',
        quantity: 2,
        quantityOriginal: 2,
        proposalLineOrder: 7,
      },
    ]);
    const first = await applyBomBuildToOrder('order-3', 'user-1');
    expect(first.parentsRestored).toEqual(['A-2216']);
    expect(first.componentsAdded).toBe(0);
    const parent = LINES.get('order-3')!.find((l) => l.sku === 'A-2216');
    expect(parent).toMatchObject({
      quantity: 2,
      name: 'Summit Adventure Slide',
      vendor: 'Goldberg Brothers',
      unitCostMinor: 5000,
      proposalLineOrder: 7,
      kitSku: null,
    });
    expect(LINES.get('order-3')).toHaveLength(3); // the components stay
    expect(EVENTS.at(-1)?.detail).toMatchObject({ parentsRestored: ['A-2216'] });

    const second = await applyBomBuildToOrder('order-3', 'user-1');
    expect(second.parentsRestored).toEqual([]);
    expect(LINES.get('order-3')).toHaveLength(3);
  });

  it('leaves an order alone where the parent was already added back by hand', async () => {
    slideRule();
    LINES.set('order-4', [
      { id: 'k1', sku: 'B01MUEBGVK', kitSku: 'A-2216', quantity: 1 },
      { id: 'p1', sku: 'A-2216', kitSku: null, quantity: 1 },
    ]);
    const r = await applyBomBuildToOrder('order-4', 'user-1');
    expect(r.parentsRestored).toEqual([]);
    expect(LINES.get('order-4')).toHaveLength(2);
  });

  it('reads the parent quantity from the component’s original count, not an edit', async () => {
    slideRule();
    LINES.set('order-5', [
      { id: 'k1', sku: 'B01MUEBGVK', kitSku: 'A-2216', quantity: 5, quantityOriginal: 1 },
    ]);
    await applyBomBuildToOrder('order-5', 'user-1');
    expect(LINES.get('order-5')!.find((l) => l.sku === 'A-2216')?.quantity).toBe(1);
  });
});
