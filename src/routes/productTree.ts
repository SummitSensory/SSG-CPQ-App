import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, ConflictError, NotFoundError } from '../lib/errors.js';
import { syncPartSourcing } from '../catalog/partVendor.js';
import {
  canTransition,
  changeStatusTx,
  deriveTiers,
  descendantIds,
  recordCreatedStatus,
  resolveCategoryTier,
  wouldCreateCycle,
} from '../catalog/service.js';
import type { ProductKind, ProductStatus } from '@prisma/client';

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

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const CategoryPatch = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
  parentId: z.string().nullish(),
  tierLevel: z.number().int().min(1).max(4).optional(),
  productLineId: z.string().nullish(),
});

const Reorder = z.object({ ids: z.array(z.string().min(1)).min(1) });

/**
 * A money cell from the workbook, as minor units.
 *
 * The sheet holds DOLLARS, because a person edits it in Excel: 327.00, not 32700. Excel
 * hands back a string, sometimes with a currency symbol or thousands separators, so those
 * are stripped before parsing.
 *
 * `undefined` means the cell was blank, which means "leave this alone" — NOT zero. The
 * client already drops blank cells from the payload (`pruneBlanks`), and this mirrors that
 * on the server so a half-filled sheet cannot wipe prices that are already correct. That
 * distinction is the whole safety of a re-import.
 *
 * The conversion is integer arithmetic on the two decimal places rather than `n * 100`,
 * which for values like 327.045 rounds the wrong way often enough to matter on a quote.
 */
/*
 * `value` is declared on BOTH branches — as `undefined` on the failure branch — so a
 * caller can read `.value` without first narrowing on `ok`. The alternative is an `if`
 * around every read, and there are nine of them across validation, the dry-run plan and
 * the commit. A failed parse has no value, and saying that in the type is more honest
 * than making each site prove it again.
 *
 * `message` stays on the failure branch alone, so reading it still requires the `!ok`
 * check that gives it meaning.
 */
type Parsed = { ok: true; value?: number } | { ok: false; message: string; value?: undefined };

function parseMoneyMinor(raw: unknown): Parsed {
  if (raw === undefined || raw === null) return { ok: true };
  const cleaned = String(raw).replace(/[$,\s]/g, '');
  if (!cleaned) return { ok: true };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { ok: false, message: `“${String(raw)}” is not a number` };
  if (n < 0) return { ok: false, message: 'cannot be negative' };
  const [whole, frac = '00'] = n.toFixed(2).split('.');
  return { ok: true, value: Number(whole) * 100 + Number(frac.padEnd(2, '0')) };
}

function parseWeight(raw: unknown): Parsed {
  if (raw === undefined || raw === null) return { ok: true };
  const cleaned = String(raw).replace(/[,\s]|lbs?\.?$/gi, '');
  if (!cleaned) return { ok: true };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { ok: false, message: `“${String(raw)}” is not a number` };
  if (n < 0) return { ok: false, message: 'cannot be negative' };
  return { ok: true, value: n };
}

/**
 * A yes/no cell. `z.coerce.boolean()` is `Boolean(value)`, so the string "false" — which
 * is exactly what the export writes for a hidden category — came back as true, and
 * re-importing an exported file un-hid every hidden category. A blank cell is "leave it
 * alone", like every other column here; anything unrecognisable is refused.
 */
const BoolCell = z.preprocess(
  (v) => {
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (!s) return undefined;
      if (['true', 'yes', 'y', '1'].includes(s)) return true;
      if (['false', 'no', 'n', '0'].includes(s)) return false;
    }
    if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : v;
    return v;
  },
  z.boolean({ invalid_type_error: 'isActive must be true or false' }).optional(),
);

const ImportBody = z.object({
  dryRun: z.boolean().default(true),
  missingAction: z.enum(['leave', 'deactivate']).default('leave'),
  categories: z
    .array(
      z.object({
        slug: z.string().trim().min(1),
        name: z.string().trim().min(1).optional(),
        parentSlug: z.string().trim().nullish(),
        tierLevel: z.coerce.number().int().min(1).max(4).optional(),
        sortOrder: z.coerce.number().int().optional(),
        isActive: BoolCell,
      }),
    )
    .default([]),
  products: z
    .array(
      z.object({
        sku: z.string().trim().min(1),
        name: z.string().trim().min(1).optional(),
        categorySlug: z.string().trim().optional(),
        kind: z.string().trim().optional(),
        status: z.string().trim().optional(),
        sortOrder: z.coerce.number().int().optional(),
        proposalDescription: z.string().optional(),
        // The priced side of a part. Left off this schema until now, and because Zod strips
        // unknown keys SILENTLY, a workbook carrying price columns imported "successfully"
        // while discarding every one of them. Accepted as loose strings so the sheet can say
        // "$1,234.56" and the error, when there is one, can name the offending cell.
        unitPrice: z.union([z.string(), z.number()]).optional(),
        unitCost: z.union([z.string(), z.number()]).optional(),
        weightLbs: z.union([z.string(), z.number()]).optional(),
        /** Must already exist. A typo must not invent a vendor with no address or terms. */
        manufacturer: z.string().trim().max(200).optional(),
      }),
    )
    .default([]),
  bundles: z
    .array(
      z.object({
        bundleSku: z.string().trim().min(1),
        componentSku: z.string().trim().min(1),
        quantity: z.coerce.number().int().min(1).default(1),
      }),
    )
    .default([]),
});

/*
 * Exactly the ProductKind / ProductStatus enums in schema.prisma. 'FREIGHT' used to be
 * listed here without being a ProductKind, so a row saying FREIGHT passed validation and
 * then failed the database write halfway through the commit.
 */
const KINDS: readonly ProductKind[] = [
  'PRODUCT',
  'VARIANT',
  'COMPONENT',
  'BUNDLE',
  'ACCESSORY',
  'SERVICE',
];
const STATUSES: readonly ProductStatus[] = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'];
const asKind = (v: string | undefined): ProductKind | undefined => {
  const u = (v ?? '').trim().toUpperCase();
  return KINDS.find((k) => k === u);
};
const asStatus = (v: string | undefined): ProductStatus | undefined => {
  const u = (v ?? '').trim().toUpperCase();
  return STATUSES.find((s) => s === u);
};

export function registerProductTreeRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CATALOG_READ) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  // ---------- Rename / reposition a category ----------
  app.patch('/catalog/categories/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = CategoryPatch.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid category');
    const current = await prisma.productCategory.findUnique({ where: { id } });
    if (!current) throw new NotFoundError('Category not found');
    const d = parsed.data;

    /*
     * Placement — parent, tier and product line — is validated as one thing, because
     * it is one thing: the tier is the depth under the parent, and a subtree belongs to
     * its parent's line. Only when the request touches placement; a rename of a node
     * whose stored tier predates these rules is not refused for it.
     */
    const placementTouched =
      d.parentId !== undefined || d.tierLevel !== undefined || d.productLineId !== undefined;
    let placement: {
      parentId: string | null;
      tierLevel: number;
      productLineId: string | null;
      descendants: Array<{ id: string; tierLevel: number }>;
      lineChanged: boolean;
    } | null = null;
    if (placementTouched) {
      const all = await prisma.productCategory.findMany({
        select: { id: true, parentId: true, tierLevel: true, productLineId: true },
      });
      const parentId = d.parentId !== undefined ? d.parentId || null : current.parentId;
      // A category cannot become its own ancestor, or the tree stops terminating.
      if (parentId && wouldCreateCycle(all, id, parentId))
        throw new ConflictError('That would make the category its own parent');
      const parent = parentId
        ? await prisma.productCategory.findUnique({ where: { id: parentId } })
        : null;
      if (parentId && !parent) throw new ValidationError('Parent category not found');
      // An explicit line wins; otherwise a node under a lined parent takes the
      // parent's, and any other node keeps its own.
      const lineIn =
        d.productLineId !== undefined
          ? d.productLineId || undefined
          : parent?.productLineId
            ? undefined
            : (current.productLineId ?? undefined);
      const placed = resolveCategoryTier(
        {
          ...(d.tierLevel !== undefined ? { tierLevel: d.tierLevel } : {}),
          ...(lineIn ? { productLineId: lineIn } : {}),
          ...(current.productId ? { productId: current.productId } : {}),
        },
        parent,
      );
      // Everything below moves with it. Re-derive each descendant's tier from its new
      // depth, and refuse the move if that would push any of them past tier 4 — the
      // alternative is a node that silently stops being reachable in a 4-tier picker.
      const moved = all.map((c) => (c.id === id ? { ...c, parentId } : c));
      const below = descendantIds(moved, id);
      const tiers = deriveTiers(moved);
      const offset = placed.tierLevel - (tiers.get(id) ?? placed.tierLevel);
      const descendants = below.map((cid) => ({
        id: cid,
        tierLevel: (tiers.get(cid) ?? 0) + offset,
      }));
      const tooDeep = descendants.find((x) => x.tierLevel > 4);
      if (tooDeep)
        throw new ValidationError(
          `Moving “${current.name}” there would put the categories beneath it below tier 4 (the deepest the tree goes). Move or flatten those first.`,
        );
      placement = {
        parentId,
        tierLevel: placed.tierLevel,
        productLineId: placed.productLineId,
        descendants,
        lineChanged: (placed.productLineId ?? null) !== (current.productLineId ?? null),
      };
    }

    const cat = await prisma.$transaction(async (tx) => {
      const updated = await tx.productCategory.update({
        where: { id },
        data: {
          ...(d.name !== undefined ? { name: d.name } : {}),
          ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
          ...(d.isActive !== undefined ? { isActive: d.isActive } : {}),
          ...(placement
            ? {
                parentId: placement.parentId,
                tierLevel: placement.tierLevel,
                productLineId: placement.productLineId,
              }
            : {}),
        },
      });
      if (placement) {
        for (const x of placement.descendants)
          await tx.productCategory.update({
            where: { id: x.id },
            data: {
              tierLevel: x.tierLevel,
              ...(placement.lineChanged ? { productLineId: placement.productLineId } : {}),
            },
          });
      }
      return updated;
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.category.update',
      entity: 'ProductCategory',
      entityId: id,
      details: { from: current.name, ...d } as Record<string, unknown>,
    });
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
      throw new ConflictError(
        `“${cat.name}” holds ${products} product(s) and ${children} sub-categor(y/ies). Move or delete those first, or hide the category instead.`,
      );
    }
    await prisma.productCategory.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.category.delete',
      entity: 'ProductCategory',
      entityId: id,
      details: { name: cat.name },
    });
    reply.code(204);
    return null;
  });

  // ---------- Explicit ordering ----------
  /** Categories, in the order the ids arrive. Siblings only — pass one level. */
  app.post('/catalog/categories/reorder', admin, async (req) => {
    const parsed = Reorder.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('ids are required');
    await prisma.$transaction(
      parsed.data.ids.map((id, i) =>
        prisma.productCategory.update({ where: { id }, data: { sortOrder: i } }),
      ),
    );
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.category.reorder',
      details: { count: parsed.data.ids.length },
    });
    return { ok: true, count: parsed.data.ids.length };
  });

  /**
   * The default product list order, used by the product picker and the tier
   * listings. Ids arrive in display order; everything else keeps its place.
   */
  app.post('/catalog/products/reorder', admin, async (req) => {
    const parsed = Reorder.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('ids are required');
    await prisma.$transaction(
      parsed.data.ids.map((id, i) =>
        prisma.product.update({ where: { id }, data: { sortOrder: i } }),
      ),
    );
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.product.reorder',
      details: { count: parsed.data.ids.length },
    });
    return { ok: true, count: parsed.data.ids.length };
  });

  // ---------- Round-trip export ----------
  /**
   * The whole tree as plain rows — one array per workbook sheet. The client turns
   * this into the .xls workbook and parses the same shape back on import, so an
   * exported file always re-imports cleanly.
   */
  app.get('/catalog/tree/export', read, async () => {
    const [lines, cats, products, relations, skus] = await Promise.all([
      prisma.productLine.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, slug: true, sortOrder: true, isActive: true },
      }),
      prisma.productCategory.findMany({ orderBy: [{ tierLevel: 'asc' }, { sortOrder: 'asc' }] }),
      prisma.product.findMany({
        orderBy: [{ sortOrder: 'asc' }, { sku: 'asc' }],
        select: {
          id: true,
          sku: true,
          name: true,
          kind: true,
          status: true,
          sortOrder: true,
          categoryId: true,
          proposalDescription: true,
        },
      }),
      prisma.productRelation.findMany({
        where: { type: 'BUNDLE_ITEM' },
        orderBy: { sortOrder: 'asc' },
        select: {
          quantity: true,
          parent: { select: { sku: true, name: true } },
          child: { select: { sku: true, name: true } },
        },
      }),
      // The priced counterpart. The export read only Product, so the workbook it produced
      // had no price, cost, weight or manufacturer in it — which made the round trip
      // lossy in both directions at once: nothing to correct on the way out, nothing
      // accepted on the way back in.
      prisma.sku.findMany({
        select: {
          part: true,
          unitPriceMinor: true,
          unitCostMinor: true,
          weightLbs: true,
          manufacturer: true,
        },
      }),
    ]);
    const slugOf = new Map(cats.map((c) => [c.id, c.slug]));
    const skuByPart = new Map(skus.map((s) => [s.part.trim().toLowerCase(), s]));
    return {
      exportedAt: new Date().toISOString(),
      productLines: lines,
      categories: cats.map((c) => ({
        slug: c.slug,
        name: c.name,
        tierLevel: c.tierLevel,
        sortOrder: c.sortOrder,
        isActive: c.isActive,
        parentSlug: c.parentId ? (slugOf.get(c.parentId) ?? '') : '',
        productLineId: c.productLineId ?? '',
      })),
      products: products.map((p) => {
        const s = skuByPart.get(p.sku.trim().toLowerCase());
        return {
          sku: p.sku,
          name: p.name,
          kind: p.kind,
          status: p.status,
          sortOrder: p.sortOrder,
          categorySlug: slugOf.get(p.categoryId) ?? '',
          proposalDescription: p.proposalDescription ?? '',
          // Dollars, not minor units: this sheet gets edited by a person in Excel. A part
          // with no Sku row exports these as EMPTY rather than 0, so the blank is visible
          // as "needs a price" and a re-import of the untouched file cannot write zeros.
          unitPrice: s ? (s.unitPriceMinor / 100).toFixed(2) : '',
          unitCost: s ? (s.unitCostMinor / 100).toFixed(2) : '',
          weightLbs: s && s.weightLbs != null ? String(s.weightLbs) : '',
          manufacturer: s?.manufacturer ?? '',
        };
      }),
      bundles: relations.map((r) => ({
        bundleSku: r.parent.sku,
        bundleName: r.parent.name,
        componentSku: r.child.sku,
        componentName: r.child.name,
        quantity: r.quantity,
      })),
    };
  });

  // ---------- Sort-order audit and renumber ----------
  /*
   * The Product tree's "Sort order" button has called these two routes for a long time;
   * neither existed, so it answered 404. Ties in `sortOrder` between siblings break
   * alphabetically, so a collision prints in an order nobody chose — which is what the
   * audit lists and the renumber removes.
   *
   * "Siblings" means what the tree and the builder compare: categories under the same
   * parent, and products in the same category. `sortKeyFor` in catalogItems.ts orders a
   * part by its category path, then its own sortOrder, so a number only ever competes
   * with its siblings' numbers.
   */
  type SortNode = { id: string; name: string; sortOrder: number };
  const bySortThenName = (a: SortNode, b: SortNode): number =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

  async function loadSortTree() {
    const [cats, products] = await Promise.all([
      prisma.productCategory.findMany({
        select: { id: true, name: true, parentId: true, tierLevel: true, sortOrder: true },
      }),
      prisma.product.findMany({
        select: { id: true, sku: true, name: true, categoryId: true, sortOrder: true },
      }),
    ]);
    const catById = new Map(cats.map((c) => [c.id, c]));
    const pathOf = (id: string | null): string => {
      const names: string[] = [];
      let node = id ? catById.get(id) : undefined;
      for (let hops = 0; node && hops < 12; hops++) {
        names.unshift(node.name);
        node = node.parentId ? catById.get(node.parentId) : undefined;
      }
      return names.join(' › ');
    };
    const group = <T extends SortNode>(rows: T[], keyOf: (r: T) => string): Map<string, T[]> => {
      const out = new Map<string, T[]>();
      for (const r of rows) out.set(keyOf(r), (out.get(keyOf(r)) ?? []).concat(r));
      for (const list of out.values()) list.sort(bySortThenName);
      return out;
    };
    return {
      cats,
      pathOf,
      catGroups: group(cats, (c) => c.parentId ?? ''),
      productGroups: group(products, (p) => p.categoryId),
      productLabel: new Map(products.map((p) => [p.id, `${p.sku} — ${p.name}`])),
    };
  }

  app.get('/catalog/tree/sort-audit', admin, async () => {
    const t = await loadSortTree();
    type Clash = {
      scope: string;
      sortOrder: number;
      members: Array<{ id: string; label: string }>;
    };
    const clashesIn = (
      groups: Map<string, SortNode[]>,
      scopeOf: (key: string) => string,
      labelOf: (n: SortNode) => string,
    ): Clash[] => {
      const out: Clash[] = [];
      for (const [k, list] of groups) {
        const bySort = new Map<number, SortNode[]>();
        for (const n of list) bySort.set(n.sortOrder, (bySort.get(n.sortOrder) ?? []).concat(n));
        for (const [sortOrder, members] of bySort)
          if (members.length > 1)
            out.push({
              scope: scopeOf(k),
              sortOrder,
              members: members.map((m) => ({ id: m.id, label: labelOf(m) })),
            });
      }
      return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.sortOrder - b.sortOrder);
    };
    const categoryClashes = clashesIn(
      t.catGroups,
      (k) => (k ? t.pathOf(k) : 'Top level'),
      (n) => n.name,
    );
    const productClashes = clashesIn(
      t.productGroups,
      (k) => t.pathOf(k) || 'Uncategorised',
      (n) => t.productLabel.get(n.id) ?? n.name,
    );
    const all = [...categoryClashes, ...productClashes];
    return {
      clashCount: all.length,
      affected: all.reduce((n, c) => n + c.members.length, 0),
      categoryClashes,
      productClashes,
    };
  });

  /**
   * Rewrite every sibling group to 10, 20, 30… in its current order (sortOrder, then
   * name — the order the tree shows), tier by tier, in one transaction. Gaps of 10
   * leave room to slot one item in by hand later. Only rows whose number changes are
   * written, and those are what the counts report.
   */
  app.post('/catalog/tree/renumber', admin, async (req) => {
    const t = await loadSortTree();
    const tierOfParent = new Map(t.cats.map((c) => [c.id, c.tierLevel]));
    const catGroupKeys = [...t.catGroups.keys()].sort(
      (a, b) => (a ? (tierOfParent.get(a) ?? 0) : 0) - (b ? (tierOfParent.get(b) ?? 0) : 0),
    );
    const writes: Array<{ table: 'category' | 'product'; id: string; sortOrder: number }> = [];
    for (const k of catGroupKeys)
      (t.catGroups.get(k) ?? []).forEach((c, i) => {
        if (c.sortOrder !== (i + 1) * 10)
          writes.push({ table: 'category', id: c.id, sortOrder: (i + 1) * 10 });
      });
    for (const list of t.productGroups.values())
      list.forEach((p, i) => {
        if (p.sortOrder !== (i + 1) * 10)
          writes.push({ table: 'product', id: p.id, sortOrder: (i + 1) * 10 });
      });
    await prisma.$transaction(
      async (tx) => {
        for (const w of writes) {
          if (w.table === 'category')
            await tx.productCategory.update({
              where: { id: w.id },
              data: { sortOrder: w.sortOrder },
            });
          else await tx.product.update({ where: { id: w.id }, data: { sortOrder: w.sortOrder } });
        }
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    const categories = writes.filter((w) => w.table === 'category').length;
    const products = writes.length - categories;
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.tree.renumber',
      details: { categories, products },
    });
    return { ok: true, categories, products };
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
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid import');
    const d = parsed.data;
    const issues: { sheet: string; key: string; message: string }[] = [];

    const [existingCats, existingProducts, existingSkus, manufacturers] = await Promise.all([
      prisma.productCategory.findMany({
        select: {
          id: true,
          slug: true,
          name: true,
          sortOrder: true,
          tierLevel: true,
          parentId: true,
        },
      }),
      prisma.product.findMany({
        select: {
          id: true,
          sku: true,
          name: true,
          status: true,
          kind: true,
          sortOrder: true,
          categoryId: true,
        },
      }),
      prisma.sku.findMany({ select: { id: true, part: true } }),
      prisma.manufacturer.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    ]);
    const existingLinks = await prisma.productRelation.findMany({
      where: { type: 'BUNDLE_ITEM' },
      select: { parent: { select: { sku: true } }, child: { select: { sku: true } } },
    });
    const catBySlug = new Map(existingCats.map((c) => [c.slug, c]));
    const prodBySku = new Map(existingProducts.map((p) => [p.sku, p]));
    const lower = (v: string) => v.trim().toLowerCase();
    const skuByPart = new Map(existingSkus.map((s) => [lower(s.part), s]));
    const mfrByName = new Map(manufacturers.map((m) => [lower(m.name), m]));

    /**
     * The priced fields for one row, parsed once so validation and commit cannot
     * disagree about what a cell meant.
     */
    const pricedOf = (p: (typeof d.products)[number]) => ({
      price: parseMoneyMinor(p.unitPrice),
      cost: parseMoneyMinor(p.unitCost),
      weight: parseWeight(p.weightLbs),
      mfr: (p.manufacturer ?? '').trim(),
    });
    const fileCatSlugs = new Set(d.categories.map((c) => c.slug));

    for (const c of d.categories) {
      if (c.parentSlug && !catBySlug.has(c.parentSlug) && !fileCatSlugs.has(c.parentSlug)) {
        issues.push({
          sheet: 'Categories',
          key: c.slug,
          message: `parent “${c.parentSlug}” is not in the catalog or the file`,
        });
      }
      if (!catBySlug.has(c.slug) && !c.name)
        issues.push({ sheet: 'Categories', key: c.slug, message: 'new category needs a name' });
    }

    /*
     * The tree as it will stand after the import, checked BEFORE anything is written.
     *
     * The parent pass used to apply each row's parentSlug with no check at all, so a
     * sheet could make two categories each other's parent (a cycle the builder's tree
     * walk then spins on) or hang a fifth level under a tier-4 node. The tier column was
     * written as given, independent of where the row actually ended up.
     *
     * The tier is derived from the final parent chain — tier 1 at the top, parent + 1
     * below — and written for every category the file places, plus everything beneath a
     * category the file moves. A tierLevel cell that disagrees is reported in the plan
     * and corrected, not trusted.
     */
    const idToSlug = new Map(existingCats.map((c) => [c.id, c.slug]));
    const finalParent = new Map<string, string | null>(
      existingCats.map((c) => [c.slug, c.parentId ? (idToSlug.get(c.parentId) ?? null) : null]),
    );
    for (const c of d.categories) {
      if (c.parentSlug !== undefined) finalParent.set(c.slug, c.parentSlug || null);
      else if (!finalParent.has(c.slug)) finalParent.set(c.slug, null);
    }
    const treeNodes = [...finalParent].map(([slug, parentSlug]) => ({
      id: slug,
      parentId: parentSlug,
    }));
    const finalTier = deriveTiers(treeNodes);
    const tierTargets = new Set<string>();
    for (const c of d.categories) {
      tierTargets.add(c.slug);
      if (c.parentSlug !== undefined)
        for (const below of descendantIds(treeNodes, c.slug)) tierTargets.add(below);
    }
    const tierCorrected: string[] = [];
    for (const slug of tierTargets) {
      const parentSlug = finalParent.get(slug) ?? null;
      if (parentSlug && !finalParent.has(parentSlug)) continue; // reported above
      const tier = finalTier.get(slug);
      if (tier == null) {
        issues.push({
          sheet: 'Categories',
          key: slug,
          message: 'its parent chain loops back on itself — a category cannot be its own ancestor',
        });
      } else if (tier > 4) {
        issues.push({
          sheet: 'Categories',
          key: slug,
          message: `would sit at tier ${tier}; the tree is at most 4 tiers deep`,
        });
      } else {
        const given = d.categories.find((c) => c.slug === slug)?.tierLevel;
        const stored = catBySlug.get(slug)?.tierLevel;
        if ((given !== undefined && given !== tier) || (given === undefined && stored !== tier))
          tierCorrected.push(slug);
      }
    }

    const fileProductBySku = new Map(d.products.map((p) => [p.sku, p]));
    for (const p of d.products) {
      if (p.kind && !asKind(p.kind))
        issues.push({ sheet: 'Products', key: p.sku, message: `unknown kind “${p.kind}”` });
      if (p.status && !asStatus(p.status))
        issues.push({ sheet: 'Products', key: p.sku, message: `unknown status “${p.status}”` });
      // A status change goes through the same state machine as the status control
      // (src/catalog/service.ts), refused here rather than halfway through the commit.
      const was = prodBySku.get(p.sku);
      const to = asStatus(p.status);
      if (was && to && was.status !== to && !canTransition(was.status, to))
        issues.push({
          sheet: 'Products',
          key: p.sku,
          message: `status cannot go from ${was.status} to ${to}${was.status === 'ARCHIVED' ? ' — an archived part stays archived' : ''}`,
        });
      if (p.categorySlug && !catBySlug.has(p.categorySlug) && !fileCatSlugs.has(p.categorySlug)) {
        issues.push({
          sheet: 'Products',
          key: p.sku,
          message: `category “${p.categorySlug}” is not in the catalog or the file`,
        });
      }
      if (!prodBySku.has(p.sku)) {
        if (!p.name)
          issues.push({ sheet: 'Products', key: p.sku, message: 'new part needs a name' });
        if (!p.categorySlug)
          issues.push({ sheet: 'Products', key: p.sku, message: 'new part needs a category' });
      }
      const pr = pricedOf(p);
      if (!pr.price.ok)
        issues.push({ sheet: 'Products', key: p.sku, message: `unit price: ${pr.price.message}` });
      if (!pr.cost.ok)
        issues.push({ sheet: 'Products', key: p.sku, message: `unit cost: ${pr.cost.message}` });
      if (!pr.weight.ok)
        issues.push({ sheet: 'Products', key: p.sku, message: `weight: ${pr.weight.message}` });
      // Refused rather than created, unlike PATCH /catalog/items/:part, which creates a
      // Manufacturer row for any unrecognised name — no address, no terms, no Bill of
      // Materials defaults, and indistinguishable in the vendor list from a real one. A
      // spreadsheet is exactly where that typo happens at scale.
      if (pr.mfr && !mfrByName.has(lower(pr.mfr))) {
        const known = manufacturers
          .map((m) => m.name)
          .sort()
          .join(', ');
        issues.push({
          sheet: 'Products',
          key: p.sku,
          message: `manufacturer “${pr.mfr}” is not on record. Add the vendor under Catalog → Manufacturers first, or use one of: ${known}`,
        });
      }
    }
    for (const b of d.bundles) {
      if (!prodBySku.has(b.bundleSku) && !d.products.some((p) => p.sku === b.bundleSku)) {
        issues.push({
          sheet: 'Bundles',
          key: b.bundleSku,
          message: 'bundle part number is not in the catalog or the file',
        });
      }
      if (!prodBySku.has(b.componentSku) && !d.products.some((p) => p.sku === b.componentSku)) {
        issues.push({
          sheet: 'Bundles',
          key: b.componentSku,
          message: 'component part number is not in the catalog or the file',
        });
      }
      if (b.bundleSku === b.componentSku)
        issues.push({
          sheet: 'Bundles',
          key: b.bundleSku,
          message: 'a bundle cannot contain itself',
        });
    }
    /*
     * Bundles are one level deep — the same rule PUT /catalog/bundles/:id/components
     * enforces. A bundle's parent is marked kind BUNDLE on commit (it is only a bundle
     * once it is marked one), so a row that says otherwise is a contradiction, and a
     * part that is a bundle cannot also be listed as a component of one.
     */
    const kindAfter = (sku: string): ProductKind | undefined =>
      asKind(fileProductBySku.get(sku)?.kind) ?? prodBySku.get(sku)?.kind;
    const bundleParents = new Set(d.bundles.map((b) => b.bundleSku));
    const componentsAfter = new Set([
      ...d.bundles.map((b) => b.componentSku),
      ...existingLinks.map((l) => l.child.sku),
    ]);
    const parentsAfter = new Set([...bundleParents, ...existingLinks.map((l) => l.parent.sku)]);
    for (const sku of bundleParents) {
      const k = asKind(fileProductBySku.get(sku)?.kind);
      if (k && k !== 'BUNDLE')
        issues.push({
          sheet: 'Bundles',
          key: sku,
          message: `listed as a bundle, but its Products row sets kind ${k} — a bundle's kind is BUNDLE`,
        });
      if (componentsAfter.has(sku))
        issues.push({
          sheet: 'Bundles',
          key: sku,
          message:
            'is a component of another bundle, so it cannot be a bundle itself — bundles do not nest',
        });
    }
    for (const b of d.bundles) {
      if (parentsAfter.has(b.componentSku) || kindAfter(b.componentSku) === 'BUNDLE')
        issues.push({
          sheet: 'Bundles',
          key: b.componentSku,
          message: `is itself a bundle, so it cannot go inside “${b.bundleSku}” — add its parts directly instead`,
        });
    }

    const missing = existingProducts
      .filter((p) => !d.products.some((x) => x.sku === p.sku) && p.status !== 'ARCHIVED')
      .map((p) => ({ sku: p.sku, name: p.name, status: p.status }));

    const plan = {
      categories: {
        create: d.categories.filter((c) => !catBySlug.has(c.slug)).length,
        update: d.categories.filter((c) => catBySlug.has(c.slug)).length,
        /** Categories whose tier will be written as their position says, not as given. */
        tierCorrected,
      },
      products: {
        create: d.products.filter((p) => !prodBySku.has(p.sku)).length,
        update: d.products.filter((p) => prodBySku.has(p.sku)).length,
      },
      // Counted separately so the operator can see, before committing, that the prices in
      // the file are actually going to be written this time.
      prices: (() => {
        const withPrice = d.products.filter((p) => {
          const pr = pricedOf(p);
          return (
            pr.price.value !== undefined ||
            pr.cost.value !== undefined ||
            pr.weight.value !== undefined ||
            !!pr.mfr
          );
        });
        return {
          rowsWithPricedFields: withPrice.length,
          skuCreate: withPrice.filter((p) => !skuByPart.has(lower(p.sku))).length,
          skuUpdate: withPrice.filter((p) => skuByPart.has(lower(p.sku))).length,
        };
      })(),
      bundles: { links: d.bundles.length },
      missing,
    };
    if (d.dryRun || issues.length) {
      return reply
        .status(issues.length ? 422 : 200)
        .send({ valid: issues.length === 0, committed: false, issues, plan });
    }

    // ---- commit ----
    /*
     * ONE transaction. This used to be a hundred-odd separate awaits, so anything that
     * failed partway — a kind the database rejects, a constraint, a dropped connection —
     * left whatever had been written so far committed: a new part ACTIVE in the tree with
     * no priced record was exactly that. Now the file lands whole or not at all.
     *
     * Categories first (two passes: rows, then parents, so order in the file never
     * matters), then products, then priced records, then bundle links.
     */
    const result = await prisma.$transaction(
      async (tx) => {
        for (const c of d.categories) {
          const existing = catBySlug.get(c.slug);
          const tier = finalTier.get(c.slug) ?? 1;
          if (existing) {
            await tx.productCategory.update({
              where: { id: existing.id },
              data: {
                ...(c.name !== undefined ? { name: c.name } : {}),
                tierLevel: tier,
                ...(c.sortOrder !== undefined ? { sortOrder: c.sortOrder } : {}),
                ...(c.isActive !== undefined ? { isActive: c.isActive } : {}),
              },
            });
          } else {
            const made = await tx.productCategory.create({
              data: {
                slug: c.slug || slugify(c.name as string),
                name: c.name as string,
                tierLevel: tier,
                sortOrder: c.sortOrder ?? 0,
                isActive: c.isActive ?? true,
              },
            });
            catBySlug.set(made.slug, {
              id: made.id,
              slug: made.slug,
              name: made.name,
              sortOrder: made.sortOrder,
              tierLevel: made.tierLevel,
              parentId: made.parentId,
            });
          }
        }
        for (const c of d.categories) {
          if (c.parentSlug === undefined) continue;
          const self = catBySlug.get(c.slug);
          const parent = c.parentSlug ? catBySlug.get(c.parentSlug) : null;
          if (self)
            await tx.productCategory.update({
              where: { id: self.id },
              data: { parentId: parent?.id ?? null },
            });
        }
        // Everything beneath a category the file moved takes its new depth too.
        const fileSlugs = new Set(d.categories.map((c) => c.slug));
        for (const slug of tierTargets) {
          if (fileSlugs.has(slug)) continue;
          const node = catBySlug.get(slug);
          const tier = finalTier.get(slug);
          if (node && tier != null && node.tierLevel !== tier)
            await tx.productCategory.update({ where: { id: node.id }, data: { tierLevel: tier } });
        }

        let created = 0,
          updated = 0;
        for (const p of d.products) {
          const existing = prodBySku.get(p.sku);
          const catId = p.categorySlug ? catBySlug.get(p.categorySlug)?.id : undefined;
          const kind = asKind(p.kind);
          const status = asStatus(p.status);
          if (existing) {
            await tx.product.update({
              where: { id: existing.id },
              data: {
                ...(p.name !== undefined ? { name: p.name } : {}),
                ...(catId ? { categoryId: catId } : {}),
                ...(kind ? { kind } : {}),
                ...(p.sortOrder !== undefined ? { sortOrder: p.sortOrder } : {}),
                ...(p.proposalDescription !== undefined
                  ? { proposalDescription: p.proposalDescription || null }
                  : {}),
              },
            });
            // Status through the state machine: history row, active window, and the
            // priced record's active flag, all in this transaction. Transitions were
            // validated above, so this cannot refuse.
            if (status && status !== existing.status) {
              await changeStatusTx(tx, existing.id, status, req.user!.sub, 'tree import');
              existing.status = status;
            }
            if (kind) existing.kind = kind;
            updated++;
          } else {
            const np = await tx.product.create({
              data: {
                sku: p.sku,
                name: p.name as string,
                categoryId: catId as string,
                kind: kind ?? 'PRODUCT',
                status: status ?? 'DRAFT',
                sortOrder: p.sortOrder ?? 0,
                proposalDescription: p.proposalDescription || null,
                createdById: req.user!.sub,
              },
            });
            await recordCreatedStatus(tx, np.id, np.status, req.user!.sub);
            prodBySku.set(np.sku, {
              id: np.id,
              sku: np.sku,
              name: np.name,
              status: np.status,
              kind: np.kind,
              sortOrder: np.sortOrder,
              categoryId: np.categoryId,
            });
            created++;
          }
        }

        /*
         * The priced counterpart, written in its own pass now that every Product exists.
         *
         * THE GUARD THAT MATTERS: a Sku is only created for a row that actually supplies a
         * priced field. Without that, a plain tree re-import — the normal, everyday use of
         * this importer, with no price columns filled in — would manufacture an empty $0
         * Sku for every part in the catalog, which is a worse version of the bug being
         * fixed.
         */
        let skuCreated = 0,
          skuUpdated = 0,
          sourcingLinked = 0,
          sourcingAmbiguous = 0;
        for (const p of d.products) {
          const pr = pricedOf(p);
          const has =
            pr.price.value !== undefined ||
            pr.cost.value !== undefined ||
            pr.weight.value !== undefined ||
            !!pr.mfr;
          if (!has) continue;

          const prod = prodBySku.get(p.sku);
          if (!prod) continue;
          const existing = skuByPart.get(lower(p.sku));
          const mfr = pr.mfr ? mfrByName.get(lower(pr.mfr))! : null;
          const mfrName = mfr ? mfr.name : undefined;

          if (existing) {
            // Only the fields the sheet actually gave a value for. A blank cell was
            // dropped by the client and parses to undefined here, so an untouched column
            // cannot zero a price that is already right.
            await tx.sku.update({
              where: { id: existing.id },
              data: {
                ...(pr.price.value !== undefined ? { unitPriceMinor: pr.price.value } : {}),
                ...(pr.cost.value !== undefined ? { unitCostMinor: pr.cost.value } : {}),
                ...(pr.weight.value !== undefined ? { weightLbs: pr.weight.value } : {}),
                ...(mfrName ? { manufacturer: mfrName } : {}),
              },
            });
            skuUpdated++;
          } else {
            const catName = p.categorySlug ? catBySlug.get(p.categorySlug)?.name : undefined;
            await tx.sku.create({
              data: {
                part: p.sku,
                description: p.name ?? prod.name,
                // A part TYPE code (FRAME, TROLLEY, ACCESSORY) for catalog filtering and
                // reporting — not the proposal heading (`Sku.proposalGroup`) and not the
                // tree position (Product.categoryId). Non-null, so a new row is seeded
                // with the section name and meant to be edited to a real type.
                category: catName ?? '',
                manufacturer: mfrName ?? null,
                unitPriceMinor: pr.price.value ?? 0,
                unitCostMinor: pr.cost.value ?? 0,
                weightLbs: pr.weight.value ?? 0,
                // Mirrors the Product's status AFTER this import's own change, so a part
                // that is live in the tree is live in the price list.
                active: prod.status === 'ACTIVE',
              },
            });
            skuCreated++;
          }

          /*
           * The OTHER record of the same fact: `ProductSourcing`, which the vendor
           * reports, the freight true-up and `vendorResolution.ts` read. Only when the
           * sheet actually named a manufacturer — a blank cell means "leave the vendor
           * alone". Shared with the SKU CSV importer and the catalog item editor
           * (src/catalog/partVendor.ts); a multi-vendor part is skipped, not guessed.
           */
          if (mfr) {
            const outcome = await syncPartSourcing(tx, p.sku, mfr);
            if (outcome === 'linked' || outcome === 'relinked') sourcingLinked++;
            else if (outcome === 'ambiguous') sourcingAmbiguous++;
          }
        }

        let links = 0;
        for (const b of d.bundles) {
          const parent = prodBySku.get(b.bundleSku),
            child = prodBySku.get(b.componentSku);
          if (!parent || !child) continue;
          // A bundle is only a bundle once it is marked one — the same step
          // PUT /catalog/bundles/:id/components takes.
          if (parent.kind !== 'BUNDLE') {
            await tx.product.update({ where: { id: parent.id }, data: { kind: 'BUNDLE' } });
            parent.kind = 'BUNDLE';
          }
          const existing = await tx.productRelation.findFirst({
            where: { parentId: parent.id, childId: child.id, type: 'BUNDLE_ITEM' },
          });
          if (existing)
            await tx.productRelation.update({
              where: { id: existing.id },
              data: { quantity: b.quantity },
            });
          else
            await tx.productRelation.create({
              data: {
                parentId: parent.id,
                childId: child.id,
                type: 'BUNDLE_ITEM',
                quantity: b.quantity,
                sortOrder: links,
              },
            });
          links++;
        }

        /*
         * Parts absent from the file, when asked to deactivate them. Only ACTIVE ones:
         * INACTIVE already is, and DRAFT → INACTIVE is not a legal move (a draft is
         * already not quotable). Through the state machine, so the Sku follows.
         */
        let deactivated = 0;
        if (d.missingAction === 'deactivate') {
          for (const m of missing) {
            const p = prodBySku.get(m.sku);
            if (!p || p.status !== 'ACTIVE') continue;
            await changeStatusTx(tx, p.id, 'INACTIVE', req.user!.sub, 'absent from tree import');
            p.status = 'INACTIVE';
            deactivated++;
          }
        }
        return {
          created,
          updated,
          links,
          deactivated,
          skuCreated,
          skuUpdated,
          sourcingLinked,
          sourcingAmbiguous,
        };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    const {
      created,
      updated,
      links,
      deactivated,
      skuCreated,
      skuUpdated,
      sourcingLinked,
      sourcingAmbiguous,
    } = result;

    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.tree.import',
      details: {
        created,
        updated,
        links,
        deactivated,
        skuCreated,
        skuUpdated,
        sourcingLinked,
        sourcingAmbiguous,
      },
    });
    return reply.status(200).send({
      valid: true,
      committed: true,
      issues: [],
      plan,
      result: {
        created,
        updated,
        links,
        deactivated,
        skuCreated,
        skuUpdated,
        sourcingLinked,
        sourcingAmbiguous,
      },
    });
  });
}
