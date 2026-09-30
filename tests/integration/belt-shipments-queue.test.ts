import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * Belt shipments: clearing belts from the queue without a slip (and restoring them),
 * and the customer email / phone that print below the address — read from the order's
 * monday deal (email_1__1 / phone__1), with the CRM contact as the fallback.
 */
const h = vi.hoisted(() => ({
  settings: new Map<string, { value: string; updatedAt: Date }>(),
  /** monday deal item id -> the deal's email/phone columns. */
  deals: new Map<string, { email: string; phone: string }>(),
  dealReads: [] as string[][],
}));

const recordAudit = vi.fn();
vi.mock('../../src/lib/audit.js', () => ({ recordAudit }));

vi.mock('../../src/integrations/monday/dealContacts.js', () => ({
  readDealContacts: async (ids: string[]) => {
    h.dealReads.push(ids);
    return new Map(
      ids.flatMap((id) => {
        const d = h.deals.get(id);
        return d ? [[id, d] as const] : [];
      }),
    );
  },
}));

/** Two belt lines: one on an order whose proposal names its deal, one on an order with none. */
const LINES = [
  {
    id: 'line-a',
    sku: 'FLEX-BELT-M',
    name: 'Flex belt, medium',
    quantity: 3,
    order: {
      id: 'ord-a',
      number: 'SO-2026-000010',
      organizationId: 'org-a',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      proposalId: 'prop-a',
      mondayProjectId: null,
      contentSnapshot: {
        sections: [{ id: 'meta', data: { contactName: 'Pat Lee', projectId: '9001' } }],
      },
    },
  },
  {
    id: 'line-b',
    sku: 'FLEX-BELT-L',
    name: 'Flex belt, large',
    quantity: 1,
    order: {
      id: 'ord-b',
      number: 'SO-2026-000011',
      organizationId: 'org-b',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      proposalId: 'prop-b',
      mondayProjectId: null,
      contentSnapshot: { sections: [{ id: 'meta', data: { contactName: 'Sam Roe' } }] },
    },
  },
];

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
        // Strictly later, so two writes inside one millisecond still differ.
        h.settings.set(where.key, {
          value: data.value,
          updatedAt: new Date(row.updatedAt.getTime() + 1),
        });
        return { count: 1 };
      },
    },
    procurementLine: {
      findMany: async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id ? LINES.filter((l) => where.id!.in.includes(l.id)) : LINES,
    },
    proposal: {
      findMany: async () => [
        { id: 'prop-a', number: 'P-2026-000100' },
        { id: 'prop-b', number: 'P-2026-000101' },
      ],
    },
    organization: {
      findMany: async () => [
        {
          id: 'org-a',
          name: 'Alpha Therapy',
          addresses: [],
          contacts: [
            {
              firstName: 'Pat',
              lastName: 'Lee',
              title: null,
              email: 'crm-pat@alpha.test',
              phone: '(111) 222-3333',
            },
          ],
        },
        {
          id: 'org-b',
          name: 'Beta Clinic',
          addresses: [],
          contacts: [
            { firstName: 'Other', lastName: 'Person', title: null, email: null, phone: null },
            {
              firstName: 'Sam',
              lastName: 'Roe',
              title: null,
              email: 'sam@beta.test',
              phone: '1 (303) 555 0199',
            },
          ],
        },
      ],
    },
    opportunity: { findMany: async () => [] },
  },
}));

import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

beforeEach(() => {
  h.settings.clear();
  h.deals.clear();
  h.dealReads.length = 0;
  recordAudit.mockClear();
});

async function auth(): Promise<{ authorization: string }> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  const token = await signAccessToken({ sub: 'user-SALES_REP', role: 'SALES_REP' });
  return { authorization: 'Bearer ' + token };
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

type Owed = { lineId: string; remaining: number; email: string; phone: string };
type Listing = {
  owed: Owed[];
  cleared: Array<{ lineId: string; qty: number; reason: string; clearedBy: string }>;
};

async function list(app: FastifyInstance): Promise<Listing> {
  const res = await app.inject({ method: 'GET', url: '/belt-shipments', headers: await auth() });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as Listing;
}

describe('belt shipments — customer email and phone', () => {
  it("reads them off the order's monday deal and formats the phone xxx-xxx-xxxx", async () => {
    h.deals.set('9001', { email: 'pat@alpha.test', phone: '+1 720 555 0142' });
    const app = await makeApp();
    const { owed } = await list(app);
    // The deal comes from the Project ID on the accepted proposal.
    expect(h.dealReads[0]).toContain('9001');
    const a = owed.find((o) => o.lineId === 'line-a')!;
    expect(a.email).toBe('pat@alpha.test');
    expect(a.phone).toBe('720-555-0142');
    await app.close();
  });

  it("falls back to the proposal's CRM contact when the deal has none", async () => {
    const app = await makeApp();
    const { owed } = await list(app);
    const b = owed.find((o) => o.lineId === 'line-b')!;
    expect(b.email).toBe('sam@beta.test');
    expect(b.phone).toBe('303-555-0199');
    await app.close();
  });

  it('keeps them on the recorded slip', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/belt-shipments/ship',
      headers: await auth(),
      payload: {
        slip: {
          orgId: 'org-a',
          customer: 'Alpha Therapy',
          date: '2026-09-30',
          address: '1 Main St',
          email: 'pat@alpha.test',
          phone: '720-555-0142',
          lines: [{ lineId: 'line-a', sku: 'FLEX-BELT-M', item: 'Flex belt, medium', qty: 1 }],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const { slip } = JSON.parse(res.body) as { slip: { email: string; phone: string } };
    expect(slip).toMatchObject({ email: 'pat@alpha.test', phone: '720-555-0142' });
    await app.close();
  });
});

describe('belt shipments — clearing the queue', () => {
  it('takes the remaining pieces off the list, records who and why, and restores', async () => {
    const app = await makeApp();
    const headers = await auth();

    const cleared = await app.inject({
      method: 'POST',
      url: '/belt-shipments/clear',
      headers,
      payload: { lineIds: ['line-a'], reason: 'Shipped with the frame' },
    });
    expect(cleared.statusCode).toBe(200);
    expect(JSON.parse(cleared.body)).toEqual({ cleared: [{ lineId: 'line-a', qty: 3 }] });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'belt.shipment.clear' }),
    );

    let now = await list(app);
    expect(now.owed.map((o) => o.lineId)).toEqual(['line-b']);
    expect(now.cleared).toEqual([
      expect.objectContaining({
        lineId: 'line-a',
        qty: 3,
        reason: 'Shipped with the frame',
        clearedBy: 'Test User',
      }),
    ]);

    const restored = await app.inject({
      method: 'POST',
      url: '/belt-shipments/restore',
      headers,
      payload: { lineId: 'line-a' },
    });
    expect(restored.statusCode).toBe(200);
    now = await list(app);
    expect(now.owed.find((o) => o.lineId === 'line-a')?.remaining).toBe(3);
    expect(now.cleared).toEqual([]);
    await app.close();
  });

  it('clears only what is still owed after a partial shipment, and refuses to ship it', async () => {
    const app = await makeApp();
    const headers = await auth();
    const shipOne = (qty: number) =>
      app.inject({
        method: 'POST',
        url: '/belt-shipments/ship',
        headers,
        payload: {
          slip: {
            orgId: 'org-a',
            customer: 'Alpha Therapy',
            date: '2026-09-30',
            lines: [{ lineId: 'line-a', sku: 'FLEX-BELT-M', item: 'Flex belt, medium', qty }],
          },
        },
      });
    expect((await shipOne(1)).statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: '/belt-shipments/clear',
      headers,
      payload: { lineIds: ['line-a'] },
    });
    expect(JSON.parse(res.body)).toEqual({ cleared: [{ lineId: 'line-a', qty: 2 }] });

    // Nothing is left to ship on that line: a later slip credits nothing past the cap.
    expect((await shipOne(2)).statusCode).toBe(200);
    const ledger = JSON.parse(h.settings.get('belt.shipments')!.value) as {
      shipped: Record<string, number>;
    };
    expect(ledger.shipped['line-a']).toBe(1);

    const again = await app.inject({
      method: 'POST',
      url: '/belt-shipments/clear',
      headers,
      payload: { lineIds: ['line-a'] },
    });
    expect(again.statusCode).toBe(400);
    await app.close();
  });

  it('refuses a line that is not a belt on a bill of materials', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/belt-shipments/clear',
      headers: await auth(),
      payload: { lineIds: ['not-a-belt'] },
    });
    expect(res.statusCode).toBe(400);
    expect(h.settings.size).toBe(0);
    await app.close();
  });
});
