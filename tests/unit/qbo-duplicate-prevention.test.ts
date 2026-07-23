import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Duplicate-prevention: the same financial action must never create two
 * documents. Verifies (a) prepare is idempotent by idempotency key, (b) execute
 * short-circuits an already-CREATED transaction, and (c) the QuickBooks
 * requestid passed on create equals the stable idempotency key.
 */
const h = vi.hoisted(() => ({
  store: {
    seq: 1,
    txns: new Map<string, Record<string, unknown>>(),
    version: null as Record<string, unknown> | null,
    snapshot: null as Record<string, unknown> | null,
  },
  createFn: vi.fn(),
  findOrCreate: vi.fn().mockResolvedValue({ qboId: 'C-1', created: false }),
}));

vi.mock('../../src/config/env.js', () => ({
  env: { QBO_ENVIRONMENT: 'sandbox', QBO_PRODUCTION_WRITE_ENABLED: false },
  qboEnvironment: () => 'SANDBOX',
}));
vi.mock('../../src/lib/audit.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../../src/integrations/quickbooks/client.js', () => ({ create: h.createFn }));
vi.mock('../../src/integrations/quickbooks/customers.js', () => ({ findOrCreateCustomer: h.findOrCreate }));
vi.mock('../../src/integrations/quickbooks/links.js', () => ({ findLink: vi.fn().mockResolvedValue(null) }));

vi.mock('../../src/lib/prisma.js', () => {
  const s = h.store;
  const prisma = {
    qboTransaction: {
      findUnique: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
        if (where.id) return s.txns.get(where.id) ?? null;
        return [...s.txns.values()].find((t) => t.idempotencyKey === where.idempotencyKey) ?? null;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => s.txns.get(where.id),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `t${s.seq++}`;
        const row = { id, ...data };
        s.txns.set(id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = { ...s.txns.get(where.id), ...data };
        s.txns.set(where.id, row);
        return row;
      },
      findMany: async () => [...s.txns.values()],
    },
    proposalVersion: {
      findUnique: async () => s.version,
      findUniqueOrThrow: async () => s.version,
    },
    priceSnapshot: { findUnique: async () => s.snapshot },
    qboConnection: { findFirst: async () => ({ realmId: 'realm-1' }) },
    integrationSyncLog: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return { prisma };
});

function seedAccepted() {
  h.store.version = {
    id: 'v1', proposalId: 'p1', version: 2, status: 'ACCEPTED', priceSnapshotId: 'ps1',
    items: [{ ref: 'l1', productId: 'prod1', name: 'Therapy Swing', quantity: 1 }],
    proposal: { organizationId: 'org1', number: 'P-2025-001' },
  };
  h.store.snapshot = {
    id: 'ps1', currency: 'USD', grandTotal: 100000n, engineVersion: '1.0.0',
    breakdown: {
      lines: [{ ref: 'l1', net: 80000 }],
      fees: { freight: { amount: 10000 } },
      orderDiscount: 0, tax: 10000,
      payment: { deposit: 30000, progress: 0, final: 70000 },
    },
  };
}

beforeEach(() => {
  h.store.seq = 1;
  h.store.txns.clear();
  h.createFn.mockReset();
  seedAccepted();
});

describe('QuickBooks duplicate prevention', () => {
  it('prepare is idempotent — same key returns the same row, no second DB row', async () => {
    const { prepareTransaction } = await import('../../src/integrations/quickbooks/transactions.js');
    const a = await prepareTransaction({ proposalVersionId: 'v1', type: 'DEPOSIT_INVOICE' }, 'user-1');
    const b = await prepareTransaction({ proposalVersionId: 'v1', type: 'DEPOSIT_INVOICE' }, 'user-1');
    expect(a.idempotencyKey).toBe('qbo:SANDBOX:DEPOSIT_INVOICE:v1:1');
    expect(b.id).toBe(a.id);
    expect(h.store.txns.size).toBe(1);
  });

  it('execute never creates a second document for an already-CREATED transaction', async () => {
    const { executeTransaction } = await import('../../src/integrations/quickbooks/transactions.js');
    h.store.txns.set('t9', { id: 't9', type: 'DEPOSIT_INVOICE', environment: 'SANDBOX', status: 'CREATED', qboId: 'INV-1', proposalVersionId: 'v1', amountMinor: 30000n, idempotencyKey: 'k', totalsSnapshot: { hash: 'x' } });
    const res = await executeTransaction('t9', 'user-1');
    expect(res.qboId).toBe('INV-1');
    expect(h.createFn).not.toHaveBeenCalled();
  });

  it('passes the idempotency key to QuickBooks as the requestid', async () => {
    const { prepareTransaction, authorizeTransaction, executeTransaction } = await import('../../src/integrations/quickbooks/transactions.js');
    h.createFn.mockResolvedValue({ Invoice: { Id: 'INV-77', SyncToken: '0', DocNumber: '1001' } });
    const t = await prepareTransaction({ proposalVersionId: 'v1', type: 'DEPOSIT_INVOICE' }, 'user-1');
    await authorizeTransaction(t.id, 'user-2');
    await executeTransaction(t.id, 'user-2');
    const [, , , requestId] = h.createFn.mock.calls[0];
    expect(requestId).toBe(t.idempotencyKey);
  });
});
