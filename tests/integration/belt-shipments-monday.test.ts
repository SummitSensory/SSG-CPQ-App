import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Printing a belt slip creates its "UEU Belt(s)" subitem on monday, and the Freight
 * Carrier / Freight Tracking ID set afterwards on the shipping record are saved on the
 * slip and written through to that subitem. The monday side itself is covered by
 * tests/unit/belt-shipment-monday.test.ts; here it is mocked, and these tests prove
 * the route wiring: what is sent, what is kept on the slip, what is refused.
 */
const h = vi.hoisted(() => ({
  settings: new Map<string, { value: string; updatedAt: Date }>(),
}));

const recordAudit = vi.fn();
vi.mock('../../src/lib/audit.js', () => ({ recordAudit }));

const syncBeltSlipToMonday = vi.fn(async (slip: { mondaySubitemId: string }) => ({
  ok: true,
  subitemId: slip.mondaySubitemId || 'sub-1',
  subitemBoardId: '6533701061',
  note: '',
}));
const carrierOptions = vi.fn(async () => ({ labels: ['UPS', 'FedEx'], live: true }));
vi.mock('../../src/integrations/monday/beltShipmentPush.js', () => ({
  syncBeltSlipToMonday,
  carrierOptions,
}));

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
        return row == null ? null : { value: row.value, updatedAt: row.updatedAt };
      },
      create: async ({ data }: { data: { key: string; value: string } }) => {
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
        // Strictly later, so back-to-back writes in one millisecond still differ.
        const next = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
        h.settings.set(where.key, { value: data.value, updatedAt: next });
        return { count: 1 };
      },
    },
    procurementLine: { findMany: async () => [] },
  },
}));

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

beforeEach(() => {
  h.settings.clear();
  vi.clearAllMocks();
});

async function auth(): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return 'Bearer ' + (await signAccessToken({ sub: 'user-SALES_REP', role: 'SALES_REP' }));
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

type SlipOut = {
  id: string;
  carrier: string;
  trackingId: string;
  mondaySubitemId: string;
  mondaySubitemBoardId: string;
};

function storedSlips(): SlipOut[] {
  const row = h.settings.get('belt.shipments');
  return row ? (JSON.parse(row.value) as { slips: SlipOut[] }).slips : [];
}

async function ship(app: FastifyInstance, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/belt-shipments/ship',
    headers: { authorization: await auth() },
    payload: {
      slip: {
        orgId: '',
        customer: 'Walk-in Customer',
        date: '2026-10-05',
        lines: [{ lineId: '', sku: 'FLEX-BELT-M', item: 'Replacement belt', qty: 1 }],
        ...extra,
      },
    },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as { slip: SlipOut };
}

describe('belt shipments — monday subitem', () => {
  it('pushes a new slip to monday with its carrier and tracking, and keeps the subitem id', async () => {
    const app = await makeApp();
    const { slip } = await ship(app, { carrier: 'UPS', trackingId: '1Z999' });
    expect(syncBeltSlipToMonday).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'Walk-in Customer',
        carrier: 'UPS',
        trackingId: '1Z999',
      }),
    );
    expect(slip.mondaySubitemId).toBe('sub-1');
    expect(storedSlips()[0]).toMatchObject({
      mondaySubitemId: 'sub-1',
      mondaySubitemBoardId: '6533701061',
    });
    await app.close();
  });

  it('saves carrier and tracking on a printed slip and writes them through', async () => {
    const app = await makeApp();
    const { slip } = await ship(app);
    syncBeltSlipToMonday.mockClear();

    const res = await app.inject({
      method: 'POST',
      url: '/belt-shipments/freight',
      headers: { authorization: await auth() },
      payload: { slipId: slip.id, carrier: 'FedEx', trackingId: 'TRK-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(syncBeltSlipToMonday).toHaveBeenCalledWith(
      expect.objectContaining({ carrier: 'FedEx', trackingId: 'TRK-1', mondaySubitemId: 'sub-1' }),
    );
    expect(storedSlips()[0]).toMatchObject({ carrier: 'FedEx', trackingId: 'TRK-1' });
    await app.close();
  });

  it('refuses a carrier that is not one of the monday column labels', async () => {
    const app = await makeApp();
    const { slip } = await ship(app);
    const res = await app.inject({
      method: 'POST',
      url: '/belt-shipments/freight',
      headers: { authorization: await auth() },
      payload: { slipId: slip.id, carrier: 'Pony Express' },
    });
    expect(res.statusCode).toBe(400);
    expect(storedSlips()[0]?.carrier).toBe('');
    await app.close();
  });

  it('serves the carrier options', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/belt-shipments/carriers',
      headers: { authorization: await auth() },
    });
    expect(JSON.parse(res.body)).toEqual({ labels: ['UPS', 'FedEx'], live: true });
    await app.close();
  });
});
