import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError } from '../lib/errors.js';

/**
 * The single catalog list.
 *
 * Historically the catalog lived in two places: `Product` (the rich record —
 * name, 4-tier category, dimensions, notes, manufacturer sourcing) and `Sku`
 * (the flat priced record the proposal engine multiplies against — part number,
 * unit price, unit cost, weight). Both are keyed by part number, so this route
 * joins them into ONE row per part and writes each edited field back to
 * whichever table owns it.
 */

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const ItemPatch = z.object({
  name: z.string().trim().min(1).max(400).optional(),
  category: z.string().trim().max(120).nullish(),
  manufacturer: z.string().trim().max(160).nullish(),
  unitPriceMinor: z.number().int().nonnegative().optional(),
  unitCostMinor: z.number().int().nonnegative().optional(),
  weightLbs: z.number().nonnegative().optional(),
  proposalGroup: z.string().trim().max(120).nullish(),
  active: z.boolean().optional(),
});

export interface CatalogItem {
  part: string;
  name: string;
  category: string;
  categoryOptions: boolean;
  manufacturer: string;
  unitPriceMinor: number;
  unitCostMinor: number;
  weightLbs: number;
  proposalGroup: string;
  active: boolean;
  skuId: string | null;
  productId: string | null;
  productStatus: string | null;
}

export function registerCatalogItemRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CATALOG_READ) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  app.get('/catalog/manufacturers', read, async () =>
    prisma.manufacturer.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, isThirdParty: true } }),
  );

  /** One row per part number, merged across Product and Sku. */
  app.get('/catalog/items', read, async (req) => {
    const { q = '', page = '1', pageSize = '100' } = req.query as Record<string, string>;
    const term = q.trim();
    const [skus, products, sourcing, cats] = await Promise.all([
      prisma.sku.findMany({ orderBy: { part: 'asc' } }),
      prisma.product.findMany({
        select: { id: true, sku: true, name: true, status: true, categoryId: true },
        orderBy: { sku: 'asc' },
      }),
      prisma.productSourcing.findMany({ select: { productId: true, manufacturer: { select: { name: true } } } }),
      prisma.productCategory.findMany({ select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }),
    ]);
    const catName: Record<string, string> = {};
    for (const c of cats) catName[c.id] = c.name;
    const mfrByProduct: Record<string, string> = {};
    for (const s of sourcing) if (s.manufacturer?.name && !mfrByProduct[s.productId]) mfrByProduct[s.productId] = s.manufacturer.name;

    const byPart = new Map<string, CatalogItem>();
    for (const s of skus) {
      byPart.set(s.part, {
        part: s.part, name: s.description, category: s.category || '', categoryOptions: false,
        manufacturer: s.manufacturer || '', unitPriceMinor: s.unitPriceMinor, unitCostMinor: s.unitCostMinor,
        weightLbs: s.weightLbs, proposalGroup: s.proposalGroup || '', active: s.active,
        skuId: s.id, productId: null, productStatus: null,
      });
    }
    for (const p of products) {
      const existing = byPart.get(p.sku);
      const productCategory = catName[p.categoryId] || '';
      const mfr = mfrByProduct[p.id] || '';
      if (existing) {
        // The Product record wins on name/category; the Sku record owns money.
        existing.name = p.name || existing.name;
        existing.category = productCategory || existing.category;
        existing.categoryOptions = true;
        existing.manufacturer = mfr || existing.manufacturer;
        existing.productId = p.id;
        existing.productStatus = p.status;
      } else {
        byPart.set(p.sku, {
          part: p.sku, name: p.name, category: productCategory, categoryOptions: true,
          manufacturer: mfr, unitPriceMinor: 0, unitCostMinor: 0, weightLbs: 0,
          proposalGroup: '', active: p.status === 'ACTIVE',
          skuId: null, productId: p.id, productStatus: p.status,
        });
      }
    }
    let items = [...byPart.values()];
    if (term) {
      const t = term.toLowerCase();
      items = items.filter((i) =>
        i.part.toLowerCase().includes(t) || i.name.toLowerCase().includes(t) ||
        i.category.toLowerCase().includes(t) || i.manufacturer.toLowerCase().includes(t));
    }
    items.sort((a, b) => a.part.localeCompare(b.part));
    const total = items.length;
    const pg = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 100));
    return { items: items.slice((pg - 1) * size, pg * size), total, page: pg, pageSize: size, categories: cats };
  });

  /**
   * Edit one merged row. Each field is written where it lives:
   *   name        -> Product.name when a Product exists, else Sku.description
   *   category    -> Product.categoryId (by name) when a Product exists, else Sku.category
   *   manufacturer-> ProductSourcing (creating the Manufacturer if new) + Sku.manufacturer
   *   price/cost/weight/group/active -> Sku (created on demand)
   */
  app.patch('/catalog/items/:part', admin, async (req) => {
    const { part } = req.params as { part: string };
    const parsed = ItemPatch.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid item');
    const d = parsed.data;

    const product = await prisma.product.findUnique({ where: { sku: part } });
    let sku = await prisma.sku.findUnique({ where: { part } });

    const needsSku = d.unitPriceMinor !== undefined || d.unitCostMinor !== undefined || d.weightLbs !== undefined ||
      d.proposalGroup !== undefined || d.active !== undefined || d.manufacturer !== undefined ||
      (d.name !== undefined && !product) || (d.category !== undefined && !product);
    if (!sku && needsSku) {
      sku = await prisma.sku.create({
        data: { part, description: d.name || product?.name || part, category: (!product && d.category) || 'OTHER' },
      });
    }

    if (d.name !== undefined) {
      if (product) await prisma.product.update({ where: { id: product.id }, data: { name: d.name } });
      if (sku) await prisma.sku.update({ where: { id: sku.id }, data: { description: d.name } });
    }

    if (d.category !== undefined) {
      if (product && d.category) {
        const cat = await prisma.productCategory.findFirst({ where: { name: d.category } });
        if (!cat) throw new ValidationError(`No product category named “${d.category}”`);
        await prisma.product.update({ where: { id: product.id }, data: { categoryId: cat.id } });
      } else if (sku) {
        await prisma.sku.update({ where: { id: sku.id }, data: { category: d.category || 'OTHER' } });
      }
    }

    if (d.manufacturer !== undefined) {
      const name = (d.manufacturer || '').trim();
      if (sku) await prisma.sku.update({ where: { id: sku.id }, data: { manufacturer: name || null } });
      if (product) {
        if (!name) {
          await prisma.productSourcing.deleteMany({ where: { productId: product.id } });
        } else {
          let mfr = await prisma.manufacturer.findFirst({ where: { name } });
          if (!mfr) mfr = await prisma.manufacturer.create({ data: { name, slug: slugify(name) } });
          const existing = await prisma.productSourcing.findFirst({ where: { productId: product.id } });
          if (existing) await prisma.productSourcing.update({ where: { id: existing.id }, data: { manufacturerId: mfr.id } });
          else await prisma.productSourcing.create({ data: { productId: product.id, manufacturerId: mfr.id } });
        }
      }
    }

    if (sku) {
      const money: Record<string, unknown> = {};
      if (d.unitPriceMinor !== undefined) money.unitPriceMinor = d.unitPriceMinor;
      if (d.unitCostMinor !== undefined) money.unitCostMinor = d.unitCostMinor;
      if (d.weightLbs !== undefined) money.weightLbs = d.weightLbs;
      if (d.proposalGroup !== undefined) money.proposalGroup = d.proposalGroup || null;
      if (d.active !== undefined) money.active = d.active;
      if (Object.keys(money).length) await prisma.sku.update({ where: { id: sku.id }, data: money });
    }

    await recordAudit({ actorId: req.user!.sub, action: 'catalog.item.update', entity: 'Sku', entityId: part, details: d as object });
    return { ok: true, part };
  });
}
