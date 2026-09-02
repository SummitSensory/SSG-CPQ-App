import { describe, it, expect, vi } from 'vitest';

/**
 * The Orders & BOM list's "Last Edit Date"/"Last Edit By" columns have to reflect
 * ANY change on the order — a task ticked off, a requirement updated — not just a
 * field on AcceptedOrder itself, which is what its own `updatedAt` would give
 * (most order-level rows are never touched again after creation). They're derived
 * from the order-event audit trail instead: the most recent OrderEvent for the
 * order, resolved to the actor's name.
 */
const ORDER = {
  id: 'o1',
  number: 'SO-1',
  organizationId: 'org1',
  proposalId: 'p1',
  proposalVersionId: 'v1',
  acceptedVersion: 1,
  priceSnapshotId: 'ps1',
  currency: 'USD',
  grandTotalMinor: 100000n,
  depositRequired: false,
  depositDueMinor: 0n,
  contentSnapshot: {},
  integrityHash: 'h',
  status: 'NEW',
  locked: true,
  jobName: null,
  bomShipTo: 'CUSTOMER',
  bomSubmittedOn: null,
  deliveryType: null,
  powderCoatBrand: null,
  shipmentQuote: null,
  bomNotes: null,
  qboEstimateTxnId: null,
  mondayProjectId: null,
  portalOrderItemId: null,
  acceptedById: 'user-1',
  acceptedAt: new Date('2026-01-01'),
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'), // never touched again — the stale value this feature works around
  manufacturingReleasedAt: null,
  manufacturingReleasedById: null,
  qboInvoiceWaivedAt: null,
  qboInvoiceWaivedById: null,
  qboInvoiceWaivedReason: null,
  customerApproval: null,
  tasks: [],
  requirements: [],
  procurement: [],
};

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    acceptedOrder: { findMany: async () => [ORDER] },
    organization: { findMany: async () => [{ id: 'org1', name: 'Acme Gym' }] },
    proposal: { findMany: async () => [{ id: 'p1', number: 'P-1', title: 'Job' }] },
    qboTransaction: { findMany: async () => [] },
    auditLog: { findMany: async () => [] },
    // Two events, given out of order — the LATER one (by createdAt) has to win,
    // not the one that happens to be last in the array.
    orderEvent: {
      findMany: async () => [
        { orderId: 'o1', actorId: 'user-1', createdAt: new Date('2026-01-05') },
        { orderId: 'o1', actorId: 'user-2', createdAt: new Date('2026-01-10') },
      ],
    },
    user: {
      findMany: async () => [
        { id: 'user-1', name: 'Rep One' },
        { id: 'user-2', name: 'Rep Two' },
      ],
    },
  },
}));

describe('listOrders — Last Edit Date / Last Edit By', () => {
  it('derives lastEditAt/lastEditBy from the most recent order event, not from AcceptedOrder.updatedAt', async () => {
    const { listOrders } = await import('../../src/handoff/service.js');
    const rows = await listOrders();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.lastEditBy).toBe('Rep Two');
    expect(row.lastEditAt).toBe(new Date('2026-01-10').toISOString());
  });

  it('is null when an order has no events at all', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/prisma.js', () => ({
      prisma: {
        acceptedOrder: { findMany: async () => [{ ...ORDER, id: 'o2' }] },
        organization: { findMany: async () => [{ id: 'org1', name: 'Acme Gym' }] },
        proposal: { findMany: async () => [{ id: 'p1', number: 'P-1', title: 'Job' }] },
        qboTransaction: { findMany: async () => [] },
        auditLog: { findMany: async () => [] },
        orderEvent: { findMany: async () => [] },
        user: { findMany: async () => [] },
      },
    }));
    const { listOrders } = await import('../../src/handoff/service.js');
    const rows = await listOrders();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.lastEditAt).toBeNull();
    expect(row.lastEditBy).toBeNull();
  });
});
