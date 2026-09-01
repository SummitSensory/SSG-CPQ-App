import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Accept-and-lock behavior: an order references the EXACT accepted version +
 * price snapshot, is idempotent, refuses non-accepted versions, and its
 * integrity check detects any later drift (proving edits can't silently alter
 * the accepted order).
 */
const h = vi.hoisted(() => ({
  store: {
    orders: new Map<string, Record<string, unknown>>(),
    byVersion: new Map<string, Record<string, unknown>>(),
    version: null as Record<string, unknown> | null,
    snapshot: null as Record<string, unknown> | null,
    seq: 1,
  },
}));

vi.mock('../../src/lib/audit.js', () => ({ recordAudit: vi.fn() }));

vi.mock('../../src/lib/prisma.js', () => {
  const s = h.store;
  const prisma = {
    acceptedOrder: {
      findUnique: async ({ where }: { where: { id?: string; proposalVersionId?: string } }) =>
        where.id
          ? (s.orders.get(where.id) ?? null)
          : (s.byVersion.get(where.proposalVersionId!) ?? null),
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `o${s.seq++}`;
        const row = { id, ...data };
        s.orders.set(id, row);
        s.byVersion.set(data.proposalVersionId as string, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = { ...s.orders.get(where.id), ...data };
        s.orders.set(where.id, row);
        return row;
      },
    },
    // resolveCatalogRefs() looks up procurement identity (part number, vendor,
    // cost, weight) for every order line. These tests assert on version locking
    // and integrity hashing, not catalog resolution, so no matches is the right
    // neutral input — the service falls back to nulls.
    product: { findMany: async () => [] },
    sku: { findMany: async () => [] },
    proposalVersion: { findUnique: async () => s.version },
    priceSnapshot: { findUnique: async () => s.snapshot },
    /*
     * Cross-border charges. `createAcceptedOrder` and `prepareTransaction` both reach
     * `sellerCollectedCharges`, which queries this model first — and it was absent from
     * this stub, so all nine tests in these two files threw
     * "Cannot read properties of undefined (reading 'findFirst')" before reaching a
     * single assertion.
     *
     * Nobody had seen it because the repo's habit was `pnpm test:unit`; these live in
     * tests/integration. So the guards on accepted-order locking, the integrity hash and
     * QuickBooks idempotency — the money path — were not running at all.
     *
     * An EMPTY snapshot rather than null: `sellerCollectedCharges` returns
     * `{ ...EMPTY, source: 'SNAPSHOT' }` for a snapshot with no charge lines and stops
     * there, whereas null sends it on to `crossBorderStateFor` and a chain of further
     * models these tests have no reason to describe. Zero cross-border charge is also the
     * right answer for these fixtures, which are US-domestic and about locking and
     * idempotency, not customs.
     */
    proposalCrossBorderSnapshot: { findFirst: async () => ({ chargeLines: [] }) },
    orderEvent: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return { prisma };
});

function seed(status = 'ACCEPTED') {
  h.store.version = {
    id: 'v1',
    version: 2,
    proposalId: 'p1',
    status,
    frozen: true,
    priceSnapshotId: 'ps1',
    ruleSnapshotId: null,
    sections: [{ id: 's1', enabled: true }],
    items: [{ ref: 'l1', productId: 'prod1', name: 'Swing', quantity: 2, kind: 'INCLUDED' }],
    proposal: { organizationId: 'org1', number: 'P-2025-001' },
  };
  h.store.snapshot = {
    id: 'ps1',
    currency: 'USD',
    grandTotal: 100000n,
    breakdown: { payment: { deposit: 30000, progress: 0, final: 70000 } },
  };
}

const approval = {
  method: 'PURCHASE_ORDER' as const,
  approverName: 'Dr. Lee',
  approvedAt: new Date('2026-01-05'),
};

beforeEach(() => {
  h.store.orders.clear();
  h.store.byVersion.clear();
  h.store.seq = 1;
  seed();
});

describe('createAcceptedOrder', () => {
  it('locks the exact accepted version + pricing with a deposit and integrity hash', async () => {
    const { createAcceptedOrder } = await import('../../src/handoff/service.js');
    const order = (await createAcceptedOrder('v1', approval, 'user-1')) as Record<string, unknown>;
    expect(order.proposalVersionId).toBe('v1');
    expect(order.acceptedVersion).toBe(2);
    expect(order.priceSnapshotId).toBe('ps1');
    expect(order.grandTotalMinor as bigint).toBe(100000n);
    expect(order.depositRequired).toBe(true);
    expect(order.depositDueMinor as bigint).toBe(30000n);
    expect(order.locked).toBeUndefined(); // defaulted by DB; not overridden
    expect(typeof order.integrityHash).toBe('string');
  });

  it('is idempotent — a version already locked returns the same order', async () => {
    const { createAcceptedOrder } = await import('../../src/handoff/service.js');
    const a = (await createAcceptedOrder('v1', approval, 'user-1')) as Record<string, unknown>;
    const b = (await createAcceptedOrder('v1', approval, 'user-1')) as Record<string, unknown>;
    expect(b.id).toBe(a.id);
    expect(h.store.orders.size).toBe(1);
  });

  it('refuses to lock a version that is not ACCEPTED', async () => {
    seed('RELEASED');
    const { createAcceptedOrder } = await import('../../src/handoff/service.js');
    await expect(createAcceptedOrder('v1', approval, 'user-1')).rejects.toThrow(/ACCEPTED/);
  });

  it('requires a customer approver name', async () => {
    const { createAcceptedOrder } = await import('../../src/handoff/service.js');
    await expect(
      createAcceptedOrder('v1', { ...approval, approverName: '' }, 'user-1'),
    ).rejects.toThrow(/approver/i);
  });

  it('stamps each procurement line with its position on the accepted proposal, so the Bill of Materials can be sorted to match it', async () => {
    // Deliberately not in tree or alphabetical order — proving the BOM sort has
    // something other than SKU or product-tree position to key off.
    h.store.version!.items = [
      { ref: 'l1', productId: 'prod-z', name: 'Frame', quantity: 1, kind: 'INCLUDED' },
      { ref: 'l2', productId: 'prod-opt', name: 'Optional Extra', quantity: 1, kind: 'OPTIONAL' },
      {
        ref: 'l3',
        sku: 'H-1000',
        name: 'Hardware Kit',
        quantity: 1,
        kind: 'INCLUDED',
        components: [
          { part: '6820H-LA', name: 'Hex Bolt', qty: 4 },
          { part: '6820H-LB', name: 'Washer', qty: 8 },
        ],
      },
      { ref: 'l4', productId: 'prod-a', name: 'Ladder', quantity: 1, kind: 'INCLUDED' },
    ];
    const { createAcceptedOrder } = await import('../../src/handoff/service.js');
    const order = (await createAcceptedOrder('v1', approval, 'user-1')) as unknown as {
      procurement: {
        create: Array<{ name: string; sku: string | null; proposalLineOrder: number | null }>;
      };
    };
    const lines = order.procurement.create.map((p) => [p.sku ?? p.name, p.proposalLineOrder]);
    expect(lines).toEqual([
      ['Frame', 0],
      // The optional extra never became a line, so it consumed no position — the
      // kit inherits position 1, not 2.
      ['6820H-LA', 1],
      ['6820H-LB', 1],
      ['Ladder', 2],
    ]);
  });
});

describe('verifyIntegrity', () => {
  it('passes when the referenced version + snapshot are unchanged', async () => {
    const { createAcceptedOrder, verifyIntegrity } = await import('../../src/handoff/service.js');
    const order = (await createAcceptedOrder('v1', approval, 'user-1')) as { id: string };
    const res = await verifyIntegrity(order.id);
    expect(res.ok).toBe(true);
  });

  it('fails when the accepted total is later altered (edits cannot silently change the order)', async () => {
    const { createAcceptedOrder, verifyIntegrity } = await import('../../src/handoff/service.js');
    const order = (await createAcceptedOrder('v1', approval, 'user-1')) as { id: string };
    (h.store.snapshot as Record<string, unknown>).grandTotal = 120000n; // tampered upstream
    const res = await verifyIntegrity(order.id);
    expect(res.ok).toBe(false);
  });
});
