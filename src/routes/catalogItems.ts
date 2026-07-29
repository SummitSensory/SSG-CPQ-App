import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, ConflictError, NotFoundError } from '../lib/errors.js';

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

/**
 * `overrideAllowed` arrived in migration 0024. Read it optionally so the catalog
 * still loads if the code is deployed before the migration — a missing column
 * degrades to "nothing is overridable" rather than a P2022 on the whole list.
 */
let skuHasOverrideFlag = true;
const SKU_COLS = {
  id: true, part: true, description: true, category: true, manufacturer: true,
  unitPriceMinor: true, unitCostMinor: true, weightLbs: true, proposalGroup: true, active: true,
} as const;
type SkuRow = {
  id: string; part: string; description: string; category: string | null; manufacturer: string | null;
  unitPriceMinor: number; unitCostMinor: number; weightLbs: number; proposalGroup: string | null;
  active: boolean; overrideAllowed?: boolean; defaultQty?: number | null;
};
async function listSkus(): Promise<SkuRow[]> {
  if (skuHasOverrideFlag) {
    try {
      return await prisma.sku.findMany({ select: { ...SKU_COLS, overrideAllowed: true, defaultQty: true }, orderBy: { part: 'asc' } }) as SkuRow[];
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2022') throw e;
      skuHasOverrideFlag = false;
    }
  }
  return await prisma.sku.findMany({ select: SKU_COLS, orderBy: { part: 'asc' } }) as SkuRow[];
}

const ItemPatch = z.object({
  name: z.string().trim().min(1).max(400).optional(),
  category: z.string().trim().max(120).nullish(),
  manufacturer: z.string().trim().max(160).nullish(),
  unitPriceMinor: z.number().int().nonnegative().optional(),
  unitCostMinor: z.number().int().nonnegative().optional(),
  weightLbs: z.number().nonnegative().optional(),
  proposalGroup: z.string().trim().max(120).nullish(),
  active: z.boolean().optional(),
  overrideAllowed: z.boolean().optional(),
  defaultQty: z.number().int().min(0).max(9999).nullable().optional(),
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
  /** Pre-approved for part-number substitution in the Adventure Series builder. */
  overrideAllowed: boolean;
  /** Builder default quantity; null = no default, so the field starts at 0. */
  defaultQty: number | null;
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
    const [skus, products, sourcing, cats, costs] = await Promise.all([
      listSkus(),
      prisma.product.findMany({
        select: { id: true, sku: true, name: true, status: true, categoryId: true, weightOz: true },
        orderBy: { sku: 'asc' },
      }),
      prisma.productSourcing.findMany({ select: { productId: true, manufacturer: { select: { name: true } } } }),
      prisma.productCategory.findMany({ select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }),
      // Dated cost history from the product workbook import — the fallback when the
      // flat Sku row has no cost of its own.
      prisma.productCost.findMany({ select: { productId: true, unitCost: true, effectiveDate: true }, orderBy: { effectiveDate: 'desc' } }),
    ]);
    const latestCost: Record<string, number> = {};
    for (const c of costs) if (latestCost[c.productId] === undefined) latestCost[c.productId] = Number(c.unitCost);
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
        overrideAllowed: s.overrideAllowed === true,
        defaultQty: s.defaultQty ?? null,
        skuId: s.id, productId: null, productStatus: null,
      });
    }
    for (const p of products) {
      const existing = byPart.get(p.sku);
      const productCategory = catName[p.categoryId] || '';
      const mfr = mfrByProduct[p.id] || '';
      if (existing) {
        // The Product record wins on name/category; the Sku record owns money,
        // falling back to the workbook's cost history and ounce weight.
        existing.name = p.name || existing.name;
        existing.category = productCategory || existing.category;
        existing.categoryOptions = true;
        existing.manufacturer = mfr || existing.manufacturer;
        const cost = latestCost[p.id];
        if (!existing.unitCostMinor && cost) existing.unitCostMinor = cost;
        if (!existing.weightLbs && p.weightOz) existing.weightLbs = Math.round((p.weightOz / 16) * 1000) / 1000;
        existing.productId = p.id;
        existing.productStatus = p.status;
      } else {
        byPart.set(p.sku, {
          part: p.sku, name: p.name, category: productCategory, categoryOptions: true,
          manufacturer: mfr, unitPriceMinor: 0, unitCostMinor: latestCost[p.id] || 0,
          weightLbs: p.weightOz ? Math.round((p.weightOz / 16) * 1000) / 1000 : 0,
          proposalGroup: '', active: p.status === 'ACTIVE', overrideAllowed: false, defaultQty: null,
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
      d.overrideAllowed !== undefined || d.defaultQty !== undefined ||
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
      if (d.overrideAllowed !== undefined) money.overrideAllowed = d.overrideAllowed;
      if (d.defaultQty !== undefined) money.defaultQty = d.defaultQty;
      if (Object.keys(money).length) await prisma.sku.update({ where: { id: sku.id }, data: money });
    }

    // A cost edit also lands in the dated cost history, so pricing/service.ts and
    // the workbook's cost trail stay in step with the flat SKU record.
    if (d.unitCostMinor !== undefined && product) {
      await prisma.productCost.create({
        data: {
          productId: product.id, unitCost: BigInt(d.unitCostMinor), currency: 'USD',
          effectiveDate: new Date(), createdById: req.user!.sub,
        },
      });
    }

    await recordAudit({ actorId: req.user!.sub, action: 'catalog.item.update', entity: 'Sku', entityId: part, details: d as Record<string, unknown> });
    return { ok: true, part };
  });

  /**
   * How many saved proposals reference this part. Proposal items are JSON, so this
   * scans them — the volume is small and the answer is what makes a delete safe.
   */
  async function proposalUsage(part: string): Promise<{ count: number; numbers: string[] }> {
    const versions = await prisma.proposalVersion.findMany({
      select: { items: true, proposal: { select: { number: true } } },
    });
    const numbers = new Set<string>();
    for (const v of versions) {
      const items = Array.isArray(v.items) ? (v.items as { sku?: string; name?: string }[]) : [];
      if (items.some((i) => i && (i.sku === part || i.name === part))) numbers.add(v.proposal.number);
    }
    return { count: numbers.size, numbers: [...numbers].slice(0, 5) };
  }

  /** What deleting this part would remove, and whether it is safe. */
  app.get('/catalog/items/:part/usage', read, async (req) => {
    const { part } = req.params as { part: string };
    const [product, sku, usage] = await Promise.all([
      prisma.product.findUnique({ where: { sku: part }, select: { id: true, status: true } }),
      prisma.sku.findUnique({ where: { part }, select: { id: true, active: true } }),
      proposalUsage(part),
    ]);
    const everActive = product
      ? (await prisma.productStatusHistory.count({ where: { productId: product.id, toStatus: 'ACTIVE' } })) > 0
      : false;
    return {
      part,
      hasProduct: !!product, hasSku: !!sku,
      productStatus: product?.status ?? null, active: sku ? sku.active : product?.status === 'ACTIVE',
      proposalCount: usage.count, proposalNumbers: usage.numbers,
      deletable: usage.count === 0 && !everActive,
      reason: usage.count > 0
        ? `Used on ${usage.count} proposal${usage.count === 1 ? '' : 's'} (${usage.numbers.join(', ')}${usage.count > usage.numbers.length ? '…' : ''}) — deactivate it instead so historical proposals keep their pricing.`
        : everActive ? 'This product has been active, so its history is kept — deactivate or archive it instead.' : null,
    };
  });

  /**
   * Delete a catalog part outright — both the Product record and the flat Sku row.
   * Refused when a proposal references the part or the product was ever ACTIVE:
   * deleting then would silently change historical documents. Deactivate instead.
   */
  app.delete('/catalog/items/:part', admin, async (req, reply) => {
    const { part } = req.params as { part: string };
    const [product, sku, usage] = await Promise.all([
      prisma.product.findUnique({ where: { sku: part } }),
      prisma.sku.findUnique({ where: { part } }),
      proposalUsage(part),
    ]);
    if (!product && !sku) throw new NotFoundError('No catalog part with that number');
    if (usage.count > 0) {
      throw new ConflictError(`“${part}” is used on ${usage.count} proposal${usage.count === 1 ? '' : 's'} (${usage.numbers.join(', ')}). Deactivate it instead — deleting would change what those proposals priced.`);
    }
    if (product) {
      const everActive = await prisma.productStatusHistory.count({ where: { productId: product.id, toStatus: 'ACTIVE' } });
      if (everActive > 0) throw new ConflictError(`“${part}” has been an active product, so its record is kept for history. Archive or deactivate it instead.`);
    }
    await prisma.$transaction(async (tx) => {
      if (sku) await tx.sku.delete({ where: { id: sku.id } });
      if (product) {
        await tx.productCost.deleteMany({ where: { productId: product.id } });
        await tx.productSourcing.deleteMany({ where: { productId: product.id } });
        await tx.product.delete({ where: { id: product.id } });
      }
    });
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.item.delete', entity: 'Sku', entityId: part, details: { hadProduct: !!product, hadSku: !!sku } });
    reply.code(204);
    return null;
  });

  /**
   * Deactivate / reactivate a part in one call: the flat Sku row's `active` flag and
   * the Product status workflow move together, so an inactive part stops being
   * offered in the builder while every existing proposal keeps its pricing.
   */
  app.post('/catalog/items/:part/active', admin, async (req) => {
    const { part } = req.params as { part: string };
    const body = (req.body || {}) as { active?: boolean };
    if (typeof body.active !== 'boolean') throw new ValidationError('active must be true or false');
    const [product, sku] = await Promise.all([
      prisma.product.findUnique({ where: { sku: part } }),
      prisma.sku.findUnique({ where: { part } }),
    ]);
    if (!product && !sku) throw new NotFoundError('No catalog part with that number');
    if (sku) await prisma.sku.update({ where: { id: sku.id }, data: { active: body.active } });
    if (product) {
      const to = body.active ? 'ACTIVE' : 'INACTIVE';
      if (product.status !== to) {
        await prisma.product.update({ where: { id: product.id }, data: { status: to } });
        await prisma.productStatusHistory.create({
          data: { productId: product.id, fromStatus: product.status, toStatus: to, reason: 'catalog list', changedById: req.user!.sub },
        });
      }
    }
    await recordAudit({ actorId: req.user!.sub, action: body.active ? 'catalog.item.activate' : 'catalog.item.deactivate', entity: 'Sku', entityId: part });
    return { part, active: body.active };
  });
}
