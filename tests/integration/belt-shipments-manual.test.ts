import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * A slip can cover an item with no ProcurementLine behind it — a replacement,
 * warranty, or goodwill shipment that was never on a bill of materials. These tests
 * prove that path end to end: the route accepts a line with an empty lineId, credits
 * nothing (there is nothing on the BOM to credit), and tags the audit entry so that
 * traffic is distinguishable from ordinary order fulfillment.
 */
const h = vi.hoisted(() => ({
  settings: new Map<string, { value: string; updatedAt: Date }>(),
  /** Runs at the awaited seam between reading the ledger row and claiming it. */
  duringRead: null as null | (() => void),
}));

const recordAudit = vi.fn();
vi.mock('../../src/lib/audit.js', () => ({ recordAudit }));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
        name: 'Test User',
        email: 'test@example.com',
      }),
    },
    uiSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const row = h.settings.get(where.key);
        const snapshot = row == null ? null : { value: row.value, updatedAt: row.updatedAt };
        // The seam. In the real code, everything between this read and the write
        // below is an awaited round trip; here it is where a concurrent request's
        // write lands, which is the case under test.
        if (h.duringRead) h.duringRead();
        return snapshot;
      },
      // ship/void claim the row on the updatedAt they read (see writeLedger in
      // beltShipments.ts) — a real Postgres UiSetting row's updatedAt is
      // auto-managed (@updatedAt), so this mock advances it on every write too.
      create: async ({ data }: { data: { key: string; value: string } }) => {
        if (h.settings.has(data.key)) {
          const err = new Error('Unique constraint failed') as Error & { code: string };
          err.code = 'P2002';
          throw err;
        }
        const updatedAt = new Date();
        h.settings.set(data.key, { value: data.value, updatedAt });
        return { key: data.key, value: data.value, updatedAt };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { key: string; updatedAt: Date };
        data: { value: string };
      }) => {
        const row = h.settings.get(where.key);
        if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
        h.settings.set(where.key, { value: data.value, updatedAt: new Date() });
        return { count: 1 };
      },
    },
    procurementLine: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.includes('line-1') ? [{ id: 'line-1', quantity: 5 }] : [],
    },
  },
}));

import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

async function tokenFor(role: string, sub = 'user-' + role): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub, role });
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerBeltShipmentRoutes } = await import('../../src/routes/beltShipments.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerBeltShipmentRoutes(app);
  await app.ready();
  return app;
}

describe('belt shipments — an item with no order behind it', () => {
  it('records the slip, credits no procurement line, and tags the audit entry manual', async () => {
    h.settings.clear();
    recordAudit.mockClear();
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/belt-shipments/ship',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
      payload: {
        slip: {
          orgId: '',
          customer: 'Walk-in Customer',
          proposalNumber: '',
          attention: 'Jane Doe',
          date: '2026-09-01',
          address: '123 Main St',
          note: '',
          lines: [{ lineId: '', sku: 'FLEX-BELT-M', item: 'Replacement belt (medium)', qty: 1 }],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { slip: { customer: string; number: string } };
    expect(body.slip.customer).toBe('Walk-in Customer');
    expect(body.slip.number).toMatch(/^PS-/);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'belt.shipment.ship.manual' }),
    );
    await app.close();
  });

  it('tags a slip that credits a real procurement line as ordinary, not manual', async () => {
    h.settings.clear();
    recordAudit.mockClear();
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/belt-shipments/ship',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
      payload: {
        slip: {
          orgId: '',
          customer: 'A Real Order',
          proposalNumber: '',
          attention: '',
          date: '2026-09-01',
          address: '',
          note: '',
          lines: [{ lineId: 'line-1', sku: 'FLEX-BELT-M', item: 'Belt', qty: 1 }],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'belt.shipment.ship' }),
    );
    await app.close();
  });

  it('refuses a ship whose read is stale, rather than silently discarding a concurrent one', async () => {
    // The bug this guards: both requests used to read the same base ledger, compute
    // their own slip in memory, and blind-upsert the whole document back —
    // whichever wrote second erased the first slip from history and reverted its
    // quantity credit. Made deterministic by landing a second, concurrent ship in
    // the awaited gap between this request's read and its own write (the mock's
    // `duringRead` seam) — the genuine ordering, not an invented one.
    h.settings.clear();
    recordAudit.mockClear();
    const app = await makeApp();
    const shipPayload = (customer: string) => ({
      slip: {
        orgId: '',
        customer,
        proposalNumber: '',
        attention: '',
        date: '2026-09-01',
        address: '',
        note: '',
        lines: [{ lineId: '', sku: 'FLEX-BELT-M', item: 'Replacement belt', qty: 1 }],
      },
    });

    h.duringRead = () => {
      h.duringRead = null; // only once — the concurrent request's own read must not recurse
      h.settings.set('belt.shipments', {
        value: JSON.stringify({
          shipped: {},
          slips: [{ customer: 'Concurrent Customer' }],
          seq: 1,
        }),
        updatedAt: new Date(),
      });
    };

    const res = await app.inject({
      method: 'POST',
      url: '/belt-shipments/ship',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
      payload: shipPayload('Stale Reader'),
    });

    expect(res.statusCode).toBe(409);
    // The concurrent write survives untouched — the stale request's slip was never
    // written, not even partially.
    const final = JSON.parse(h.settings.get('belt.shipments')!.value) as {
      slips: Array<{ customer: string }>;
    };
    expect(final.slips).toEqual([{ customer: 'Concurrent Customer' }]);
    await app.close();
  });

  it('rejects a slip with no items', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/belt-shipments/ship',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
      payload: {
        slip: {
          orgId: '',
          customer: 'Nobody',
          proposalNumber: '',
          attention: '',
          date: '2026-09-01',
          address: '',
          note: '',
          lines: [],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
