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
        where.id ? s.orders.get(where.id) ?? null : s.byVersion.get(where.proposalVersionId!) ?? null,
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `o${s.seq++}`;
        const row = { id, ...data };
        s.orders.set(id, row);
        s.byVersion.set(data.proposalVersionId as string, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = { ...s.orders.get(where.id), ...data }; s.orders.set(where.id, row); return row;
      },
    },
    proposalVersion: { findUnique: async () => s.version },
    priceSnapshot: { findUnique: async () => s.snapshot },
    orderEvent: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return { prisma };
});

function seed(status = 'ACCEPTED') {
  h.store.version = {
    id: 'v1', version: 2, proposalId: 'p1', status, frozen: true, priceSnapshotId: 'ps1', ruleSnapshotId: null,
    sections: [{ id: 's1', enabled: true }],
    items: [{ ref: 'l1', productId: 'prod1', name: 'Swing', quantity: 2, kind: 'INCLUDED' }],
    proposal: { organizationId: 'org1', number: 'P-2025-001' },
  };
  h.store.snapshot = { id: 'ps1', currency: 'USD', grandTotal: 100000n, breakdown: { payment: { deposit: 30000, progress: 0, final: 70000 } } };
}

const approval = { method: 'PURCHASE_ORDER' as const, approverName: 'Dr. Lee', approvedAt: new Date('2026-01-05') };

beforeEach(() => {
  h.store.orders.clear(); h.store.byVersion.clear(); h.store.seq = 1;
  seed();
});

describe('createAcceptedOrder', () => {
  it('locks the exact accepted version + pricing with a deposit and integrity hash', async () => {
    const { createAcceptedOrder } = await import('../../src/handoff/service.js');
    const order = await createAcceptedOrder('v1', approval, 'user-1') as Record<string, unknown>;
    expect(order.proposalVersionId).toBe('v1');
    expect(order.acceptedVersion).toBe(2);
    expect(order.priceSnapshotId).toBe('ps1');
    expect((order.grandTotalMinor as bigint)).toBe(100000n);
    expect(order.depositRequired).toBe(true);
    expect((order.depositDueMinor as bigint)).toBe(30000n);
    expect(order.locked).toBeUndefined(); // defaulted by DB; not overridden
    expect(typeof order.integrityHash).toBe('string');
  });

  it('is idempotent — a version already locked returns the same order', async () => {
    const { createAcceptedOrder } = await import('../../src/handoff/service.js');
    const a = await createAcceptedOrder('v1', approval, 'user-1') as Record<string, unknown>;
    const b = await createAcceptedOrder('v1', approval, 'user-1') as Record<string, unknown>;
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
    await expect(createAcceptedOrder('v1', { ...approval, approverName: '' }, 'user-1')).rejects.toThrow(/approver/i);
  });
});

describe('verifyIntegrity', () => {
  it('passes when the referenced version + snapshot are unchanged', async () => {
    const { createAcceptedOrder, verifyIntegrity } = await import('../../src/handoff/service.js');
    const order = await createAcceptedOrder('v1', approval, 'user-1') as { id: string };
    const res = await verifyIntegrity(order.id);
    expect(res.ok).toBe(true);
  });

  it('fails when the accepted total is later altered (edits cannot silently change the order)', async () => {
    const { createAcceptedOrder, verifyIntegrity } = await import('../../src/handoff/service.js');
    const order = await createAcceptedOrder('v1', approval, 'user-1') as { id: string };
    (h.store.snapshot as Record<string, unknown>).grandTotal = 120000n; // tampered upstream
    const res = await verifyIntegrity(order.id);
    expect(res.ok).toBe(false);
  });
});
