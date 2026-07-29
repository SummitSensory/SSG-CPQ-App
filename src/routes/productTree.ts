import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, ConflictError, NotFoundError } from '../lib/errors.js';

/**
 * The product tree: category names, the order things appear in, and a round-trip
 * export/import of the whole structure.
 *
 * The tree is what the proposal builder reads, so two rules hold throughout:
 *   * renaming a category never moves a product — the id is the identity, the
 *     name is only a label;
 *   * ordering is explicit (`sortOrder`), never derived from insertion order, so
 *     "reorder the default product list" survives every later edit.
 *
 * Import is deliberately partial: only the columns present in the file are
 * written, and parts absent from the file are reported back rather than touched.
 * The caller decides what to do about them.
 */

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const CategoryPatch = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
  parentId: z.string().nullish(),
  tierLevel: z.number().int().min(1).max(4).optional(),
  productLineId: z.string().nullish(),
});

const Reorder = z.object({ ids: z.array(z.string().min(1)).min(1) });

const ImportBody = z.object({
  dryRun: z.boolean().default(true),
  missingAction: z.enum(['leave', 'deactivate']).default('leave'),
  categories: z.array(z.object({
    slug: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    parentSlug: z.string().trim().nullish(),
    tierLevel: z.coerce.number().int().min(1).max(4).optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.coerce.boolean().optional(),
  })).default([]),
  products: z.array(z.object({
    sku: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    categorySlug: z.string().trim().optional(),
    kind: z.string().trim().optional(),
    status: z.string().trim().optional(),
    sortOrder: z.coerce.number().int().optional(),
    proposalDescription: z.string().optional(),
  })).default([]),
  bundles: z.array(z.object({
    bundleSku: z.string().trim().min(1),
    componentSku: z.string().trim().min(1),
    quantity: z.coerce.number().int().min(1).default(1),
  })).default([]),
});

const KINDS = ['PRODUCT', 'VARIANT', 'COMPONENT', 'BUNDLE', 'ACCESSORY', 'SERVICE', 'FREIGHT'];
const STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'];

export function registerProductTreeRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CATALOG_READ) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  // ---------- Rename / reposition a category ----------
  app.patch('/catalog/categories/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = CategoryPatch.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid category');
    const current = await prisma.productCategory.findUnique({ where: { id } });
    if (!current) throw new NotFoundError('Category not found');
    const d = parsed.data;

    // A category cannot become its own ancestor, or the tree stops terminating.
    if (d.parentId) {
      let walk: string | null = d.parentId;
      const seen = new Set<string>([id]);
      while (walk) {
        if (seen.has(walk)) throw new ConflictError('That would make the category its own parent');
        seen.add(walk);
        const p: { parentId: string | null } | null = await prisma.productCategory.findUnique({ where: { id: walk }, select: { parentId: true } });
        walk = p?.parentId ?? null;
      }
    }
    const cat = await prisma.productCategory.update({
      where: { id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
        ...(d.isActive !== undefined ? { isActive: d.isActive } : {}),
        ...(d.parentId !== undefined ? { parentId: d.parentId || null } : {}),
        ...(d.tierLevel !== undefined ? { tierLevel: d.tierLevel } : {}),
        ...(d.productLineId !== undefined ? { productLineId: d.productLineId || null } : {}),
      },
    });
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.category.update', entity: 'ProductCategory', entityId: id, details: { from: current.name, ...d } as Record<string, unknown> });
    return cat;
  });

  app.delete('/catalog/categories/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [cat, products, children] = await Promise.all([
      prisma.productCategory.findUnique({ where: { id } }),
      prisma.product.count({ where: { categoryId: id } }),
      prisma.productCategory.count({ where: { parentId: id } }),
    ]);
    if (!cat) throw new NotFoundError('Category not found');
    if (products || children) {
      throw new ConflictError(`“${cat.name}” holds ${products} product(s) and ${children} sub-categor(y/ies). Move or delete those first, or hide the category instead.`);
    }
    await prisma.productCategory.delete({ where: { id } });
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.category.delete', entity: 'ProductCategory', entityId: id, details: { name: cat.name } });
    reply.code(204);
    return null;
  });

  // ---------- Explicit ordering ----------
  /** Categories, in the order the ids arrive. Siblings only — pass one level. */
  app.post('/catalog/categories/reorder', admin, async (req) => {
    const parsed = Reorder.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('ids are required');
    await prisma.$transaction(parsed.data.ids.map((id, i) => prisma.productCategory.update({ where: { id }, data: { sortOrder: i } })));
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.category.reorder', details: { count: parsed.data.ids.length } });
    return { ok: true, count: parsed.data.ids.length };
  });

  /**
   * The default product list order, used by the product picker and the tier
   * listings. Ids arrive in display order; everything else keeps its place.
   */
  app.post('/catalog/products/reorder', admin, async (req) => {
    const parsed = Reorder.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('ids are required');
    await prisma.$transaction(parsed.data.ids.map((id, i) => prisma.product.update({ where: { id }, data: { sortOrder: i } })));
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.product.reorder', details: { count: parsed.data.ids.length } });
    return { ok: true, count: parsed.data.ids.length };
  });

  // ---------- Round-trip export ----------
  /**
   * The whole tree as plain rows — one array per workbook sheet. The client turns
   * this into the .xls workbook and parses the same shape back on import, so an
   * exported file always re-imports cleanly.
   */
  app.get('/catalog/tree/export', read, async () => {
    const [lines, cats, products, relations] = await Promise.all([
      prisma.productLine.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, slug: true, sortOrder: true, isActive: true } }),
      prisma.productCategory.findMany({ orderBy: [{ tierLevel: 'asc' }, { sortOrder: 'asc' }] }),
      prisma.product.findMany({
        orderBy: [{ sortOrder: 'asc' }, { sku: 'asc' }],
        select: { id: true, sku: true, name: true, kind: true, status: true, sortOrder: true, categoryId: true, proposalDescription: true },
      }),
      prisma.productRelation.findMany({
        where: { type: 'BUNDLE_ITEM' },
        orderBy: { sortOrder: 'asc' },
        select: { quantity: true, parent: { select: { sku: true, name: true } }, child: { select: { sku: true, name: true } } },
      }),
    ]);
    const slugOf = new Map(cats.map((c) => [c.id, c.slug]));
    return {
      exportedAt: new Date().toISOString(),
      productLines: lines,
      categories: cats.map((c) => ({
        slug: c.slug, name: c.name, tierLevel: c.tierLevel, sortOrder: c.sortOrder, isActive: c.isActive,
        parentSlug: c.parentId ? slugOf.get(c.parentId) ?? '' : '',
        productLineId: c.productLineId ?? '',
      })),
      products: products.map((p) => ({
        sku: p.sku, name: p.name, kind: p.kind, status: p.status, sortOrder: p.sortOrder,
        categorySlug: slugOf.get(p.categoryId) ?? '', proposalDescription: p.proposalDescription ?? '',
      })),
      bundles: relations.map((r) => ({
        bundleSku: r.parent.sku, bundleName: r.parent.name,
        componentSku: r.child.sku, componentName: r.child.name, quantity: r.quantity,
      })),
    };
  });

  // ---------- Import (validate, review, then commit) ----------
  /**
   * Partial upsert of the tree. Only columns present in a row are written, so a
   * sheet that carries just `sku` and `sortOrder` reorders the list and changes
   * nothing else. Categories are matched on slug, products on part number.
   *
   * Nothing is deleted, ever. Parts in the catalog but absent from the file come
   * back as `missing` for the operator to review; `missingAction: 'deactivate'`
   * is the only thing that acts on them, and only when explicitly asked for.
   */
  app.post('/catalog/tree/import', admin, async (req, reply) => {
    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid import');
    const d = parsed.data;
    const issues: { sheet: string; key: string; message: string }[] = [];

    const [existingCats, existingProducts] = await Promise.all([
      prisma.productCategory.findMany({ select: { id: true, slug: true, name: true, sortOrder: true, tierLevel: true, parentId: true } }),
      prisma.product.findMany({ select: { id: true, sku: true, name: true, status: true, sortOrder: true, categoryId: true } }),
    ]);
    const catBySlug = new Map(existingCats.map((c) => [c.slug, c]));
    const prodBySku = new Map(existingProducts.map((p) => [p.sku, p]));
    const fileCatSlugs = new Set(d.categories.map((c) => c.slug));

    for (const c of d.categories) {
      if (c.parentSlug && !catBySlug.has(c.parentSlug) && !fileCatSlugs.has(c.parentSlug)) {
        issues.push({ sheet: 'Categories', key: c.slug, message: `parent “${c.parentSlug}” is not in the catalog or the file` });
      }
      if (!catBySlug.has(c.slug) && !c.name) issues.push({ sheet: 'Categories', key: c.slug, message: 'new category needs a name' });
    }
    for (const p of d.products) {
      if (p.kind && !KINDS.includes(p.kind.toUpperCase())) issues.push({ sheet: 'Products', key: p.sku, message: `unknown kind “${p.kind}”` });
      if (p.status && !STATUSES.includes(p.status.toUpperCase())) issues.push({ sheet: 'Products', key: p.sku, message: `unknown status “${p.status}”` });
      if (p.categorySlug && !catBySlug.has(p.categorySlug) && !fileCatSlugs.has(p.categorySlug)) {
        issues.push({ sheet: 'Products', key: p.sku, message: `category “${p.categorySlug}” is not in the catalog or the file` });
      }
      if (!prodBySku.has(p.sku)) {
        if (!p.name) issues.push({ sheet: 'Products', key: p.sku, message: 'new part needs a name' });
        if (!p.categorySlug) issues.push({ sheet: 'Products', key: p.sku, message: 'new part needs a category' });
      }
    }
    for (const b of d.bundles) {
      if (!prodBySku.has(b.bundleSku) && !d.products.some((p) => p.sku === b.bundleSku)) {
        issues.push({ sheet: 'Bundles', key: b.bundleSku, message: 'bundle part number is not in the catalog or the file' });
      }
      if (!prodBySku.has(b.componentSku) && !d.products.some((p) => p.sku === b.componentSku)) {
        issues.push({ sheet: 'Bundles', key: b.componentSku, message: 'component part number is not in the catalog or the file' });
      }
      if (b.bundleSku === b.componentSku) issues.push({ sheet: 'Bundles', key: b.bundleSku, message: 'a bundle cannot contain itself' });
    }

    const missing = existingProducts
      .filter((p) => !d.products.some((x) => x.sku === p.sku) && p.status !== 'ARCHIVED')
      .map((p) => ({ sku: p.sku, name: p.name, status: p.status }));

    const plan = {
      categories: { create: d.categories.filter((c) => !catBySlug.has(c.slug)).length, update: d.categories.filter((c) => catBySlug.has(c.slug)).length },
      products: { create: d.products.filter((p) => !prodBySku.has(p.sku)).length, update: d.products.filter((p) => prodBySku.has(p.sku)).length },
      bundles: { links: d.bundles.length },
      missing,
    };
    if (d.dryRun || issues.length) {
      return reply.status(issues.length ? 422 : 200).send({ valid: issues.length === 0, committed: false, issues, plan });
    }

    // ---- commit ----
    // Categories first (two passes: rows, then parents, so order in the file
    // never matters), then products, then bundle links.
    for (const c of d.categories) {
      const existing = catBySlug.get(c.slug);
      if (existing) {
        await prisma.productCategory.update({
          where: { id: existing.id },
          data: {
            ...(c.name !== undefined ? { name: c.name } : {}),
            ...(c.tierLevel !== undefined ? { tierLevel: c.tierLevel } : {}),
            ...(c.sortOrder !== undefined ? { sortOrder: c.sortOrder } : {}),
            ...(c.isActive !== undefined ? { isActive: c.isActive } : {}),
          },
        });
      } else {
        const created = await prisma.productCategory.create({
          data: {
            slug: c.slug || slugify(c.name as string), name: c.name as string,
            tierLevel: c.tierLevel ?? 1, sortOrder: c.sortOrder ?? 0, isActive: c.isActive ?? true,
          },
        });
        catBySlug.set(created.slug, { id: created.id, slug: created.slug, name: created.name, sortOrder: created.sortOrder, tierLevel: created.tierLevel, parentId: created.parentId });
      }
    }
    for (const c of d.categories) {
      if (c.parentSlug === undefined) continue;
      const self = catBySlug.get(c.slug);
      const parent = c.parentSlug ? catBySlug.get(c.parentSlug) : null;
      if (self) await prisma.productCategory.update({ where: { id: self.id }, data: { parentId: parent?.id ?? null } });
    }

    let created = 0, updated = 0;
    for (const p of d.products) {
      const existing = prodBySku.get(p.sku);
      const catId = p.categorySlug ? catBySlug.get(p.categorySlug)?.id : undefined;
      if (existing) {
        await prisma.product.update({
          where: { id: existing.id },
          data: {
            ...(p.name !== undefined ? { name: p.name } : {}),
            ...(catId ? { categoryId: catId } : {}),
            ...(p.kind ? { kind: p.kind.toUpperCase() as never } : {}),
            ...(p.status ? { status: p.status.toUpperCase() as never } : {}),
            ...(p.sortOrder !== undefined ? { sortOrder: p.sortOrder } : {}),
            ...(p.proposalDescription !== undefined ? { proposalDescription: p.proposalDescription || null } : {}),
          },
        });
        updated++;
      } else {
        const np = await prisma.product.create({
          data: {
            sku: p.sku, name: p.name as string, categoryId: catId as string,
            kind: (p.kind ? p.kind.toUpperCase() : 'PRODUCT') as never,
            status: (p.status ? p.status.toUpperCase() : 'DRAFT') as never,
            sortOrder: p.sortOrder ?? 0, proposalDescription: p.proposalDescription || null,
            createdById: req.user!.sub,
          },
        });
        prodBySku.set(np.sku, { id: np.id, sku: np.sku, name: np.name, status: np.status, sortOrder: np.sortOrder, categoryId: np.categoryId });
        created++;
      }
    }

    let links = 0;
    for (const b of d.bundles) {
      const parent = prodBySku.get(b.bundleSku), child = prodBySku.get(b.componentSku);
      if (!parent || !child) continue;
      const existing = await prisma.productRelation.findFirst({ where: { parentId: parent.id, childId: child.id, type: 'BUNDLE_ITEM' } });
      if (existing) await prisma.productRelation.update({ where: { id: existing.id }, data: { quantity: b.quantity } });
      else await prisma.productRelation.create({ data: { parentId: parent.id, childId: child.id, type: 'BUNDLE_ITEM', quantity: b.quantity, sortOrder: links } });
      links++;
    }

    let deactivated = 0;
    if (d.missingAction === 'deactivate') {
      for (const m of missing) {
        const p = prodBySku.get(m.sku);
        if (!p || p.status === 'INACTIVE') continue;
        await prisma.product.update({ where: { id: p.id }, data: { status: 'INACTIVE' } });
        await prisma.productStatusHistory.create({
          data: { productId: p.id, fromStatus: p.status as never, toStatus: 'INACTIVE', reason: 'absent from tree import', changedById: req.user!.sub },
        });
        await prisma.sku.updateMany({ where: { part: m.sku }, data: { active: false } });
        deactivated++;
      }
    }

    await recordAudit({ actorId: req.user!.sub, action: 'catalog.tree.import', details: { created, updated, links, deactivated } });
    return reply.status(200).send({ valid: true, committed: true, issues: [], plan, result: { created, updated, links, deactivated } });
  });
}
