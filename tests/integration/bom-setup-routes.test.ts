import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Catalog → BOM setup and the two order-page actions that write back to it:
 * bulk vendor routing, rearranging one vendor's sheet (optionally for every future
 * order), "save this correction for future orders", and the Hardware check.
 *
 * Prisma is a plain in-memory stub, as in the repo's other route tests.
 */

type Row = Record<string, unknown>;
const SKUS = new Map<string, Row>();
const LINES = new Map<string, Row>();
const SECTIONS = new Map<string, Row>();
const PRODUCT_COSTS: Row[] = [];
const EVENTS: Row[] = [];

function reset() {
  SKUS.clear();
  LINES.clear();
  SECTIONS.clear();
  PRODUCT_COSTS.length = 0;
  EVENTS.length = 0;
  const sku = (part: string, extra: Row = {}) =>
    SKUS.set(part, {
      id: 'sku-' + part,
      part,
      description: part + ' desc',
      category: 'ACCESSORY',
      manufacturer: 'Amazon',
      unitCostMinor: 1000,
      active: true,
      freeIssueVendor: null,
      secondaryVendor: null,
      secondaryVendorCostMinor: null,
      bomSortOrder: null,
      bomGroup: null,
      bomNote: null,
      ...extra,
    });
  sku('P-1');
  sku('P-2');
  sku('6820H-LAD', { manufacturer: 'Goldberg Brothers' });
  const line = (id: string, extra: Row) =>
    LINES.set(id, {
      id,
      orderId: 'o1',
      sku: null,
      vendor: 'Goldberg Brothers',
      vendorNotes: null,
      unitCostMinor: 500,
      bomGroup: null,
      bomPosition: null,
      secondaryOfSku: null,
      ...extra,
    });
  line('l1', { sku: 'P-1' });
  line('l2', { sku: 'P-2' });
  line('l3', { sku: 'P-1', secondaryOfSku: 'P-1', unitCostMinor: 450, vendorNotes: 'Powder coat' });
  line('l4', { sku: 'X-9', vendor: 'Amazon' });
  SECTIONS.set('o1::Goldberg Brothers', { status: 'DRAFT' });
}

const inParts = (where: { part?: { in?: string[] } }) => {
  const want = new Set((where.part?.in ?? []).map((p) => p.toUpperCase()));
  return [...SKUS.values()].filter((s) => want.has(String(s.part).toUpperCase()));
};

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
    sku: {
      findMany: async ({ where }: { where?: { part?: { in?: string[] } } } = {}) =>
        where?.part ? inParts(where) : [...SKUS.values()],
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const s = [...SKUS.values()].find((x) => x.id === where.id)!;
        Object.assign(s, data);
        return { ...s };
      },
    },
    procurementLine: {
      findMany: async ({ where }: { where: { id?: { in: string[] }; orderId?: string } }) =>
        [...LINES.values()].filter(
          (l) => (!where.id || where.id.in.includes(String(l.id))) && l.orderId === where.orderId,
        ),
      findUnique: async ({ where }: { where: { id: string } }) => LINES.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        Object.assign(LINES.get(where.id)!, data);
        return LINES.get(where.id);
      },
    },
    bomVendorSection: {
      findUnique: async ({
        where,
      }: {
        where: { orderId_vendor: { orderId: string; vendor: string } };
      }) => SECTIONS.get(where.orderId_vendor.orderId + '::' + where.orderId_vendor.vendor) ?? null,
    },
    manufacturer: {
      findMany: async () => [
        { id: 'm1', name: 'Goldberg Brothers' },
        { id: 'm2', name: 'Amazon' },
      ],
    },
    hardwareRule: { findMany: async () => [] },
    product: { findUnique: async () => ({ id: 'prod-P-1' }) },
    productCost: {
      create: async ({ data }: { data: Row }) => {
        PRODUCT_COSTS.push(data);
        return data;
      },
    },
    orderEvent: {
      create: async ({ data }: { data: Row }) => {
        EVENTS.push(data);
        return data;
      },
    },
    entityRevision: { create: async () => ({}) },
    auditLog: { create: async () => ({}) },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});
beforeEach(reset);

async function auth(role: string) {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return { authorization: 'Bearer ' + (await signAccessToken({ sub: 'user-' + role, role })) };
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerBomSetupRoutes } = await import('../../src/routes/bomSetup.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerBomSetupRoutes(app);
  await app.ready();
  return app;
}

describe('PATCH /bom-setup/parts — bulk routing', () => {
  it('routes several parts through a second vendor at a set charge, in one call', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-setup/parts',
      headers: await auth('OPERATIONS'),
      payload: {
        parts: ['P-1', 'p-2', 'NOPE'],
        set: { secondaryVendor: 'goldberg brothers', secondaryVendorCostMinor: 0 },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(2);
    expect(res.json().skipped).toEqual([{ part: 'NOPE', reason: 'Not in the SKU master' }]);
    // Stored with the vendor's own spelling, not as typed.
    expect(SKUS.get('P-2')).toMatchObject({
      secondaryVendor: 'Goldberg Brothers',
      secondaryVendorCostMinor: 0,
    });
    await app.close();
  });

  it('skips a part routed to the vendor it is already bought from', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-setup/parts',
      headers: await auth('OPERATIONS'),
      payload: { parts: ['6820H-LAD', 'P-1'], set: { freeIssueVendor: 'Goldberg Brothers' } },
    });
    expect(res.json().updated).toBe(1);
    expect(res.json().skipped[0].part).toBe('6820H-LAD');
    await app.close();
  });

  it('refuses a vendor that is not on record', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-setup/parts',
      headers: await auth('OPERATIONS'),
      payload: { parts: ['P-1'], set: { freeIssueVendor: 'Goldberg Bros' } },
    });
    expect(res.statusCode).toBe(400);
    expect(SKUS.get('P-1')!.freeIssueVendor).toBeNull();
    await app.close();
  });

  it('is closed to roles without BOM permission', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-setup/parts',
      headers: await auth('SALES_REP'),
      payload: { parts: ['P-1'], set: { bomGroup: '' } },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('POST /orders/:id/bom/arrange', () => {
  it('positions the lines for this order and, when asked, for every future order', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/orders/o1/bom/arrange',
      headers: await auth('PROJECT_MANAGER'),
      payload: {
        vendor: 'Goldberg Brothers',
        lineIds: ['l2', 'l1', 'l3'],
        headings: { l2: 'Crating' },
        saveForFuture: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(LINES.get('l2')).toMatchObject({ bomPosition: 10, bomGroup: 'Crating' });
    expect(LINES.get('l1')).toMatchObject({ bomPosition: 20, bomGroup: null });
    // The first time a part appears sets its preset; P-1's second (l3) line does not.
    expect(SKUS.get('P-2')).toMatchObject({ bomSortOrder: 10, bomGroup: 'Crating' });
    expect(SKUS.get('P-1')).toMatchObject({ bomSortOrder: 20, bomGroup: null });
    expect(res.json().catalogUpdated).toBe(2);
    await app.close();
  });

  it('leaves the catalog alone for "this order only"', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/orders/o1/bom/arrange',
      headers: await auth('OPERATIONS'),
      payload: { vendor: 'Goldberg Brothers', lineIds: ['l2', 'l1'], saveForFuture: false },
    });
    expect(LINES.get('l2')!.bomPosition).toBe(10);
    expect(SKUS.get('P-2')!.bomSortOrder).toBeNull();
    await app.close();
  });

  it('refuses a submitted sheet and a line from another vendor', async () => {
    const app = await makeApp();
    const foreign = await app.inject({
      method: 'POST',
      url: '/orders/o1/bom/arrange',
      headers: await auth('OPERATIONS'),
      payload: { vendor: 'Goldberg Brothers', lineIds: ['l1', 'l4'] },
    });
    expect(foreign.statusCode).toBe(400);
    SECTIONS.set('o1::Goldberg Brothers', { status: 'SUBMITTED' });
    const locked = await app.inject({
      method: 'POST',
      url: '/orders/o1/bom/arrange',
      headers: await auth('OPERATIONS'),
      payload: { vendor: 'Goldberg Brothers', lineIds: ['l1'] },
    });
    expect(locked.statusCode).toBe(400);
    expect(LINES.get('l1')!.bomPosition).toBeNull();
    await app.close();
  });
});

describe('POST /orders/procurement/:lineId/save-default', () => {
  it('saves a line’s note as the part’s standing BOM note', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/orders/procurement/l3/save-default',
      headers: await auth('OPERATIONS'),
      payload: { fields: ['vendorNotes'] },
    });
    expect(res.statusCode).toBe(200);
    expect(SKUS.get('P-1')!.bomNote).toBe('Powder coat');
    await app.close();
  });

  it('saves a second-vendor line’s cost as that vendor’s charge, open to BOM users', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/orders/procurement/l3/save-default',
      headers: await auth('OPERATIONS'),
      payload: { fields: ['unitCost'] },
    });
    expect(res.statusCode).toBe(200);
    expect(SKUS.get('P-1')).toMatchObject({ secondaryVendorCostMinor: 450, unitCostMinor: 1000 });
    await app.close();
  });

  it('keeps the part’s own catalog cost to catalog admins, and writes the cost history', async () => {
    const app = await makeApp();
    const denied = await app.inject({
      method: 'POST',
      url: '/orders/procurement/l1/save-default',
      headers: await auth('OPERATIONS'),
      payload: { fields: ['unitCost'] },
    });
    expect(denied.statusCode).toBe(403);
    expect(SKUS.get('P-1')!.unitCostMinor).toBe(1000);

    const ok = await app.inject({
      method: 'POST',
      url: '/orders/procurement/l1/save-default',
      headers: await auth('SYSTEM_ADMIN'),
      payload: { fields: ['unitCost'] },
    });
    expect(ok.statusCode).toBe(200);
    expect(SKUS.get('P-1')!.unitCostMinor).toBe(500);
    expect(PRODUCT_COSTS[0]).toMatchObject({ productId: 'prod-P-1', unitCost: 500n });
    await app.close();
  });
});

describe('GET /bom-setup/hardware-check', () => {
  it('lists the H-1000 kit parts with their reason, and honours a part moved out', async () => {
    SKUS.get('6820H-LAD')!.bomGroup = '';
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/bom-setup/hardware-check',
      headers: await auth('SALES_REP'),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Array<Record<string, unknown>>;
    const handles = rows.find((r) => r.part === '6820H-LAD')!;
    expect(handles.reasons).toContain('In the H-1000 hardware kit formula');
    expect(handles).toMatchObject({ catalogHeading: '', printsUnderHardware: false });
    expect(rows.find((r) => r.part === '6820H-LA')).toMatchObject({ printsUnderHardware: true });
    await app.close();
  });
});
