import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { recordAudit } from '../lib/audit.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError, ConflictError, NotFoundError } from '../lib/errors.js';
import { CategoryInput, FamilyInput, ProductInput, StatusEnum } from '../catalog/validation.js';
import { validateImportBatch, ImportEnvelope } from '../catalog/import.js';
import { changeStatus, assertDeletable } from '../catalog/service.js';
import { ListQuery, buildOrderBy, paginate } from '../crm/query.js';

const PRODUCT_SORT = ['sku', 'name', 'status', 'kind', 'createdAt', 'updatedAt'];

export function registerCatalogRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CATALOG_READ) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  // ----- Categories & families (admin, no deploy needed) -----
  app.post('/catalog/categories', admin, async (req, reply) => {
    const parsed = CategoryInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const exists = await prisma.productCategory.findUnique({ where: { slug: parsed.data.slug } });
    if (exists) throw new ConflictError('Category slug already exists');
    const cat = await prisma.productCategory.create({ data: parsed.data });
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.category.create', entity: 'ProductCategory', entityId: cat.id });
    return reply.status(201).send(cat);
  });

  app.post('/catalog/families', admin, async (req, reply) => {
    const parsed = FamilyInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const family = await prisma.productFamily.create({ data: parsed.data }).catch(() => {
      throw new ConflictError('Family slug already exists in this category');
    });
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.family.create', entity: 'ProductFamily', entityId: family.id });
    return reply.status(201).send(family);
  });

  // ----- Products -----
  app.get('/catalog/products', read, async (req) => {
    const p = ListQuery.parse(req.query);
    const f = req.query as { status?: string; kind?: string; categoryId?: string };
    const where = {
      ...(p.q ? { OR: [{ name: { contains: p.q, mode: 'insensitive' as const } }, { sku: { contains: p.q, mode: 'insensitive' as const } }] } : {}),
      ...(f.status ? { status: f.status as never } : {}),
      ...(f.kind ? { kind: f.kind as never } : {}),
      ...(f.categoryId ? { categoryId: f.categoryId } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.product.findMany({ where, orderBy: buildOrderBy(p.sort, p.dir, PRODUCT_SORT, 'createdAt'), ...paginate(p.page, p.pageSize) }),
      prisma.product.count({ where }),
    ]);
    return { items, total, page: p.page, pageSize: p.pageSize };
  });

  app.post('/catalog/products', admin, async (req, reply) => {
    const parsed = ProductInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const dupe = await prisma.product.findUnique({ where: { sku: parsed.data.sku } });
    if (dupe) throw new ConflictError('SKU already exists');
    const { activeFrom, activeTo, ...rest } = parsed.data;
    const product = await prisma.product.create({
      data: { ...rest, activeFrom: activeFrom ?? null, activeTo: activeTo ?? null, createdById: req.user!.sub },
    });
    await prisma.productVersion.create({
      data: { productId: product.id, version: 1, snapshot: parsed.data as object, changedById: req.user!.sub, changeNote: 'created' },
    });
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.product.create', entity: 'Product', entityId: product.id });
    return reply.status(201).send(product);
  });

  app.get('/catalog/products/:id/versions', read, async (req) => {
    const { id } = req.params as { id: string };
    return prisma.productVersion.findMany({ where: { productId: id }, orderBy: { version: 'desc' } });
  });

  app.patch('/catalog/products/:id/status', admin, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { status?: string; reason?: string };
    const parsed = StatusEnum.safeParse(body.status);
    if (!parsed.success) throw new ValidationError('invalid status');
    const product = await changeStatus(id, parsed.data, req.user!.sub, body.reason);
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.product.status', entity: 'Product', entityId: id, details: { to: parsed.data } });
    return product;
  });

  // Hard delete is guarded; ever-active or referenced products must be archived.
  app.delete('/catalog/products/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundError();
    await assertDeletable(id);
    await prisma.product.delete({ where: { id } });
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.product.delete', entity: 'Product', entityId: id });
    return reply.status(204).send();
  });

  // ----- Import (validate first; dry-run by default) -----
  app.post('/catalog/import', admin, async (req, reply) => {
    const env = ImportEnvelope.safeParse(req.body);
    if (!env.success) throw new ValidationError(env.error.message);
    const result = validateImportBatch(env.data.rows);

    // DB-level duplicate prevention across the whole catalog.
    const skus = env.data.rows.map((r) => (r as { sku?: string }).sku).filter(Boolean) as string[];
    const existing = await prisma.product.findMany({ where: { sku: { in: skus } }, select: { sku: true } });
    for (const e of existing) {
      result.issues.push({ row: 0, field: 'sku', message: `SKU already exists in catalog: ${e.sku}` });
    }
    const valid = result.issues.length === 0;

    if (env.data.dryRun || !valid) {
      return reply.status(valid ? 200 : 422).send({ ...result, valid, committed: false });
    }
    // Commit valid rows.
    const created = await prisma.$transaction(
      env.data.rows.map((r) => {
        const d = ProductInput.parse(r);
        const { activeFrom, activeTo, ...rest } = d;
        return prisma.product.create({ data: { ...rest, activeFrom: activeFrom ?? null, activeTo: activeTo ?? null, createdById: req.user!.sub } });
      }),
    );
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.import', details: { count: created.length } });
    return reply.status(201).send({ ...result, valid, committed: true, created: created.length });
  });
}
