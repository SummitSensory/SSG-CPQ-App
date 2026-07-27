import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, ConflictError, NotFoundError } from '../lib/errors.js';

/**
 * Bundles.
 *
 * A bundle is a real catalog product (`kind = BUNDLE`) whose contents are
 * `ProductRelation` rows of type BUNDLE_ITEM. It carries no price of its own:
 * the price, cost and weight are always the sum of its components × their
 * quantities, read live from the priced SKU master. That way a component price
 * change can never leave a stale bundle price behind.
 *
 * On a proposal the bundle is one line at the rolled-up price, with its
 * components listed beneath it as zero-rate sub-lines. The sub-lines carry the
 * real part numbers, cost and weight, so the Bill of Materials, the COGS and the
 * freight weight all see the actual parts rather than the wrapper.
 */

const BundleInput = z.object({
  sku: z.string().trim().min(2).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Part # may use letters, numbers, dot, dash and underscore'),
  name: z.string().trim().min(2).max(400),
  categoryId: z.string().min(1),
  proposalDescription: z.string().trim().max(4000).optional(),
});

const ComponentsInput = z.object({
  components: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().int().min(1).max(9999).default(1),
  })).max(200),
});

interface Rollup { unitPriceMinor: number; unitCostMinor: number; weightLbs: number; missingPrice: string[] }

/** Sum a bundle's components against the priced SKU master. */
function rollup(
  components: Array<{ quantity: number; sku: string }>,
  priced: Map<string, { unitPriceMinor: number; unitCostMinor: number; weightLbs: number }>,
): Rollup {
  const out: Rollup = { unitPriceMinor: 0, unitCostMinor: 0, weightLbs: 0, missingPrice: [] };
  for (const c of components) {
    const p = priced.get(c.sku);
    if (!p) { out.missingPrice.push(c.sku); continue; }
    if (!p.unitPriceMinor) out.missingPrice.push(c.sku);
    out.unitPriceMinor += p.unitPriceMinor * c.quantity;
    out.unitCostMinor += p.unitCostMinor * c.quantity;
    out.weightLbs += p.weightLbs * c.quantity;
  }
  out.weightLbs = Math.round(out.weightLbs * 1000) / 1000;
  return out;
}

export function registerBundleRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CATALOG_READ) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  /** Every bundle with its contents and rolled-up totals. */
  app.get('/catalog/bundles', read, async () => {
    const bundles = await prisma.product.findMany({
      where: { kind: 'BUNDLE' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true, sku: true, name: true, status: true, categoryId: true, sortOrder: true, proposalDescription: true,
        parentRelations: {
          where: { type: 'BUNDLE_ITEM' },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, quantity: true, sortOrder: true, child: { select: { id: true, sku: true, name: true, status: true } } },
        },
      },
    });
    const parts = [...new Set(bundles.flatMap((b) => b.parentRelations.map((r) => r.child.sku)))];
    const skus = parts.length
      ? await prisma.sku.findMany({ where: { part: { in: parts } }, select: { part: true, unitPriceMinor: true, unitCostMinor: true, weightLbs: true } })
      : [];
    const priced = new Map(skus.map((s) => [s.part, { unitPriceMinor: s.unitPriceMinor, unitCostMinor: s.unitCostMinor, weightLbs: Number(s.weightLbs) }]));

    return bundles.map((b) => {
      const components = b.parentRelations.map((r) => {
        const p = priced.get(r.child.sku);
        return {
          relationId: r.id, productId: r.child.id, sku: r.child.sku, name: r.child.name, status: r.child.status,
          quantity: r.quantity,
          unitPriceMinor: p?.unitPriceMinor ?? 0, unitCostMinor: p?.unitCostMinor ?? 0, weightLbs: p?.weightLbs ?? 0,
          extendedPriceMinor: (p?.unitPriceMinor ?? 0) * r.quantity,
        };
      });
      const totals = rollup(components.map((c) => ({ quantity: c.quantity, sku: c.sku })), priced);
      return {
        id: b.id, sku: b.sku, name: b.name, status: b.status, categoryId: b.categoryId, sortOrder: b.sortOrder,
        proposalDescription: b.proposalDescription ?? '',
        components, ...totals, componentCount: components.length,
      };
    });
  });

  app.post('/catalog/bundles', admin, async (req, reply) => {
    const parsed = BundleInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid bundle');
    const d = parsed.data;
    if (await prisma.product.findUnique({ where: { sku: d.sku } })) throw new ConflictError(`Part # “${d.sku}” already exists`);
    const cat = await prisma.productCategory.findUnique({ where: { id: d.categoryId } });
    if (!cat) throw new ValidationError('Pick a category for the bundle');
    const bundle = await prisma.product.create({
      data: {
        sku: d.sku, name: d.name, categoryId: d.categoryId, kind: 'BUNDLE', status: 'DRAFT',
        proposalDescription: d.proposalDescription || null, createdById: req.user!.sub,
      },
    });
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.bundle.create', entity: 'Product', entityId: bundle.id, details: { sku: d.sku } });
    return reply.status(201).send(bundle);
  });

  /**
   * Replace a bundle's contents in one call — the panel always sends the whole
   * list, so there is no partial state to reconcile. Order is the array order.
   */
  app.put('/catalog/bundles/:id/components', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ComponentsInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid components');
    const bundle = await prisma.product.findUnique({ where: { id }, select: { id: true, kind: true, sku: true } });
    if (!bundle) throw new NotFoundError('Bundle not found');

    const comps = parsed.data.components;
    if (comps.some((c) => c.productId === id)) throw new ConflictError('A bundle cannot contain itself');
    const ids = [...new Set(comps.map((c) => c.productId))];
    if (ids.length !== comps.length) throw new ValidationError('The same part is listed twice — set its quantity instead');
    const found = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, name: true } });
    if (found.length !== ids.length) throw new ValidationError('One of those parts no longer exists');
    // One level only: nesting bundles makes the rolled-up price ambiguous and the
    // BOM expansion recursive for no operational gain.
    const nested = found.find((f) => f.kind === 'BUNDLE');
    if (nested) throw new ConflictError(`“${nested.name}” is itself a bundle — add its parts directly instead`);

    await prisma.$transaction([
      prisma.productRelation.deleteMany({ where: { parentId: id, type: 'BUNDLE_ITEM' } }),
      ...comps.map((c, i) => prisma.productRelation.create({
        data: { parentId: id, childId: c.productId, type: 'BUNDLE_ITEM', quantity: c.quantity, sortOrder: i },
      })),
      // A bundle is only a bundle once it is marked one.
      prisma.product.update({ where: { id }, data: { kind: 'BUNDLE' } }),
    ]);
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.bundle.components', entity: 'Product', entityId: id, details: { count: comps.length } });
    return { ok: true, count: comps.length };
  });

  /**
   * Remove the bundle wrapper. Components are never touched — they are ordinary
   * catalog parts that happen to be listed here.
   */
  app.delete('/catalog/bundles/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const bundle = await prisma.product.findUnique({ where: { id }, select: { id: true, sku: true, status: true } });
    if (!bundle) throw new NotFoundError('Bundle not found');
    const versions = await prisma.proposalVersion.findMany({ select: { items: true, proposal: { select: { number: true } } } });
    const used = versions.filter((v) => Array.isArray(v.items) && (v.items as { sku?: string }[]).some((i) => i && i.sku === bundle.sku));
    if (used.length) {
      throw new ConflictError(`This bundle is on ${used.length} proposal(s) (${used.slice(0, 3).map((u) => u.proposal.number).join(', ')}). Deactivate it instead.`);
    }
    await prisma.$transaction([
      prisma.productRelation.deleteMany({ where: { parentId: id, type: 'BUNDLE_ITEM' } }),
      prisma.product.delete({ where: { id } }),
    ]);
    await recordAudit({ actorId: req.user!.sub, action: 'catalog.bundle.delete', entity: 'Product', entityId: id, details: { sku: bundle.sku } });
    reply.code(204);
    return null;
  });
}
