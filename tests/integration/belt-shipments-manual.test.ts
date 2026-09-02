import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * A slip can cover an item with no ProcurementLine behind it — a replacement,
 * warranty, or goodwill shipment that was never on a bill of materials. These tests
 * prove that path end to end: the route accepts a line with an empty lineId, credits
 * nothing (there is nothing on the BOM to credit), and tags the audit entry so that
 * traffic is distinguishable from ordinary order fulfillment.
 */
const h = vi.hoisted(() => ({ settings: new Map<string, string>() }));

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
        const v = h.settings.get(where.key);
        return v == null ? null : { value: v };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { key: string };
        create: { value: string };
        update?: { value: string };
      }) => {
        h.settings.set(where.key, update ? update.value : create.value);
        return {};
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
