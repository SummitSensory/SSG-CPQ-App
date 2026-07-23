import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Failure-recovery: a create that fails must leave a retryable record and must
 * never leave a half-committed transaction. Verifies (a) a failed execute marks
 * the row FAILED with the error, (b) manual retry re-runs with the SAME
 * idempotency key and succeeds, and (c) authorization/production/drift guards
 * block execution before any QuickBooks call.
 */
const h = vi.hoisted(() => ({
  store: {
    seq: 1,
    txns: new Map<string, Record<string, unknown>>(),
    version: null as Record<string, unknown> | null,
    snapshot: null as Record<string, unknown> | null,
  },
  createFn: vi.fn(),
  prodWrites: { value: false },
  environment: { value: 'SANDBOX' as 'SANDBOX' | 'PRODUCTION' },
}));

vi.mock('../../src/config/env.js', () => ({
  get env() { return { QBO_ENVIRONMENT: h.environment.value === 'PRODUCTION' ? 'production' : 'sandbox', QBO_PRODUCTION_WRITE_ENABLED: h.prodWrites.value }; },
  qboEnvironment: () => h.environment.value,
}));
vi.mock('../../src/lib/audit.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../../src/integrations/quickbooks/client.js', () => ({ create: h.createFn }));
vi.mock('../../src/integrations/quickbooks/customers.js', () => ({ findOrCreateCustomer: vi.fn().mockResolvedValue({ qboId: 'C-1', created: false }) }));
vi.mock('../../src/integrations/quickbooks/links.js', () => ({ findLink: vi.fn().mockResolvedValue(null) }));

vi.mock('../../src/lib/prisma.js', () => {
  const s = h.store;
  const prisma = {
    qboTransaction: {
      findUnique: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        where.id ? s.txns.get(where.id) ?? null : [...s.txns.values()].find((t) => t.idempotencyKey === where.idempotencyKey) ?? null,
      findUniqueOrThrow: async () => s.version,
      create: async ({ data }: { data: Record<string, unknown> }) => { const id = `t${s.seq++}`; const row = { id, ...data }; s.txns.set(id, row); return row; },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const row = { ...s.txns.get(where.id), ...data }; s.txns.set(where.id, row); return row; },
      findMany: async () => [...s.txns.values()],
    },
    proposalVersion: { findUnique: async () => s.version, findUniqueOrThrow: async () => s.version },
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
    breakdown: { lines: [{ ref: 'l1', net: 80000 }], fees: { freight: { amount: 10000 } }, orderDiscount: 0, tax: 10000, payment: { deposit: 30000, progress: 0, final: 70000 } },
  };
}

async function prepared(type = 'DEPOSIT_INVOICE') {
  const { prepareTransaction, authorizeTransaction } = await import('../../src/integrations/quickbooks/transactions.js');
  const t = await prepareTransaction({ proposalVersionId: 'v1', type: type as never }, 'user-1');
  await authorizeTransaction(t.id, 'user-2');
  return t;
}

beforeEach(() => {
  h.store.seq = 1; h.store.txns.clear();
  h.createFn.mockReset();
  h.prodWrites.value = false; h.environment.value = 'SANDBOX';
  seedAccepted();
});

describe('QuickBooks failure recovery', () => {
  it('marks a transaction FAILED (with the error) when the create call fails', async () => {
    const { executeTransaction } = await import('../../src/integrations/quickbooks/transactions.js');
    const t = await prepared();
    h.createFn.mockRejectedValueOnce(new Error('QuickBooks HTTP 503'));
    await expect(executeTransaction(t.id, 'user-2')).rejects.toThrow();
    const row = h.store.txns.get(t.id)!;
    expect(row.status).toBe('FAILED');
    expect(String(row.error)).toContain('503');
  });

  it('retry re-runs with the same idempotency key and succeeds', async () => {
    const { executeTransaction, retryTransaction } = await import('../../src/integrations/quickbooks/transactions.js');
    const t = await prepared();
    h.createFn.mockRejectedValueOnce(new Error('network timeout'));
    await expect(executeTransaction(t.id, 'user-2')).rejects.toThrow();

    h.createFn.mockResolvedValueOnce({ Invoice: { Id: 'INV-88', SyncToken: '0', DocNumber: '1002' } });
    const recovered = await retryTransaction(t.id, 'user-2');
    expect(recovered.status).toBe('CREATED');
    expect(recovered.qboId).toBe('INV-88');
    // both attempts used the identical requestid
    expect(h.createFn.mock.calls[0][3]).toBe(h.createFn.mock.calls[1][3]);
  });

  it('refuses to execute a transaction that was never authorized', async () => {
    const { prepareTransaction, executeTransaction } = await import('../../src/integrations/quickbooks/transactions.js');
    const t = await prepareTransaction({ proposalVersionId: 'v1', type: 'DEPOSIT_INVOICE' }, 'user-1');
    await expect(executeTransaction(t.id, 'user-2')).rejects.toThrow(/AUTHORIZED/);
    expect(h.createFn).not.toHaveBeenCalled();
  });

  it('blocks production writes until explicitly enabled', async () => {
    h.environment.value = 'PRODUCTION';
    const t = await prepared();
    const { executeTransaction } = await import('../../src/integrations/quickbooks/transactions.js');
    await expect(executeTransaction(t.id, 'user-2')).rejects.toThrow(/[Pp]roduction/);
    expect(h.createFn).not.toHaveBeenCalled();
  });

  it('refuses to create when accepted totals changed after prepare', async () => {
    const { executeTransaction } = await import('../../src/integrations/quickbooks/transactions.js');
    const t = await prepared();
    // Someone alters the underlying snapshot after prepare froze the totals.
    (h.store.snapshot as Record<string, unknown>).grandTotal = 120000n;
    await expect(executeTransaction(t.id, 'user-2')).rejects.toThrow(/changed/);
    expect(h.createFn).not.toHaveBeenCalled();
  });
});
