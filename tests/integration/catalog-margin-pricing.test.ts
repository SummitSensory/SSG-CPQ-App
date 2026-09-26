import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * "Enter the product cost and a margin percentage and have the software calculate the
 * sales price." PATCH and POST /catalog/items take `marginPercent` (gross margin) and
 * set unitPriceMinor = cost / (1 − margin), in whole cents, on the server.
 *
 * Prisma is an in-memory stub, following catalog-items-create.test.ts.
 */
const h = vi.hoisted(() => ({
  sku: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
    product: { findUnique: async () => null },
    sku: {
      findUnique: async () => h.sku,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        h.updates.push(data);
        h.sku = { ...(h.sku ?? {}), ...data };
        return h.sku;
      },
    },
    productCategory: { findFirst: async () => ({ id: 'cat-1' }) },
    manufacturer: { findFirst: async () => null, findMany: async () => [] },
    productCost: { create: async () => ({}) },
    auditLog: { create: async () => ({}) },
    entityRevision: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        product: {
          create: async ({ data }: { data: Record<string, unknown> }) => ({
            id: 'product-1',
            ...data,
          }),
        },
        sku: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            h.created.push(data);
            return { id: 'sku-1', ...data };
          },
        },
        productSourcing: { create: async () => ({}) },
        productVersion: { create: async () => ({}) },
      }),
  },
}));

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

beforeEach(() => {
  h.sku = { id: 'sku-1', part: 'A-1', unitCostMinor: 6000, unitPriceMinor: 9000 };
  h.updates = [];
  h.created = [];
});

async function admin(): Promise<Record<string, string>> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return {
    authorization:
      'Bearer ' + (await signAccessToken({ sub: 'user-SYSTEM_ADMIN', role: 'SYSTEM_ADMIN' })),
  };
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerCatalogItemRoutes } = await import('../../src/routes/catalogItems.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerCatalogItemRoutes(app);
  await app.ready();
  return app;
}

const patch = async (app: FastifyInstance, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: '/catalog/items/A-1', headers: await admin(), payload });

describe('PATCH /catalog/items/:part — marginPercent', () => {
  it('prices from the cost on record: $60.00 at 40% margin is $100.00', async () => {
    const app = await makeApp();
    const res = await patch(app, { marginPercent: 40 });
    expect(res.statusCode).toBe(200);
    expect(h.updates).toEqual([{ unitPriceMinor: 10000 }]);
    expect(res.json()).toMatchObject({ unitPriceMinor: 10000, unitCostMinor: 6000 });
    await app.close();
  });

  it('uses a cost sent in the same request', async () => {
    const app = await makeApp();
    await patch(app, { unitCostMinor: 1234, marginPercent: 35 });
    // 1234 / 0.65 = 1898.46… → 1898 cents
    expect(h.updates).toEqual([{ unitPriceMinor: 1898, unitCostMinor: 1234 }]);
    await app.close();
  });

  it('refuses a margin with no cost to work from', async () => {
    h.sku = { id: 'sku-1', part: 'A-1', unitCostMinor: 0, unitPriceMinor: 0 };
    const app = await makeApp();
    const res = await patch(app, { marginPercent: 40 });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/unit cost first/i);
    expect(h.updates).toEqual([]);
    await app.close();
  });

  it.each([[100], [150], [-5]])('refuses a margin of %s%%', async (m) => {
    const app = await makeApp();
    const res = await patch(app, { marginPercent: m });
    expect(res.statusCode).toBe(400);
    expect(h.updates).toEqual([]);
    await app.close();
  });

  it('refuses a price and a margin together', async () => {
    const app = await makeApp();
    const res = await patch(app, { unitPriceMinor: 5000, marginPercent: 40 });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/price or a margin/i);
    await app.close();
  });

  it('leaves the price alone when only the cost changes', async () => {
    const app = await makeApp();
    await patch(app, { unitCostMinor: 7000 });
    expect(h.updates).toEqual([{ unitCostMinor: 7000 }]);
    await app.close();
  });
});

describe('POST /catalog/items — marginPercent', () => {
  it('creates the part at the price the margin gives', async () => {
    const app = await makeApp();
    h.sku = null;
    const res = await app.inject({
      method: 'POST',
      url: '/catalog/items',
      headers: await admin(),
      payload: {
        part: 'NEW-1',
        name: 'New part',
        category: 'Frames',
        proposalGroup: 'Frames & Structures',
        unitCostMinor: 6000,
        marginPercent: 40,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(h.created[0]).toMatchObject({ unitCostMinor: 6000, unitPriceMinor: 10000 });
    await app.close();
  });
});
