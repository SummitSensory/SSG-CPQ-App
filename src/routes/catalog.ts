import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { recordAudit } from '../lib/audit.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError, ConflictError, NotFoundError } from '../lib/errors.js';
import {
  CategoryInput,
  FamilyInput,
  ProductInput,
  ProductLineInput,
  ProductLineUpdate,
  StatusEnum,
} from '../catalog/validation.js';
import { validateImportBatch, ImportEnvelope } from '../catalog/import.js';
import { changeStatus, assertDeletable, resolveCategoryTier } from '../catalog/service.js';
import { formatDimensions } from '../catalog/dimensions.js';
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

    const { parentId, productLineId, tierLevel, productId, ...rest } = parsed.data;
    const parent = parentId
      ? await prisma.productCategory.findUnique({ where: { id: parentId } })
      : null;
    if (parentId && !parent) throw new ValidationError('Parent category not found');
    const resolved = resolveCategoryTier({ tierLevel, productLineId, productId }, parent);

    if (resolved.productLineId) {
      const line = await prisma.productLine.findUnique({ where: { id: resolved.productLineId } });
      if (!line) throw new ValidationError('Product line not found');
    }
    if (productId) {
      const product = await prisma.product.findUnique({ where: { id: productId } });
      if (!product) throw new ValidationError('Product not found');
    }

    const cat = await prisma.productCategory.create({
      data: {
        ...rest,
        parentId: parentId ?? null,
        productLineId: resolved.productLineId,
        tierLevel: resolved.tierLevel,
        productId: productId ?? null,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.category.create',
      entity: 'ProductCategory',
      entityId: cat.id,
    });
    return reply.status(201).send(cat);
  });

  // ----- Product lines -----
  app.get('/catalog/product-lines', read, async () =>
    prisma.productLine.findMany({ orderBy: { sortOrder: 'asc' } }),
  );

  app.get('/catalog/product-lines/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    const line = await prisma.productLine.findUnique({ where: { id } });
    if (!line) throw new NotFoundError();
    return line;
  });

  app.post('/catalog/product-lines', admin, async (req, reply) => {
    const parsed = ProductLineInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const exists = await prisma.productLine.findUnique({ where: { slug: parsed.data.slug } });
    if (exists) throw new ConflictError('Product line slug already exists');
    const line = await prisma.productLine.create({ data: parsed.data });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.product-line.create',
      entity: 'ProductLine',
      entityId: line.id,
    });
    return reply.status(201).send(line);
  });

  app.patch('/catalog/product-lines/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ProductLineUpdate.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const existing = await prisma.productLine.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError();
    if (parsed.data.slug && parsed.data.slug !== existing.slug) {
      const dupe = await prisma.productLine.findUnique({ where: { slug: parsed.data.slug } });
      if (dupe) throw new ConflictError('Product line slug already exists');
    }
    const line = await prisma.productLine.update({ where: { id }, data: parsed.data });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.product-line.update',
      entity: 'ProductLine',
      entityId: id,
    });
    return line;
  });

  app.delete('/catalog/product-lines/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.productLine.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError();
    await prisma.productLine.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.product-line.delete',
      entity: 'ProductLine',
      entityId: id,
    });
    return reply.status(204).send();
  });

  // The fully nested tier tree for one product line: headers (no product) and
  // product rows, each product resolving its notes, badge, quantity, price
  // (matched against the pricing Sku by part == sku) and formatted dimensions.
  app.get('/catalog/product-lines/:id/tree', read, async (req) => {
    const { id } = req.params as { id: string };
    const line = await prisma.productLine.findUnique({ where: { id } });
    if (!line) throw new NotFoundError();

    const categories = await prisma.productCategory.findMany({
      where: { productLineId: id },
      include: { product: { include: { notes: { orderBy: { sortOrder: 'asc' } } } } },
    });
    const parts = categories.map((c) => c.product?.sku).filter((s): s is string => Boolean(s));
    const skus = parts.length ? await prisma.sku.findMany({ where: { part: { in: parts } } }) : [];
    const priceByPart = new Map(skus.map((s) => [s.part, s.unitPriceMinor]));

    type Cat = (typeof categories)[number];
    function toNode(cat: Cat): Record<string, unknown> {
      const children = categories
        .filter((c) => c.parentId === cat.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(toNode);
      return {
        id: cat.id,
        name: cat.name,
        tierLevel: cat.tierLevel,
        sortOrder: cat.sortOrder,
        product: cat.product
          ? {
              id: cat.product.id,
              sku: cat.product.sku,
              name: cat.product.name,
              defaultQuantity: cat.product.defaultQuantity,
              badge: cat.product.badge,
              unitPriceMinor: priceByPart.get(cat.product.sku) ?? null,
              showDimensions: cat.product.showDimensions,
              dimensions: formatDimensions(cat.product),
              notes: cat.product.notes.map((n) => ({
                id: n.id,
                text: n.text,
                sortOrder: n.sortOrder,
              })),
            }
          : null,
        children,
      };
    }

    const tree = categories
      .filter((c) => c.parentId === null)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(toNode);
    return { id: line.id, name: line.name, slug: line.slug, tree };
  });

  app.post('/catalog/families', admin, async (req, reply) => {
    const parsed = FamilyInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const family = await prisma.productFamily.create({ data: parsed.data }).catch(() => {
      throw new ConflictError('Family slug already exists in this category');
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.family.create',
      entity: 'ProductFamily',
      entityId: family.id,
    });
    return reply.status(201).send(family);
  });

  // ----- Products -----
  app.get('/catalog/categories', read, async () =>
    prisma.productCategory.findMany({ orderBy: { sortOrder: 'asc' } }),
  );

  app.get('/catalog/families', read, async (req) => {
    const { categoryId } = req.query as { categoryId?: string };
    return prisma.productFamily.findMany({
      where: categoryId ? { categoryId } : {},
      orderBy: { name: 'asc' },
    });
  });

  app.get('/catalog/products', read, async (req) => {
    const p = ListQuery.parse(req.query);
    const f = req.query as {
      status?: string;
      kind?: string;
      categoryId?: string;
      productLineId?: string;
    };
    const where = {
      ...(p.q
        ? {
            OR: [
              { name: { contains: p.q, mode: 'insensitive' as const } },
              { sku: { contains: p.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(f.status ? { status: f.status as never } : {}),
      ...(f.kind ? { kind: f.kind as never } : {}),
      ...(f.categoryId ? { categoryId: f.categoryId } : {}),
      ...(f.productLineId ? { productLineId: f.productLineId } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: buildOrderBy(p.sort, p.dir, PRODUCT_SORT, 'createdAt'),
        ...paginate(p.page, p.pageSize),
      }),
      prisma.product.count({ where }),
    ]);
    return { items, total, page: p.page, pageSize: p.pageSize };
  });

  app.post('/catalog/products', admin, async (req, reply) => {
    const parsed = ProductInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const dupe = await prisma.product.findUnique({ where: { sku: parsed.data.sku } });
    if (dupe) throw new ConflictError('SKU already exists');
    const { activeFrom, activeTo, notes, ...rest } = parsed.data;
    const product = await prisma.product.create({
      data: {
        ...rest,
        activeFrom: activeFrom ?? null,
        activeTo: activeTo ?? null,
        createdById: req.user!.sub,
        notes: { create: notes.map((n, i) => ({ text: n.text, sortOrder: i })) },
      },
    });
    await prisma.productVersion.create({
      data: {
        productId: product.id,
        version: 1,
        snapshot: parsed.data as object,
        changedById: req.user!.sub,
        changeNote: 'created',
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.product.create',
      entity: 'Product',
      entityId: product.id,
    });
    return reply.status(201).send(product);
  });

  app.get('/catalog/products/:id/versions', read, async (req) => {
    const { id } = req.params as { id: string };
    return prisma.productVersion.findMany({
      where: { productId: id },
      orderBy: { version: 'desc' },
    });
  });

  app.patch('/catalog/products/:id/status', admin, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { status?: string; reason?: string };
    const parsed = StatusEnum.safeParse(body.status);
    if (!parsed.success) throw new ValidationError('invalid status');
    const product = await changeStatus(id, parsed.data, req.user!.sub, body.reason);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.product.status',
      entity: 'Product',
      entityId: id,
      details: { to: parsed.data },
    });
    return product;
  });

  // Hard delete is guarded; ever-active or referenced products must be archived.
  app.delete('/catalog/products/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundError();
    await assertDeletable(id);
    await prisma.product.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.product.delete',
      entity: 'Product',
      entityId: id,
    });
    return reply.status(204).send();
  });

  // ----- Import (validate first; dry-run by default) -----
  app.post('/catalog/import', admin, async (req, reply) => {
    const env = ImportEnvelope.safeParse(req.body);
    if (!env.success) throw new ValidationError(env.error.message);
    const result = validateImportBatch(env.data.rows);

    // DB-level duplicate prevention across the whole catalog.
    const skus = env.data.rows.map((r) => (r as { sku?: string }).sku).filter(Boolean) as string[];
    const existing = await prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true },
    });
    for (const e of existing) {
      result.issues.push({
        row: 0,
        field: 'sku',
        message: `SKU already exists in catalog: ${e.sku}`,
      });
    }
    const valid = result.issues.length === 0;

    if (env.data.dryRun || !valid) {
      return reply.status(valid ? 200 : 422).send({ ...result, valid, committed: false });
    }
    // Commit valid rows.
    const created = await prisma.$transaction(
      env.data.rows.map((r) => {
        const d = ProductInput.parse(r);
        const { activeFrom, activeTo, notes, ...rest } = d;
        return prisma.product.create({
          data: {
            ...rest,
            activeFrom: activeFrom ?? null,
            activeTo: activeTo ?? null,
            createdById: req.user!.sub,
            notes: { create: notes.map((n, i) => ({ text: n.text, sortOrder: i })) },
          },
        });
      }),
    );
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.import',
      details: { count: created.length },
    });
    return reply.status(201).send({ ...result, valid, committed: true, created: created.length });
  });
}
