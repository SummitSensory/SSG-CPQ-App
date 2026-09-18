import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcurementSeed } from '../../src/handoff/lock.js';

/**
 * src/handoff/bomBuild.ts had zero test coverage before this file — confirmed via a
 * repo-wide search — for either of its two existing rules (kit components, free
 * issue), let alone the new third rule (secondary vendor) this file adds coverage
 * for alongside them. Prisma is a plain stub, not a mock library, matching this
 * repo's existing integration-test convention (see tests/integration/part-integrity.
 * test.ts's own note on it).
 */

interface SkuRow {
  part: string;
  keepParentOnBom?: boolean;
  freeIssueVendor?: string | null;
  secondaryVendor?: string | null;
  secondaryVendorCostMinor?: number | null;
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
          rows = rows.filter((r) =>
            where.OR!.some((cond) => {
              if ('keepParentOnBom' in cond) return r.keepParentOnBom === true;
              if ('NOT' in cond) {
                const not = cond.NOT as Record<string, unknown>;
                if ('freeIssueVendor' in not) return !!r.freeIssueVendor;
                if ('secondaryVendor' in not) return !!r.secondaryVendor;
              }
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
          list.push({
            id: 'line-' + (list.length + 1) + '-' + Math.random().toString(36).slice(2),
            ...row,
          });
          LINES.set(orderId, list);
        }
        return { count: data.length };
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
    orderEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        EVENTS.push(data);
        return data;
      },
    },
  },
}));

const { expandBomBuild, applyBomBuildToOrder, loadBuildTables } =
  await import('../../src/handoff/bomBuild.js');

const seed = (over: Partial<ProcurementSeed> = {}): ProcurementSeed => ({
  productId: null,
  sku: 'PLAIN-1',
  name: 'Plain part',
  quantity: 1,
  ...over,
});

beforeEach(() => {
  SKUS = [];
  COMPONENTS = [];
  LINES.clear();
  EVENTS.length = 0;
});

describe('loadBuildTables', () => {
  it('reads all three rules from the SKU master', async () => {
    SKUS = [
      { part: 'KIT-1', keepParentOnBom: true },
      { part: 'FREE-1', freeIssueVendor: 'Vendor B' },
      { part: 'SEC-1', secondaryVendor: 'Vendor C', secondaryVendorCostMinor: 500 },
    ];
    const t = await loadBuildTables();
    expect(t.keepParent.has('KIT-1')).toBe(true);
    expect(t.freeIssueVendor.get('FREE-1')).toBe('Vendor B');
    expect(t.secondaryVendor.get('SEC-1')).toEqual({ vendor: 'Vendor C', costMinor: 500 });
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

describe('expandBomBuild — free issue (existing rule)', () => {
  it('redirects the line to the receiving vendor, does not duplicate it', async () => {
    SKUS = [{ part: 'FREE-1', freeIssueVendor: 'Goldberg Brothers' }];
    const out = await expandBomBuild([seed({ sku: 'FREE-1' })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ freeIssue: true, vendorOverride: 'Goldberg Brothers' });
  });
});

describe('expandBomBuild — secondary vendor (new rule)', () => {
  it('adds a SECOND line for the second vendor, leaving the original untouched', async () => {
    SKUS = [{ part: 'ABC', secondaryVendor: 'Goldberg Brothers', secondaryVendorCostMinor: 750 }];
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
    });
  });

  it('defaults the secondary cost to $0 when none is set — a receiving note, not a charge', async () => {
    SKUS = [{ part: 'ABC', secondaryVendor: 'Goldberg Brothers', secondaryVendorCostMinor: null }];
    const out = await expandBomBuild([seed({ sku: 'ABC' })]);
    expect(out[1]?.forcedUnitCostMinor).toBe(0);
  });

  it('does nothing extra for a part with no secondaryVendor rule', async () => {
    SKUS = [{ part: 'ABC', secondaryVendor: null }];
    const out = await expandBomBuild([seed({ sku: 'ABC' })]);
    expect(out).toHaveLength(1);
  });

  it('composes with free issue: the redirected line can also fan out to a second vendor', async () => {
    SKUS = [
      {
        part: 'BOTH-1',
        freeIssueVendor: 'Vendor B',
        secondaryVendor: 'Vendor C',
        secondaryVendorCostMinor: 200,
      },
    ];
    const out = await expandBomBuild([seed({ sku: 'BOTH-1' })]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ freeIssue: true, vendorOverride: 'Vendor B' });
    expect(out[1]).toMatchObject({ vendorOverride: 'Vendor C', forcedUnitCostMinor: 200 });
  });

  it('applies to a kit component that itself carries the rule', async () => {
    SKUS = [{ part: 'CHILD-1', secondaryVendor: 'Vendor C', secondaryVendorCostMinor: 100 }];
    COMPONENTS = [{ parentPart: 'KIT-1', childPart: 'CHILD-1', quantity: 1, active: true }];
    const out = await expandBomBuild([seed({ sku: 'KIT-1' })]);
    expect(out.map((s) => s.sku)).toEqual(['CHILD-1', 'CHILD-1']);
    expect(out[1]).toMatchObject({ vendorOverride: 'Vendor C', forcedUnitCostMinor: 100 });
  });
});

describe('applyBomBuildToOrder — retroactive secondary vendor', () => {
  it('adds the second line to an already-locked order, and is idempotent on re-run', async () => {
    SKUS = [{ part: 'ABC', secondaryVendor: 'Goldberg Brothers', secondaryVendorCostMinor: 750 }];
    LINES.set('order-1', [
      {
        id: 'l1',
        sku: 'ABC',
        name: 'Product A',
        quantity: 4,
        vendor: 'Amazon',
        secondaryOfSku: null,
      },
    ]);

    const first = await applyBomBuildToOrder('order-1', 'user-1');
    expect(first.secondaryAdded).toBe(1);
    expect(LINES.get('order-1')).toHaveLength(2);
    const added = LINES.get('order-1')!.find((l) => l.secondaryOfSku === 'ABC');
    expect(added).toMatchObject({ vendor: 'Goldberg Brothers', unitCostMinor: 750, quantity: 4 });

    const second = await applyBomBuildToOrder('order-1', 'user-1');
    expect(second.secondaryAdded).toBe(0);
    expect(LINES.get('order-1')).toHaveLength(2);
  });

  it('does not touch an order with no matching rule', async () => {
    SKUS = [];
    LINES.set('order-2', [
      { id: 'l1', sku: 'PLAIN-1', name: 'Plain', quantity: 1, vendor: 'Vendor A' },
    ]);
    const result = await applyBomBuildToOrder('order-2', 'user-1');
    expect(result.secondaryAdded).toBe(0);
    expect(LINES.get('order-2')).toHaveLength(1);
  });
});
