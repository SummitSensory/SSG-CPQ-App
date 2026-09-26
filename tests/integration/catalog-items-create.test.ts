import { describe, it, expect, beforeAll, vi } from 'vitest';
/**
 * Bryan's rule: every new product must decide where it defaults to on a proposal —
 * `Sku.proposalGroup` (the proposal heading; NOT `Product.categoryId`, the catalog
 * tree position, and NOT `Sku.category`, the FRAME/TROLLEY/ACCESSORY part type — see
 * the data-model notes in CLAUDE.md). Enforced on `POST /catalog/items` (create) only;
 * `PATCH /catalog/items/:part` keeps it optional so a part created before this rule
 * stays readable and editable.
 *
 * Mounted without a real database, following the same pattern as
 * `catalog-authz.test.ts`: `../../src/lib/prisma.js` is replaced with an in-memory
 * stub so the route's Zod validation and transaction wiring run for real while no
 * Postgres connection is required.
 */
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
    product: { findUnique: async () => null },
    sku: { findUnique: async () => null },
    productCategory: { findFirst: async () => ({ id: 'cat-1' }) },
    manufacturer: { findFirst: async () => null, findMany: async () => [] },
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
          create: async ({ data }: { data: Record<string, unknown> }) => ({
            id: 'sku-1',
            ...data,
          }),
        },
        productSourcing: { create: async () => ({}) },
        productVersion: { create: async () => ({}) },
      }),
  },
}));

import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

async function tokenFor(role: string): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub: 'user-' + role, role });
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

describe('POST /catalog/items — proposal group required on create', () => {
  it('rejects a new part with no proposalGroup, naming the field', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/catalog/items',
      headers: { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) },
      payload: { part: 'TEST-NO-GROUP', name: 'Test part', category: 'Frames' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { message: string };
    expect(body.message).toMatch(/proposal group/i);
    await app.close();
  });

  it('rejects a new part whose proposalGroup is blank/whitespace-only', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/catalog/items',
      headers: { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) },
      payload: {
        part: 'TEST-BLANK-GROUP',
        name: 'Test part',
        category: 'Frames',
        proposalGroup: '   ',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { message: string };
    expect(body.message).toMatch(/proposal group/i);
    await app.close();
  });

  it('creates the part when proposalGroup is set', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/catalog/items',
      headers: { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) },
      payload: {
        part: 'TEST-WITH-GROUP',
        name: 'Test part',
        category: 'Frames',
        proposalGroup: 'Frames & Structures',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { part: string; skuId: string };
    expect(body.part).toBe('TEST-WITH-GROUP');
    await app.close();
  });
});
