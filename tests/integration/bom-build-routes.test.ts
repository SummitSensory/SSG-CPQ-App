import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Permission gating and round-trip for the new "secondary vendor" fields on
 * PATCH /bom-build/settings/:part (see src/handoff/bomBuild.ts for what the rule
 * does to an order). PRODUCTS_ADMIN is granted to no role but SYSTEM_ADMIN — see
 * src/authz/permissions.ts — so SALES_REP (which has CATALOG_READ via BASE) must be
 * able to read but never write. Prisma is a plain stub, not a mock library, matching
 * this repo's existing integration-test convention.
 */

const SKUS = new Map<string, Record<string, unknown>>([
  [
    'ABC',
    {
      part: 'ABC',
      description: 'Product A',
      keepParentOnBom: false,
      freeIssueVendor: null,
      secondaryVendor: null,
      secondaryVendorCostMinor: null,
    },
  ],
]);
const MANUFACTURERS = new Set(['Goldberg Brothers', 'Amazon']);

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
    sku: {
      findUnique: async ({ where }: { where: { part: string } }) => SKUS.get(where.part) ?? null,
      findMany: async () =>
        [...SKUS.values()].filter(
          (s) => s.secondaryVendor || s.freeIssueVendor || s.keepParentOnBom,
        ),
      update: async ({
        where,
        data,
      }: {
        where: { part: string };
        data: Record<string, unknown>;
      }) => {
        const current = SKUS.get(where.part)!;
        const next = { ...current, ...data };
        SKUS.set(where.part, next);
        return next;
      },
    },
    skuComponent: { findMany: async () => [] },
    manufacturer: {
      findFirst: async ({ where }: { where: { name: string } }) =>
        MANUFACTURERS.has(where.name) ? { id: 'm-' + where.name, name: where.name } : null,
    },
    auditLog: { create: async () => ({}) },
  },
}));

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
  const { registerBomBuildRoutes } = await import('../../src/routes/bomBuild.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerBomBuildRoutes(app);
  await app.ready();
  return app;
}

describe('PATCH /bom-build/settings/:part — permissions', () => {
  it('rejects a non-admin (SALES_REP) with 403', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-build/settings/ABC',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
      payload: { secondaryVendor: 'Goldberg Brothers' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects an unauthenticated request with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-build/settings/ABC',
      payload: { secondaryVendor: 'Goldberg Brothers' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('lets SALES_REP (CATALOG_READ) read GET /bom-build', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/bom-build',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('PATCH /bom-build/settings/:part — secondary vendor round-trip', () => {
  it('saves and returns secondaryVendor and secondaryVendorCostMinor', async () => {
    const app = await makeApp();
    const admin = { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) };
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-build/settings/ABC',
      headers: admin,
      payload: { secondaryVendor: 'Goldberg Brothers', secondaryVendorCostMinor: 750 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      secondaryVendor: 'Goldberg Brothers',
      secondaryVendorCostMinor: 750,
    });
    await app.close();
  });

  it('refuses a secondaryVendor that is not a manufacturer on record', async () => {
    const app = await makeApp();
    const admin = { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) };
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-build/settings/ABC',
      headers: admin,
      payload: { secondaryVendor: 'Not A Real Vendor' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('clears secondaryVendor with an empty string', async () => {
    const app = await makeApp();
    const admin = { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) };
    await app.inject({
      method: 'PATCH',
      url: '/bom-build/settings/ABC',
      headers: admin,
      payload: { secondaryVendor: 'Goldberg Brothers' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-build/settings/ABC',
      headers: admin,
      payload: { secondaryVendor: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().secondaryVendor).toBeNull();
    await app.close();
  });
});
