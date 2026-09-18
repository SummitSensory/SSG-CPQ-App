import { describe, it, expect, vi } from 'vitest';

/**
 * A secondary-vendor procurement line (src/handoff/bomBuild.ts's withSecondaryVendor)
 * shares its `sku` with the part's own line but is deliberately forced to a different
 * cost — what the SECOND vendor charges, not the part's own vendor's catalog cost.
 * previewCostRefresh used to compare every line's cost against Sku.unitCostMinor
 * regardless of this, so a secondary line almost always showed as "differing from
 * catalog" and, pre-checked by default in the UI, would have its genuine agreed cost
 * silently overwritten with the primary vendor's catalog price on Apply.
 */

const orders = new Map<string, { id: string }>();
orders.set('o1', { id: 'o1' });

interface Line {
  id: string;
  sku: string;
  name: string;
  vendor: string;
  quantity: number;
  unitCostMinor: number;
  freeIssue: boolean;
  secondaryOfSku: string | null;
}

let LINES: Line[] = [];
let SKUS: Array<{
  part: string;
  unitCostMinor: number | null;
  secondaryVendorCostMinor: number | null;
}> = [];
const updates: Array<{ id: string; unitCostMinor: number }> = [];

vi.mock('../../src/lib/audit.js', () => ({ recordAudit: vi.fn() }));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    acceptedOrder: {
      findUnique: async ({ where }: { where: { id: string } }) => orders.get(where.id) ?? null,
    },
    procurementLine: {
      findMany: async () => LINES,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { unitCostMinor: number };
      }) => {
        updates.push({ id: where.id, unitCostMinor: data.unitCostMinor });
        return {};
      },
    },
    sku: {
      findMany: async () => SKUS,
    },
    bomVendorSection: {
      findMany: async () => [],
    },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
    orderEvent: {
      create: async () => ({}),
    },
  },
}));

const { previewCostRefresh, applyCostRefresh } = await import('../../src/handoff/costRefresh.js');

describe('previewCostRefresh — secondary-vendor lines', () => {
  it('does not report a secondary-vendor line as drift when it matches secondaryVendorCostMinor', async () => {
    LINES = [
      {
        id: 'primary',
        sku: 'A-2200',
        name: 'Frame',
        vendor: 'Acme',
        quantity: 1,
        unitCostMinor: 1000,
        freeIssue: false,
        secondaryOfSku: null,
      },
      {
        id: 'secondary',
        sku: 'A-2200',
        name: 'Frame',
        vendor: 'Goldberg Brothers',
        quantity: 1,
        unitCostMinor: 500,
        freeIssue: false,
        secondaryOfSku: 'a-2200',
      },
    ];
    SKUS = [{ part: 'A-2200', unitCostMinor: 1000, secondaryVendorCostMinor: 500 }];

    const preview = await previewCostRefresh('o1');
    expect(preview.rows).toHaveLength(0);
    expect(preview.changeable).toBe(0);
  });

  it('reports the secondary line as drift against secondaryVendorCostMinor, not the primary catalog cost', async () => {
    LINES = [
      {
        id: 'secondary',
        sku: 'A-2200',
        name: 'Frame',
        vendor: 'Goldberg Brothers',
        quantity: 2,
        unitCostMinor: 400, // stale — the catalog's secondary cost moved to 500
        freeIssue: false,
        secondaryOfSku: 'a-2200',
      },
    ];
    SKUS = [{ part: 'A-2200', unitCostMinor: 1000, secondaryVendorCostMinor: 500 }];

    const preview = await previewCostRefresh('o1');
    expect(preview.rows).toHaveLength(1);
    const row = preview.rows[0]!;
    expect(row.secondaryVendor).toBe(true);
    // Must compare against the secondary cost (500), never the primary vendor's
    // catalog cost (1000) — this is the exact corruption the fix closes.
    expect(row.catalogMinor).toBe(500);
    expect(row.deltaMinor).toBe(100);
    expect(row.extendedDeltaMinor).toBe(200);
  });

  it('applying a secondary line writes secondaryVendorCostMinor, never the primary catalog cost', async () => {
    LINES = [
      {
        id: 'secondary',
        sku: 'A-2200',
        name: 'Frame',
        vendor: 'Goldberg Brothers',
        quantity: 1,
        unitCostMinor: 400,
        freeIssue: false,
        secondaryOfSku: 'a-2200',
      },
    ];
    SKUS = [{ part: 'A-2200', unitCostMinor: 1000, secondaryVendorCostMinor: 500 }];
    updates.length = 0;

    const result = await applyCostRefresh('o1', ['secondary'], 'user1');
    expect(result.applied).toBe(1);
    expect(updates).toEqual([{ id: 'secondary', unitCostMinor: 500 }]);
  });

  it('an ordinary (non-secondary) line still compares against the primary catalog cost', async () => {
    LINES = [
      {
        id: 'primary',
        sku: 'A-2200',
        name: 'Frame',
        vendor: 'Acme',
        quantity: 1,
        unitCostMinor: 900,
        freeIssue: false,
        secondaryOfSku: null,
      },
    ];
    SKUS = [{ part: 'A-2200', unitCostMinor: 1000, secondaryVendorCostMinor: 500 }];

    const preview = await previewCostRefresh('o1');
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]!.secondaryVendor).toBe(false);
    expect(preview.rows[0]!.catalogMinor).toBe(1000);
  });
});
