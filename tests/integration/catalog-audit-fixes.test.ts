import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient, ProductKind, ProductStatus } from '@prisma/client';

/**
 * The catalog / product-tree audit fixes, against a REAL database.
 *
 * Most of these are about two records staying in step inside one transaction —
 * `Product.status` and `Sku.active`, a delete taking both halves of a part, an import
 * landing whole or not at all — which an in-memory stub cannot show: the stub would
 * only prove the code calls the methods it was written to call. CI runs this file
 * against the throwaway Postgres it migrates before `pnpm test`; locally it needs the
 * docker database (`docker compose up -d db`), like the rest of `test:integration`.
 *
 * Every row is created under a per-run prefix and removed in afterAll, so the file is
 * safe to run against a development database that has data of its own. The one
 * global operation (renumber) only runs when nothing else is in the tree.
 */

const RUN = Date.now().toString(36).toUpperCase();
const P = `ZT${RUN}`; // part-number prefix
const S = `zt-${RUN.toLowerCase()}`; // slug prefix
const MFR = `ZT Vendor ${RUN}`;

let app: FastifyInstance;
let db: PrismaClient;
let auth: Record<string, string>;
let userId = '';

async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: auth,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.body ? (res.json() as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function category(name: string, parentId: string | null = null, tierLevel = 1) {
  return db.productCategory.create({
    data: {
      name,
      slug: `${S}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      parentId,
      tierLevel,
    },
  });
}

async function part(
  suffix: string,
  opts: {
    status?: ProductStatus;
    kind?: ProductKind;
    categoryId: string;
    sku?: { active: boolean } | null;
  },
) {
  const sku = `${P}-${suffix}`;
  const product = await db.product.create({
    data: {
      sku,
      name: `Test ${suffix}`,
      categoryId: opts.categoryId,
      status: opts.status ?? 'DRAFT',
      kind: opts.kind ?? 'PRODUCT',
      createdById: userId,
    },
  });
  if (opts.sku !== null)
    await db.sku.create({
      data: {
        part: sku,
        description: `Test ${suffix}`,
        unitPriceMinor: 1000,
        active: opts.sku?.active ?? true,
      },
    });
  return product;
}

let root: { id: string; name: string };

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  db = (await import('../../src/lib/prisma.js')).prisma;
  const user = await db.user.create({
    data: {
      email: `${S}@example.test`,
      passwordHash: 'x',
      role: 'SYSTEM_ADMIN',
      name: 'Catalog audit test',
    },
  });
  userId = user.id;
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  auth = {
    authorization: 'Bearer ' + (await signAccessToken({ sub: user.id, role: 'SYSTEM_ADMIN' })),
  };

  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerCatalogRoutes } = await import('../../src/routes/catalog.js');
  const { registerCatalogItemRoutes } = await import('../../src/routes/catalogItems.js');
  const { registerProductTreeRoutes } = await import('../../src/routes/productTree.js');
  const { registerBundleRoutes } = await import('../../src/routes/bundles.js');
  const { registerManufacturerRoutes } = await import('../../src/routes/manufacturers.js');
  app = Fastify();
  registerErrorHandler(app);
  registerCatalogRoutes(app);
  registerCatalogItemRoutes(app);
  registerProductTreeRoutes(app);
  registerBundleRoutes(app);
  registerManufacturerRoutes(app);
  await app.ready();

  root = await category('Root');
});

afterAll(async () => {
  if (!db) return;
  const products = await db.product.findMany({
    where: { sku: { startsWith: P } },
    select: { id: true },
  });
  const ids = products.map((p) => p.id);
  await db.productRelation.deleteMany({
    where: { OR: [{ parentId: { in: ids } }, { childId: { in: ids } }] },
  });
  await db.productSourcing.deleteMany({ where: { productId: { in: ids } } });
  await db.productCost.deleteMany({ where: { productId: { in: ids } } });
  await db.product.deleteMany({ where: { id: { in: ids } } });
  await db.sku.deleteMany({ where: { part: { startsWith: P } } });
  // Children before parents is not needed (parentId is SetNull), but tidy.
  await db.productCategory.deleteMany({ where: { slug: { startsWith: S } } });
  await db.manufacturer.deleteMany({ where: { name: { startsWith: 'ZT Vendor ' + RUN } } });
  if (userId) {
    await db.auditLog.deleteMany({ where: { actorId: userId } });
    await db.entityRevision.deleteMany({ where: { actorId: userId } });
    await db.user.delete({ where: { id: userId } });
  }
  await app?.close();
});

// ---------------------------------------------------------------------------------
describe('H1 — a status change carries to the priced record; non-ACTIVE is not quotable', () => {
  it('PATCH /catalog/products/:id/status archives the Sku with the Product, in one go', async () => {
    const p = await part('H1A', { status: 'ACTIVE', categoryId: root.id });
    const r = await send('PATCH', `/catalog/products/${p.id}/status`, { status: 'ARCHIVED' });
    expect(r.status).toBe(200);
    expect((await db.sku.findUnique({ where: { part: p.sku } }))?.active).toBe(false);
  });

  it('reactivating an INACTIVE part reactivates its Sku', async () => {
    const p = await part('H1B', {
      status: 'INACTIVE',
      categoryId: root.id,
      sku: { active: false },
    });
    const r = await send('PATCH', `/catalog/products/${p.id}/status`, { status: 'ACTIVE' });
    expect(r.status).toBe(200);
    expect((await db.sku.findUnique({ where: { part: p.sku } }))?.active).toBe(true);
  });

  it('defaults and the item list drop a part whose Product is not ACTIVE, even with an active Sku', async () => {
    // The legacy state: status changed before the Sku was carried along.
    const p = await part('H1C', { status: 'INACTIVE', categoryId: root.id, sku: { active: true } });
    const defs = await send('GET', '/catalog/items/defaults');
    expect(defs.status).toBe(200);
    expect(defs.body[p.sku]).toBeUndefined();
    const list = await send('GET', `/catalog/items?q=${encodeURIComponent(p.sku)}`);
    const row = (list.body.items as Array<{ part: string; active: boolean }>).find(
      (i) => i.part === p.sku,
    );
    expect(row?.active).toBe(false);
  });

  it('PATCH /catalog/items/:part {active:true} on an ARCHIVED part is a 409 and writes nothing', async () => {
    const p = await part('H1D', {
      status: 'ARCHIVED',
      categoryId: root.id,
      sku: { active: false },
    });
    const r = await send('PATCH', `/catalog/items/${p.sku}`, { active: true, weightLbs: 9 });
    expect(r.status).toBe(409);
    const sku = await db.sku.findUnique({ where: { part: p.sku } });
    expect(sku?.active).toBe(false);
    expect(sku?.weightLbs).toBe(0);
    expect((await db.product.findUnique({ where: { id: p.id } }))?.status).toBe('ARCHIVED');
  });

  it('PATCH /catalog/items/:part {active:false} deactivates through the state machine', async () => {
    const p = await part('H1E', { status: 'ACTIVE', categoryId: root.id });
    const r = await send('PATCH', `/catalog/items/${p.sku}`, { active: false });
    expect(r.status).toBe(200);
    expect((await db.product.findUnique({ where: { id: p.id } }))?.status).toBe('INACTIVE');
    expect((await db.sku.findUnique({ where: { part: p.sku } }))?.active).toBe(false);
    const hist = await db.productStatusHistory.findMany({ where: { productId: p.id } });
    expect(hist.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual(['ACTIVE->INACTIVE']);
  });
});

// ---------------------------------------------------------------------------------
describe('H2 — a part that has been live cannot be hard-deleted; deletes take both halves', () => {
  it('POST /catalog/items writes a "created" history row, and the part is then undeletable', async () => {
    const sku = `${P}-H2A`;
    const r = await send('POST', '/catalog/items', {
      part: sku,
      name: 'Created live',
      category: root.name,
      categoryId: root.id,
      proposalGroup: 'Test group',
    });
    expect(r.status).toBe(201);
    const hist = await db.productStatusHistory.findMany({
      where: { productId: r.body.productId as string },
    });
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ fromStatus: null, toStatus: 'ACTIVE', reason: 'created' });
    const del = await send('DELETE', `/catalog/items/${sku}`);
    expect(del.status).toBe(409);
    expect(await db.product.findUnique({ where: { sku } })).not.toBeNull();
  });

  it('an ACTIVE part with NO history row (made before this fix) is still refused, on both routes', async () => {
    const p = await part('H2B', { status: 'ACTIVE', categoryId: root.id });
    expect((await send('DELETE', `/catalog/items/${p.sku}`)).status).toBe(409);
    expect((await send('DELETE', `/catalog/products/${p.id}`)).status).toBe(409);
    const usage = await send('GET', `/catalog/items/${p.sku}/usage`);
    expect(usage.body.deletable).toBe(false);
  });

  it('DELETE /catalog/products/:id removes the Sku and cost history with a never-live Product', async () => {
    const p = await part('H2C', { status: 'DRAFT', categoryId: root.id });
    await db.productCost.create({
      data: {
        productId: p.id,
        unitCost: 500n,
        currency: 'USD',
        effectiveDate: new Date(),
        createdById: userId,
      },
    });
    const r = await send('DELETE', `/catalog/products/${p.id}`);
    expect(r.status).toBe(204);
    expect(await db.product.findUnique({ where: { id: p.id } })).toBeNull();
    expect(await db.sku.findUnique({ where: { part: p.sku } })).toBeNull();
    expect(await db.productCost.count({ where: { productId: p.id } })).toBe(0);
  });

  it('a part listed inside a bundle is refused with a message, not a foreign-key 500', async () => {
    const bundle = await part('H2D-B', { kind: 'BUNDLE', categoryId: root.id, sku: null });
    const child = await part('H2D-C', { categoryId: root.id });
    await db.productRelation.create({
      data: { parentId: bundle.id, childId: child.id, type: 'BUNDLE_ITEM' },
    });
    const r = await send('DELETE', `/catalog/items/${child.sku}`);
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/lists this part/);
  });
});

// ---------------------------------------------------------------------------------
describe('H3 — POST /catalog/items/:part/active goes through the state machine', () => {
  it('refuses ARCHIVED -> ACTIVE', async () => {
    const p = await part('H3A', {
      status: 'ARCHIVED',
      categoryId: root.id,
      sku: { active: false },
    });
    const r = await send('POST', `/catalog/items/${p.sku}/active`, { active: true });
    expect(r.status).toBe(409);
    expect((await db.product.findUnique({ where: { id: p.id } }))?.status).toBe('ARCHIVED');
    expect((await db.sku.findUnique({ where: { part: p.sku } }))?.active).toBe(false);
  });

  it('"Deactivate" on a DRAFT keeps it DRAFT (DRAFT -> INACTIVE is illegal) and switches the Sku off', async () => {
    const p = await part('H3B', { status: 'DRAFT', categoryId: root.id, sku: { active: true } });
    const r = await send('POST', `/catalog/items/${p.sku}/active`, { active: false });
    expect(r.status).toBe(200);
    expect((await db.product.findUnique({ where: { id: p.id } }))?.status).toBe('DRAFT');
    expect((await db.sku.findUnique({ where: { part: p.sku } }))?.active).toBe(false);
    expect(await db.productStatusHistory.count({ where: { productId: p.id } })).toBe(0);
    // Still never live, so still deletable.
    expect((await send('DELETE', `/catalog/items/${p.sku}`)).status).toBe(204);
  });

  it('deactivates an ACTIVE part: INACTIVE, history row, Sku off', async () => {
    const p = await part('H3C', { status: 'ACTIVE', categoryId: root.id });
    const r = await send('POST', `/catalog/items/${p.sku}/active`, { active: false });
    expect(r.status).toBe(200);
    expect(r.body.productStatus).toBe('INACTIVE');
    expect((await db.sku.findUnique({ where: { part: p.sku } }))?.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
describe('H4 — tree import: valid kinds, legal transitions, all-or-nothing', () => {
  it('refuses kind FREIGHT at validation (it is not a ProductKind)', async () => {
    const r = await send('POST', '/catalog/tree/import', {
      dryRun: false,
      products: [{ sku: `${P}-H4A`, name: 'Freight', categorySlug: `${S}-root`, kind: 'FREIGHT' }],
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body.issues)).toMatch(/unknown kind/);
    expect(await db.product.findUnique({ where: { sku: `${P}-H4A` } })).toBeNull();
  });

  it('refuses an illegal status move at preview time', async () => {
    const p = await part('H4B', { status: 'ACTIVE', categoryId: root.id });
    const r = await send('POST', '/catalog/tree/import', {
      dryRun: true,
      products: [{ sku: p.sku, status: 'DRAFT' }],
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body.issues)).toMatch(/cannot go from ACTIVE to DRAFT/);
  });

  it('a legal status change writes history and switches the Sku; a new ACTIVE part gets a history row', async () => {
    const p = await part('H4C', { status: 'ACTIVE', categoryId: root.id });
    const r = await send('POST', '/catalog/tree/import', {
      dryRun: false,
      products: [
        { sku: p.sku, status: 'INACTIVE' },
        { sku: `${P}-H4D`, name: 'New live part', categorySlug: `${S}-root`, status: 'ACTIVE' },
      ],
    });
    expect(r.status).toBe(200);
    expect((await db.sku.findUnique({ where: { part: p.sku } }))?.active).toBe(false);
    const h = await db.productStatusHistory.findMany({ where: { productId: p.id } });
    expect(h.map((x) => x.toStatus)).toEqual(['INACTIVE']);
    const created = await db.product.findUnique({ where: { sku: `${P}-H4D` } });
    expect(created?.status).toBe('ACTIVE');
    expect(await db.productStatusHistory.count({ where: { productId: created!.id } })).toBe(1);
  });

  it('rolls the whole import back when a write fails partway', async () => {
    // A sortOrder past the 32-bit column passes validation and fails at the database —
    // on the LAST row, after a category and a product have already been written. The
    // old, transaction-less commit kept both of those.
    const slug = `${S}-rollback`;
    const r = await send('POST', '/catalog/tree/import', {
      dryRun: false,
      categories: [{ slug, name: 'Should not survive' }],
      products: [
        { sku: `${P}-H4E`, name: 'Should not survive', categorySlug: `${S}-root` },
        { sku: `${P}-H4F`, name: 'Fails', categorySlug: `${S}-root`, sortOrder: 3_000_000_000 },
      ],
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await db.productCategory.findUnique({ where: { slug } })).toBeNull();
    expect(await db.product.findUnique({ where: { sku: `${P}-H4E` } })).toBeNull();
  });

  it('reads isActive "false" as false (z.coerce.boolean read it as true)', async () => {
    const c = await category('Hidden flag');
    const r = await send('POST', '/catalog/tree/import', {
      dryRun: false,
      categories: [{ slug: c.slug, isActive: 'false' }],
    });
    expect(r.status).toBe(200);
    expect((await db.productCategory.findUnique({ where: { id: c.id } }))?.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
describe('M1 — the 4-tier rules are enforced', () => {
  it('POST /catalog/categories derives the tier from the parent and refuses a fifth level', async () => {
    const t1 = await send('POST', '/catalog/categories', { name: 'M1 T1', slug: `${S}-m1-t1` });
    expect(t1.body.tierLevel).toBe(1);
    const t2 = await send('POST', '/catalog/categories', {
      name: 'M1 T2',
      slug: `${S}-m1-t2`,
      parentId: t1.body.id,
    });
    expect(t2.status).toBe(201);
    expect(t2.body.tierLevel).toBe(2);
    const t3 = await send('POST', '/catalog/categories', {
      name: 'M1 T3',
      slug: `${S}-m1-t3`,
      parentId: t2.body.id,
    });
    const t4 = await send('POST', '/catalog/categories', {
      name: 'M1 T4',
      slug: `${S}-m1-t4`,
      parentId: t3.body.id,
    });
    expect(t4.body.tierLevel).toBe(4);
    const t5 = await send('POST', '/catalog/categories', {
      name: 'M1 T5',
      slug: `${S}-m1-t5`,
      parentId: t4.body.id,
    });
    expect(t5.status).toBe(400);
  });

  it('PATCH refuses a tier that contradicts the parent, and a cycle', async () => {
    const a = await category('M1 A');
    const b = await category('M1 B', a.id, 2);
    expect((await send('PATCH', `/catalog/categories/${b.id}`, { tierLevel: 1 })).status).toBe(400);
    expect((await send('PATCH', `/catalog/categories/${a.id}`, { parentId: b.id })).status).toBe(
      409,
    );
  });

  it('re-parenting carries the new depth to every descendant, and refuses past tier 4', async () => {
    const top = await category('M1 Top');
    const mid = await category('M1 Mid', top.id, 2);
    const leaf = await category('M1 Leaf', mid.id, 3);
    const other = await category('M1 Other');
    const other2 = await category('M1 Other2', other.id, 2);
    // mid (with leaf beneath it) moves under other2: mid -> 3, leaf -> 4.
    const ok = await send('PATCH', `/catalog/categories/${mid.id}`, { parentId: other2.id });
    expect(ok.status).toBe(200);
    expect((await db.productCategory.findUnique({ where: { id: mid.id } }))?.tierLevel).toBe(3);
    expect((await db.productCategory.findUnique({ where: { id: leaf.id } }))?.tierLevel).toBe(4);
    // One level deeper would put leaf at 5.
    const deeper = await category('M1 Deeper', other2.id, 3);
    const refused = await send('PATCH', `/catalog/categories/${mid.id}`, { parentId: deeper.id });
    expect(refused.status).toBe(400);
    expect((await db.productCategory.findUnique({ where: { id: mid.id } }))?.parentId).toBe(
      other2.id,
    );
  });

  it('the tree import refuses a parent cycle and a fifth tier before writing anything', async () => {
    const x = await category('M1 X');
    const y = await category('M1 Y', x.id, 2);
    const cyc = await send('POST', '/catalog/tree/import', {
      dryRun: false,
      categories: [{ slug: x.slug, parentSlug: y.slug }],
    });
    expect(cyc.status).toBe(422);
    expect(JSON.stringify(cyc.body.issues)).toMatch(/loops back/);
    expect((await db.productCategory.findUnique({ where: { id: x.id } }))?.parentId).toBeNull();

    const deep = await send('POST', '/catalog/tree/import', {
      dryRun: true,
      categories: [
        { slug: `${S}-d1`, name: 'D1' },
        { slug: `${S}-d2`, name: 'D2', parentSlug: `${S}-d1` },
        { slug: `${S}-d3`, name: 'D3', parentSlug: `${S}-d2` },
        { slug: `${S}-d4`, name: 'D4', parentSlug: `${S}-d3` },
        { slug: `${S}-d5`, name: 'D5', parentSlug: `${S}-d4` },
      ],
    });
    expect(deep.status).toBe(422);
    expect(JSON.stringify(deep.body.issues)).toMatch(/tier 5/);
  });

  it('the tree import writes the derived tier, not the one in the file', async () => {
    const r = await send('POST', '/catalog/tree/import', {
      dryRun: false,
      categories: [
        { slug: `${S}-i1`, name: 'I1', tierLevel: 1 },
        { slug: `${S}-i2`, name: 'I2', parentSlug: `${S}-i1`, tierLevel: 1 },
      ],
    });
    expect(r.status).toBe(200);
    expect(
      (r.body.plan as { categories: { tierCorrected: string[] } }).categories.tierCorrected,
    ).toEqual([`${S}-i2`]);
    expect((await db.productCategory.findUnique({ where: { slug: `${S}-i2` } }))?.tierLevel).toBe(
      2,
    );
  });
});

// ---------------------------------------------------------------------------------
describe('M2 — bundle routes only touch bundles, and bundles do not nest', () => {
  it('DELETE /catalog/bundles/:id refuses a product that is not a bundle', async () => {
    const p = await part('M2A', { categoryId: root.id });
    const r = await send('DELETE', `/catalog/bundles/${p.id}`);
    expect(r.status).toBe(409);
    expect(await db.product.findUnique({ where: { id: p.id } })).not.toBeNull();
  });

  it('PUT components refuses a non-bundle, and a bundle that sits inside another bundle', async () => {
    const plain = await part('M2B', { categoryId: root.id });
    const comp = await part('M2C', { categoryId: root.id });
    const put = (id: string) =>
      send('PUT', `/catalog/bundles/${id}/components`, {
        components: [{ productId: comp.id, quantity: 1 }],
      });
    expect((await put(plain.id)).status).toBe(409);
    expect((await db.product.findUnique({ where: { id: plain.id } }))?.kind).toBe('PRODUCT');

    const outer = await part('M2D', { kind: 'BUNDLE', categoryId: root.id, sku: null });
    const inner = await part('M2E', { kind: 'BUNDLE', categoryId: root.id, sku: null });
    await db.productRelation.create({
      data: { parentId: outer.id, childId: inner.id, type: 'BUNDLE_ITEM' },
    });
    expect((await put(inner.id)).status).toBe(409);
  });

  it('PUT components records part numbers, not product ids, in the revision log', async () => {
    const b = await part('M2F', { kind: 'BUNDLE', categoryId: root.id, sku: null });
    const c = await part('M2G', { categoryId: root.id });
    const r = await send('PUT', `/catalog/bundles/${b.id}/components`, {
      components: [{ productId: c.id, quantity: 2 }],
    });
    expect(r.status).toBe(200);
    const rev = await db.entityRevision.findFirst({
      where: { entity: 'ProductBundle', entityId: b.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.stringify(rev?.after)).toContain(c.sku);
  });

  it('the tree import marks the parent BUNDLE and refuses a bundle inside a bundle', async () => {
    const parent = await part('M2H', { categoryId: root.id, sku: null });
    const child = await part('M2I', { categoryId: root.id });
    const ok = await send('POST', '/catalog/tree/import', {
      dryRun: false,
      bundles: [{ bundleSku: parent.sku, componentSku: child.sku, quantity: 1 }],
    });
    expect(ok.status).toBe(200);
    expect((await db.product.findUnique({ where: { id: parent.id } }))?.kind).toBe('BUNDLE');

    const other = await part('M2J', { categoryId: root.id, sku: null });
    const nested = await send('POST', '/catalog/tree/import', {
      dryRun: true,
      bundles: [{ bundleSku: other.sku, componentSku: parent.sku, quantity: 1 }],
    });
    expect(nested.status).toBe(422);
    expect(JSON.stringify(nested.body.issues)).toMatch(/itself a bundle/);
  });
});

// ---------------------------------------------------------------------------------
describe('M3 — sort-order audit and renumber exist and answer in the shape the UI reads', () => {
  it('lists sibling collisions and renumbers them away', async () => {
    const c = await category('M3 Cat');
    const a = await part('M3A', { categoryId: c.id });
    const b = await part('M3B', { categoryId: c.id });
    await db.product.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { sortOrder: 5 } });
    const audit = await send('GET', '/catalog/tree/sort-audit');
    expect(audit.status).toBe(200);
    const clash = (
      audit.body.productClashes as Array<{
        scope: string;
        sortOrder: number;
        members: Array<{ label: string }>;
      }>
    ).find((x) => x.scope === 'M3 Cat');
    expect(clash?.sortOrder).toBe(5);
    expect(clash?.members.map((m) => m.label)).toEqual([
      `${a.sku} — Test M3A`,
      `${b.sku} — Test M3B`,
    ]);
    expect(typeof audit.body.clashCount).toBe('number');
    expect(typeof audit.body.affected).toBe('number');

    // Renumber rewrites the whole tree, so only when this run's rows are all there is.
    const foreign =
      (await db.product.count({ where: { NOT: { sku: { startsWith: P } } } })) +
      (await db.productCategory.count({ where: { NOT: { slug: { startsWith: S } } } }));
    if (foreign > 0) return;
    const rn = await send('POST', '/catalog/tree/renumber', {});
    expect(rn.status).toBe(200);
    expect(typeof rn.body.categories).toBe('number');
    expect(typeof rn.body.products).toBe('number');
    const after = await db.product.findMany({
      where: { id: { in: [a.id, b.id] } },
      orderBy: { sortOrder: 'asc' },
    });
    expect(after.map((x) => [x.sku, x.sortOrder])).toEqual([
      [a.sku, 10],
      [b.sku, 20],
    ]);
    const again = await send('GET', '/catalog/tree/sort-audit');
    expect(again.body.clashCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------
describe('M6 — a manufacturer rename reaches free-issue and secondary vendor names', () => {
  it('renames them, and counts them as usage', async () => {
    const m = await db.manufacturer.create({
      data: { name: MFR, slug: `${S}-vendor` },
    });
    await db.sku.create({
      data: { part: `${P}-M6A`, description: 'free issue', freeIssueVendor: MFR },
    });
    await db.sku.create({
      data: { part: `${P}-M6B`, description: 'secondary', secondaryVendor: MFR },
    });
    const usage = await send('GET', `/manufacturers/${m.id}/usage`);
    expect(usage.body.skuCount).toBe(2);
    expect(usage.body.deletable).toBe(false);
    const renamed = `${MFR} Renamed`;
    const r = await send('PATCH', `/manufacturers/${m.id}`, { name: renamed });
    expect(r.status).toBe(200);
    expect((await db.sku.findUnique({ where: { part: `${P}-M6A` } }))?.freeIssueVendor).toBe(
      renamed,
    );
    expect((await db.sku.findUnique({ where: { part: `${P}-M6B` } }))?.secondaryVendor).toBe(
      renamed,
    );
  });
});

// ---------------------------------------------------------------------------------
describe('LOW — category resolved by id; an ambiguous name is refused', () => {
  it('files a new part under the category id sent, even when its name is shared', async () => {
    const one = await category('Shared name');
    const two = await db.productCategory.create({
      data: { name: 'Shared name', slug: `${S}-shared-name-2` },
    });
    const byName = await send('POST', '/catalog/items', {
      part: `${P}-L1`,
      name: 'By name',
      category: 'Shared name',
      proposalGroup: 'G',
    });
    expect(byName.status).toBe(400);
    expect(String(byName.body.message)).toMatch(/More than one/);
    const byId = await send('POST', '/catalog/items', {
      part: `${P}-L2`,
      name: 'By id',
      category: 'Shared name',
      categoryId: two.id,
      proposalGroup: 'G',
    });
    expect(byId.status).toBe(201);
    expect((await db.product.findUnique({ where: { sku: `${P}-L2` } }))?.categoryId).toBe(two.id);
    const moved = await send('PATCH', `/catalog/items/${P}-L2`, { categoryId: one.id });
    expect(moved.status).toBe(200);
    expect((await db.product.findUnique({ where: { sku: `${P}-L2` } }))?.categoryId).toBe(one.id);
  });
});
