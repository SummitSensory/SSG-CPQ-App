import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

/**
 * Audit (real database): do the catalog write paths keep a part's two halves —
 * `Product` and `Sku` — and its `ProductSourcing` rows in step?
 *
 * Every part this file creates is prefixed with a per-run tag and removed in afterAll.
 * Assertions about integrity call `checkPartIntegrity` and look ONLY at this run's
 * parts, so pre-existing rows in the database cannot make a test pass or fail.
 *
 * `it.fails` marks a CONFIRMED BUG: the test states the correct behaviour and is
 * expected to fail until the bug is fixed (vitest then reports the it.fails as failed,
 * prompting removal of the marker).
 */

const RUN = Date.now().toString(36).toUpperCase();
const P = `AUDCAT${RUN}`;
const VENDOR_A = `${P} Vendor A`;
const VENDOR_B = `${P} Vendor B`;

let db: PrismaClient;
let app: FastifyInstance;
let token = '';
let userId = '';
let categoryId = '';
let categoryName = '';
const mfr: Record<string, string> = {};
let integrity: typeof import('../../src/catalog/partIntegrity.js');

const part = (s: string) => `${P}-${s}`;

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: { authorization: 'Bearer ' + token },
    ...(payload ? { payload } : {}),
  });
}

/** Violations for this run's parts only. */
async function violationsFor(p: string) {
  const r = await integrity.checkPartIntegrity(db);
  return r.violations.filter((v) => v.part.toLowerCase() === p.toLowerCase());
}

async function createItem(p: string, over: Record<string, unknown> = {}) {
  const res = await call('POST', '/catalog/items', {
    part: p,
    name: `${p} name`,
    category: categoryName,
    categoryId,
    manufacturer: VENDOR_A,
    unitPriceMinor: 12345,
    unitCostMinor: 5000,
    proposalGroup: 'Audit Group',
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
}

/** A never-live part written straight to the tables (DRAFT, so it is deletable). */
async function seedDraftPart(p: string, vendor: string | null) {
  const prod = await db.product.create({
    data: { sku: p, name: `${p} name`, categoryId, createdById: userId, status: 'DRAFT' },
  });
  await db.sku.create({
    data: { part: p, description: `${p} name`, manufacturer: vendor, active: false },
  });
  if (vendor)
    await db.productSourcing.create({
      data: { productId: prod.id, manufacturerId: mfr[vendor]! },
    });
  return prod;
}

beforeAll(async () => {
  ({ prisma: db } = await import('../../src/lib/prisma.js'));
  integrity = await import('../../src/catalog/partIntegrity.js');

  const user = await db.user.create({
    data: {
      email: `${P.toLowerCase()}@example.com`,
      passwordHash: 'x',
      name: 'Catalog Audit',
      role: 'SYSTEM_ADMIN',
    },
  });
  userId = user.id;
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  token = await signAccessToken({ sub: userId, role: 'SYSTEM_ADMIN' });

  categoryName = `${P} Category`;
  const cat = await db.productCategory.create({
    data: { name: categoryName, slug: P.toLowerCase() + '-cat' },
  });
  categoryId = cat.id;

  for (const name of [VENDOR_A, VENDOR_B]) {
    const m = await db.manufacturer.create({
      data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
    });
    mfr[name] = m.id;
  }

  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerCatalogRoutes } = await import('../../src/routes/catalog.js');
  const { registerCatalogItemRoutes } = await import('../../src/routes/catalogItems.js');
  const { registerSkuRoutes } = await import('../../src/routes/skus.js');
  const { registerManufacturerRoutes } = await import('../../src/routes/manufacturers.js');
  const { registerVendorColorRoutes } = await import('../../src/routes/vendorColors.js');
  app = Fastify();
  registerErrorHandler(app);
  registerCatalogRoutes(app);
  registerCatalogItemRoutes(app);
  registerSkuRoutes(app);
  registerManufacturerRoutes(app);
  registerVendorColorRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (!db) return;
  const like = { startsWith: P, mode: 'insensitive' as const };
  const products = await db.product.findMany({ where: { sku: like }, select: { id: true } });
  const ids = products.map((p) => p.id);
  await db.productColorSpec.deleteMany({
    where: { OR: [{ productId: { in: ids } }, { sku: like }] },
  });
  await db.productSourcing.deleteMany({ where: { productId: { in: ids } } });
  await db.productCost.deleteMany({ where: { productId: { in: ids } } });
  await db.product.deleteMany({ where: { id: { in: ids } } });
  await db.sku.deleteMany({ where: { part: like } });
  await db.vendorColorPalette.deleteMany({ where: { manufacturer: { name: like } } });
  await db.manufacturer.deleteMany({ where: { name: like } });
  await db.productCategory.deleteMany({ where: { id: categoryId } });
  await db.entityRevision.deleteMany({ where: { actorId: userId } }).catch(() => undefined);
  await db.auditLog.deleteMany({ where: { actorId: userId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe('audit: catalog routes keep Product, Sku and ProductSourcing in sync (real DB)', () => {
  it('POST /catalog/items creates both halves and exactly one sourcing link', async () => {
    const p = part('CREATE');
    await createItem(p);
    const prod = await db.product.findUniqueOrThrow({
      where: { sku: p },
      include: { sourcing: true },
    });
    const sku = await db.sku.findUniqueOrThrow({ where: { part: p } });
    expect(prod.status).toBe('ACTIVE');
    expect(sku.active).toBe(true);
    expect(sku.manufacturer).toBe(VENDOR_A);
    expect(prod.sourcing.map((s) => s.manufacturerId)).toEqual([mfr[VENDOR_A]]);
    expect(await violationsFor(p)).toEqual([]);
  });

  it('POST /catalog/items refuses a part number already used by a Sku-only row', async () => {
    const p = part('SKUONLY');
    await db.sku.create({ data: { part: p, description: 'x' } });
    const res = await call('POST', '/catalog/items', {
      part: p,
      name: 'x',
      category: categoryName,
      categoryId,
      proposalGroup: 'G',
    });
    expect(res.statusCode).toBe(409);
    expect(await db.product.findUnique({ where: { sku: p } })).toBeNull();
  });

  it('PATCH /catalog/items/:part {manufacturer} relinks the single sourcing row and the Sku', async () => {
    const p = part('RELINK');
    await createItem(p);
    const res = await call('PATCH', `/catalog/items/${p}`, { manufacturer: VENDOR_B });
    expect(res.statusCode, res.body).toBe(200);
    const prod = await db.product.findUniqueOrThrow({
      where: { sku: p },
      include: { sourcing: true },
    });
    expect(prod.sourcing.map((s) => s.manufacturerId)).toEqual([mfr[VENDOR_B]]);
    expect((await db.sku.findUniqueOrThrow({ where: { part: p } })).manufacturer).toBe(VENDOR_B);
    expect(await violationsFor(p)).toEqual([]);
  });

  it('PATCH /catalog/items/:part refuses an unknown vendor and writes nothing', async () => {
    const p = part('UNKNOWNV');
    await createItem(p);
    const res = await call('PATCH', `/catalog/items/${p}`, { manufacturer: `${P} Nobody` });
    expect(res.statusCode).toBe(400);
    expect((await db.sku.findUniqueOrThrow({ where: { part: p } })).manufacturer).toBe(VENDOR_A);
    expect(await db.manufacturer.count({ where: { name: `${P} Nobody` } })).toBe(0);
  });

  it('ProductSourcing many-to-many is never collapsed by a vendor edit on a multi-vendor part', async () => {
    const p = part('MULTI');
    await createItem(p);
    const prod = await db.product.findUniqueOrThrow({ where: { sku: p } });
    await db.productSourcing.create({
      data: { productId: prod.id, manufacturerId: mfr[VENDOR_B]!, isPrimary: false },
    });
    for (const manufacturer of [VENDOR_B, '']) {
      const res = await call('PATCH', `/catalog/items/${p}`, { manufacturer });
      expect(res.statusCode).toBe(400);
    }
    const rows = await db.productSourcing.findMany({ where: { productId: prod.id } });
    expect(rows.map((r) => r.manufacturerId).sort()).toEqual(
      [mfr[VENDOR_A]!, mfr[VENDOR_B]!].sort(),
    );
    expect((await db.sku.findUniqueOrThrow({ where: { part: p } })).manufacturer).toBe(VENDOR_A);
  });

  it('POST /catalog/items/:part/active moves Product status and Sku.active together', async () => {
    const p = part('ACTIVE');
    await createItem(p);
    let res = await call('POST', `/catalog/items/${p}/active`, { active: false });
    expect(res.statusCode).toBe(200);
    expect((await db.product.findUniqueOrThrow({ where: { sku: p } })).status).toBe('INACTIVE');
    expect((await db.sku.findUniqueOrThrow({ where: { part: p } })).active).toBe(false);
    res = await call('POST', `/catalog/items/${p}/active`, { active: true });
    expect(res.statusCode).toBe(200);
    expect((await db.product.findUniqueOrThrow({ where: { sku: p } })).status).toBe('ACTIVE');
    expect((await db.sku.findUniqueOrThrow({ where: { part: p } })).active).toBe(true);
    expect(await violationsFor(p)).toEqual([]);
  });

  it('DELETE /catalog/items/:part refuses an ever-live part and keeps both halves', async () => {
    const p = part('LIVE');
    await createItem(p);
    const res = await call('DELETE', `/catalog/items/${p}`);
    expect(res.statusCode).toBe(409);
    expect(await db.product.findUnique({ where: { sku: p } })).not.toBeNull();
    expect(await db.sku.findUnique({ where: { part: p } })).not.toBeNull();
  });

  it('DELETE /catalog/items/:part removes Product, Sku and sourcing together for a draft part', async () => {
    const p = part('DRAFTDEL');
    const prod = await seedDraftPart(p, VENDOR_A);
    const res = await call('DELETE', `/catalog/items/${p}`);
    expect(res.statusCode, res.body).toBe(204);
    expect(await db.product.findUnique({ where: { sku: p } })).toBeNull();
    expect(await db.sku.findUnique({ where: { part: p } })).toBeNull();
    expect(await db.productSourcing.count({ where: { productId: prod.id } })).toBe(0);
  });

  it('DELETE /catalog/products/:id removes the Sku too (no orphaned priced row)', async () => {
    const p = part('PRODDEL');
    const prod = await seedDraftPart(p, null);
    const res = await call('DELETE', `/catalog/products/${prod.id}`);
    expect(res.statusCode, res.body).toBe(204);
    expect(await db.sku.findUnique({ where: { part: p } })).toBeNull();
  });

  // ---------------------------------------------------------------------------------
  // Confirmed bugs. Each states the correct behaviour; each currently fails.
  // ---------------------------------------------------------------------------------

  it('BUG: DELETE /skus/:id must not strip the priced half off an ACTIVE part', async () => {
    // src/routes/skus.ts DELETE /skus/:id deletes the Sku with no partDeletion() check:
    // the ACTIVE Product is left with no Sku — the checker's BLOCKING
    // product-without-sku state ("selectable in the proposal builder at $0.00") —
    // and the proposal-usage guard that DELETE /catalog/items applies is skipped.
    const p = part('SKUDEL');
    await createItem(p);
    const sku = await db.sku.findUniqueOrThrow({ where: { part: p } });
    const res = await call('DELETE', `/skus/${sku.id}`);
    expect(res.statusCode).toBe(409);
    expect(await violationsFor(p)).toEqual([]);
  });

  it('BUG: PATCH /skus/:id {manufacturer} must carry the vendor to ProductSourcing', async () => {
    // skus.ts PATCH /skus/:id writes Sku.manufacturer only — never syncPartSourcing —
    // producing BLOCKING vendor-not-sourced drift (the BOM orders from B, sourcing says A).
    const p = part('SKUVEND');
    await createItem(p);
    const sku = await db.sku.findUniqueOrThrow({ where: { part: p } });
    const res = await call('PATCH', `/skus/${sku.id}`, { manufacturer: VENDOR_B });
    expect(res.statusCode).toBe(200);
    expect(await violationsFor(p)).toEqual([]);
  });

  it('BUG: PATCH /skus/:id must refuse a vendor that is not on record', async () => {
    // POST/PATCH /catalog/items refuse an unknown vendor; PATCH /skus/:id accepts any
    // string, so a part can be ordered from a vendor with no Manufacturer row at all.
    const p = part('SKUNOV');
    await createItem(p);
    const sku = await db.sku.findUniqueOrThrow({ where: { part: p } });
    const res = await call('PATCH', `/skus/${sku.id}`, { manufacturer: `${P} Typo Vendor` });
    expect(res.statusCode).toBe(400);
  });

  it('BUG: PATCH /skus/:id {part} must not split a part into two half-parts', async () => {
    // SkuBody.partial() still accepts `part`, so renaming the Sku orphans the Product
    // (ACTIVE, now Sku-less = BLOCKING) and leaves a Product-less Sku under the new number.
    const p = part('RENAME');
    await createItem(p);
    const sku = await db.sku.findUniqueOrThrow({ where: { part: p } });
    const res = await call('PATCH', `/skus/${sku.id}`, { part: part('RENAMED') });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await violationsFor(p)).toEqual([]);
  });

  it('BUG: PATCH /catalog/items/:part validates the whole body before writing anything', async () => {
    // The route is not transactional and validates productUrl AFTER it has already
    // re-sourced the part (Sku.manufacturer, ProductSourcing, open-order reassignment).
    // A 400 response must mean nothing changed.
    const p = part('PARTIAL');
    await createItem(p);
    const res = await call('PATCH', `/catalog/items/${p}`, {
      manufacturer: VENDOR_B,
      productUrl: 'ftp://not-a-web-link',
    });
    expect(res.statusCode).toBe(400);
    expect((await db.sku.findUniqueOrThrow({ where: { part: p } })).manufacturer).toBe(VENDOR_A);
  });

  it('BUG: POST /catalog/items refuses a case-variant of an existing part number', async () => {
    // The duplicate check is an exact-case findUnique, but every other join on part
    // number (syncSkuActive, the integrity checker, colour specs) is case-insensitive.
    const p = part('CASE');
    await createItem(p);
    const res = await call('POST', '/catalog/items', {
      part: p.toLowerCase(),
      name: 'lower twin',
      category: categoryName,
      categoryId,
      proposalGroup: 'Audit Group',
    });
    expect(res.statusCode).toBe(409);
  });

  it('BUG: deactivating one part must not deactivate its case-variant twin', async () => {
    // syncSkuActive (src/catalog/service.ts) updates Sku rows with mode: 'insensitive',
    // so a status change on "x-1" also flips Sku.active on "X-1" — a different part.
    const upper = part('TWIN');
    await createItem(upper);
    const lower = upper.toLowerCase();
    await db.product.create({
      data: { sku: lower, name: 'twin', categoryId, createdById: userId, status: 'ACTIVE' },
    });
    await db.sku.create({ data: { part: lower, description: 'twin', active: true } });
    const res = await call('POST', `/catalog/items/${lower}/active`, { active: false });
    expect(res.statusCode).toBe(200);
    expect((await db.sku.findUniqueOrThrow({ where: { part: upper } })).active).toBe(true);
  });

  it('BUG: a Sku-less product cannot be made ACTIVE via PATCH /catalog/products/:id/status', async () => {
    // POST /catalog/products creates a Product with no Sku (DRAFT: a warning). The UI's
    // status dropdown then moves it to ACTIVE with no check — the BLOCKING
    // product-without-sku state, quotable at $0.00.
    const p = part('NOSKU');
    const created = await call('POST', '/catalog/products', {
      sku: p,
      name: 'Sku-less product',
      categoryId,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    const res = await call('PATCH', `/catalog/products/${id}/status`, { status: 'ACTIVE' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((await violationsFor(p)).filter((v) => v.severity === 'blocking')).toEqual([]);
  });

  it('BUG: DELETE /manufacturers/:id answers 409 (not 500) when its colour chart is in use', async () => {
    // Manufacturer -> VendorColorPalette is onDelete: Cascade, but ProductColorSpec ->
    // palette is Restrict. The route's usage check ignores palettes, so the cascade
    // hits the Restrict FK and the raw Prisma error surfaces as a 500.
    const name = `${P} Paint Vendor`;
    const m = await db.manufacturer.create({
      data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
    });
    const palette = await db.vendorColorPalette.create({
      data: { manufacturerId: m.id, name: 'Chart', colors: { create: [{ name: 'Red' }] } },
    });
    await db.productColorSpec.create({ data: { paletteId: palette.id, sku: part('PAINTED') } });
    const res = await call('DELETE', `/manufacturers/${m.id}`);
    expect(res.statusCode).toBe(409);
  });

  // ---------------------------------------------------------------------------------
  // Regression cover for the fixes above (not audit findings themselves).
  // ---------------------------------------------------------------------------------

  it('DELETE /skus/:id still deletes a priced-only row that no proposal uses', async () => {
    const p = part('SKUONLYDEL');
    const sku = await db.sku.create({ data: { part: p, description: 'x' } });
    const res = await call('DELETE', `/skus/${sku.id}`);
    expect(res.statusCode, res.body).toBe(204);
    expect(await db.sku.findUnique({ where: { part: p } })).toBeNull();
  });

  it('PATCH /skus/:id accepts its own part number unchanged, and resolves the vendor spelling', async () => {
    const p = part('SKUSAME');
    await createItem(p);
    const sku = await db.sku.findUniqueOrThrow({ where: { part: p } });
    const res = await call('PATCH', `/skus/${sku.id}`, {
      part: p,
      manufacturer: VENDOR_B.toLowerCase(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await db.sku.findUniqueOrThrow({ where: { part: p } })).manufacturer).toBe(VENDOR_B);
    expect(await violationsFor(p)).toEqual([]);
  });

  it('PATCH /skus/:id refuses a vendor change on a multi-vendor part and writes nothing', async () => {
    const p = part('SKUMULTI');
    await createItem(p);
    const prod = await db.product.findUniqueOrThrow({ where: { sku: p } });
    await db.productSourcing.create({
      data: { productId: prod.id, manufacturerId: mfr[VENDOR_B]!, isPrimary: false },
    });
    const sku = await db.sku.findUniqueOrThrow({ where: { part: p } });
    const res = await call('PATCH', `/skus/${sku.id}`, { manufacturer: VENDOR_B });
    expect(res.statusCode).toBe(400);
    expect((await db.sku.findUniqueOrThrow({ where: { part: p } })).manufacturer).toBe(VENDOR_A);
  });

  it('PATCH /catalog/items/:part saves vendor and buy link together when both are valid', async () => {
    const p = part('BOTHOK');
    await createItem(p);
    const res = await call('PATCH', `/catalog/items/${p}`, {
      manufacturer: VENDOR_B,
      productUrl: 'https://example.com/buy',
      unitCostMinor: 6000,
    });
    expect(res.statusCode, res.body).toBe(200);
    const sku = await db.sku.findUniqueOrThrow({ where: { part: p } });
    expect(sku.manufacturer).toBe(VENDOR_B);
    expect(sku.productUrl).toBe('https://example.com/buy');
    expect(sku.unitCostMinor).toBe(6000);
    expect(await violationsFor(p)).toEqual([]);
  });

  it('a case-mismatched single pair still moves together (exact-match fallback)', async () => {
    const lower = part('MIXED').toLowerCase();
    await db.product.create({
      data: { sku: lower, name: 'mixed', categoryId, createdById: userId, status: 'ACTIVE' },
    });
    await db.sku.create({
      data: { part: lower.toUpperCase(), description: 'mixed', active: true },
    });
    const res = await call('POST', `/catalog/items/${lower}/active`, { active: false });
    expect(res.statusCode, res.body).toBe(200);
    expect((await db.sku.findUniqueOrThrow({ where: { part: lower.toUpperCase() } })).active).toBe(
      false,
    );
  });

  it('DELETE /catalog/items/:part also removes the product colour spec', async () => {
    const p = part('SPECDEL');
    const prod = await seedDraftPart(p, VENDOR_A);
    const palette = await db.vendorColorPalette.create({
      data: { manufacturerId: mfr[VENDOR_A]!, name: `${P} spec chart` },
    });
    await db.productColorSpec.create({ data: { paletteId: palette.id, productId: prod.id } });
    const res = await call('DELETE', `/catalog/items/${p}`);
    expect(res.statusCode, res.body).toBe(204);
    expect(await db.productColorSpec.count({ where: { productId: prod.id } })).toBe(0);
  });

  it('GET /manufacturers/:id/usage reports colour charts and vendor part numbers', async () => {
    const name = `${P} Usage Vendor`;
    const m = await db.manufacturer.create({
      data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
    });
    await db.vendorColorPalette.create({ data: { manufacturerId: m.id, name: 'Unused chart' } });
    await db.vendorPartNumber.create({
      data: { manufacturerId: m.id, ourPart: part('VPN'), vendorPart: 'V-1' },
    });
    const res = await call('GET', `/manufacturers/${m.id}/usage`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      paletteCount: 1,
      palettesInUse: 0,
      vendorPartNumberCount: 1,
      deletable: true,
    });
  });

  it('DELETE /manufacturers/:id counts a part naming the vendor in a different case', async () => {
    const name = `${P} Case Vendor`;
    const m = await db.manufacturer.create({
      data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
    });
    await db.sku.create({
      data: { part: part('CASEVEND'), description: 'x', manufacturer: name.toLowerCase() },
    });
    const res = await call('DELETE', `/manufacturers/${m.id}`);
    expect(res.statusCode).toBe(409);
  });

  it('PATCH /manufacturers/:id rename carries parts that spell the vendor in another case', async () => {
    const name = `${P} Rename Vendor`;
    const m = await db.manufacturer.create({
      data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
    });
    const p = part('RENAMEVEND');
    await db.sku.create({ data: { part: p, description: 'x', manufacturer: name.toUpperCase() } });
    const res = await call('PATCH', `/manufacturers/${m.id}`, { name: `${name} Renamed` });
    expect(res.statusCode, res.body).toBe(200);
    expect((await db.sku.findUniqueOrThrow({ where: { part: p } })).manufacturer).toBe(
      `${name} Renamed`,
    );
  });
});

/*
 * The CLI wrapper (`prisma/check-part-integrity.ts`, i.e. `pnpm db:check:integrity`)
 * must exit non-zero on a blocking violation and name the part. Spawned WITHOUT
 * --env-file so it can never read .env (production); only runs against a local DB.
 */
const LOCAL_DB = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '');
describe.skipIf(!LOCAL_DB)('audit: check-part-integrity CLI exit code (local DB only)', () => {
  it('exits 1 and names the part when an ACTIVE product has no Sku', async () => {
    const p = part('CLI');
    await db.product.create({
      data: { sku: p, name: 'cli', categoryId, createdById: userId, status: 'ACTIVE' },
    });
    const out = spawnSync('npx', ['tsx', 'prisma/check-part-integrity.ts'], {
      env: { ...process.env, DIRECT_URL: process.env.DATABASE_URL },
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 90_000,
    });
    expect(out.status, out.stderr).toBe(1);
    expect(out.stdout).toContain(p);
    expect(out.stdout).toMatch(/product-without-sku\s+\[BLOCKING\]/);
  }, 120_000);
});
