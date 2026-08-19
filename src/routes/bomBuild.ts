import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, ConflictError, NotFoundError } from '../lib/errors.js';
import { applyBomBuildToOrder } from '../handoff/bomBuild.js';

/**
 * BOM build rules — Catalog → BOM build.
 *
 * Two settings per part, both of them things that used to require a code change:
 *
 *   * COMPONENTS — the parts a part is made of. One proposal line, several purchased
 *     parts. The customer sees UEU-HARKIT; purchasing sees the four pieces.
 *   * FREE ISSUE — the vendor a part is shipped to when we buy it somewhere else and
 *     have it delivered there. It lands on the receiving vendor's sheet at no cost.
 *
 * See src/handoff/bomBuild.ts for what the rules do to an order. Nothing here can
 * change a proposal, a price or an accepted order's totals.
 */

const PART = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((v) => v.toUpperCase());

const ComponentInput = z.object({
  parentPart: PART,
  childPart: PART,
  quantity: z.number().int().min(1).max(10000).default(1),
  sortOrder: z.number().int().optional(),
});

const ComponentPatch = z.object({
  quantity: z.number().int().min(1).max(10000).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

const SettingsInput = z.object({
  keepParentOnBom: z.boolean().optional(),
  /**
   * Manufacturer NAME, matching how a procurement line and a BOM section are keyed.
   * Empty string clears it — the part goes back to its own vendor at full cost.
   */
  freeIssueVendor: z.union([z.string().trim().max(160), z.null()]).optional(),
});

export function registerBomBuildRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CATALOG_READ) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };
  const handoff = { preHandler: requirePermission(Permission.HANDOFF_MANAGE) };

  /**
   * Description, cost and vendor for a set of parts, read across BOTH catalog
   * records. A part can exist as a `Sku` (the flat priced record), as a `Product`
   * (the rich record, cost in ProductCost history, weight in ounces), or as both.
   * Reading Sku alone reported a Product-only part like P-2526 as not in the catalog
   * while the Catalog tab showed it plainly.
   */
  async function describe(parts: string[]) {
    const out = new Map<
      string,
      { description: string; unitCostMinor: number; manufacturer: string | null }
    >();
    if (!parts.length) return out;

    const [skus, products] = await Promise.all([
      prisma.sku.findMany({
        where: { part: { in: parts } },
        select: { part: true, description: true, unitCostMinor: true, manufacturer: true },
      }),
      prisma.product.findMany({
        where: { sku: { in: parts } },
        select: { id: true, sku: true, name: true },
      }),
    ]);
    const ids = products.map((p) => p.id);
    const [costs, sourcing] = await Promise.all([
      ids.length
        ? prisma.productCost.findMany({
            where: { productId: { in: ids } },
            select: { productId: true, unitCost: true },
            orderBy: { effectiveDate: 'desc' },
          })
        : Promise.resolve([] as Array<{ productId: string; unitCost: bigint }>),
      ids.length
        ? prisma.productSourcing.findMany({
            where: { productId: { in: ids } },
            select: { productId: true, manufacturer: { select: { name: true } } },
          })
        : Promise.resolve(
            [] as Array<{ productId: string; manufacturer: { name: string } | null }>,
          ),
    ]);
    const latestCost = new Map<string, number>();
    for (const c of costs)
      if (!latestCost.has(c.productId)) latestCost.set(c.productId, Number(c.unitCost));
    const vendorByProduct = new Map<string, string>();
    for (const s of sourcing)
      if (s.manufacturer?.name && !vendorByProduct.has(s.productId))
        vendorByProduct.set(s.productId, s.manufacturer.name);

    for (const p of products)
      out.set(p.sku.toUpperCase(), {
        description: p.name,
        unitCostMinor: latestCost.get(p.id) ?? 0,
        manufacturer: vendorByProduct.get(p.id) ?? null,
      });
    for (const s of skus) {
      const floor = out.get(s.part.toUpperCase());
      out.set(s.part.toUpperCase(), {
        description: s.description || floor?.description || '',
        unitCostMinor: s.unitCostMinor || floor?.unitCostMinor || 0,
        manufacturer: s.manufacturer || floor?.manufacturer || null,
      });
    }
    return out;
  }

  /**
   * Every part that carries a rule, with its components. Parts whose only rule is
   * free issue are listed too — otherwise a free-issue part would be configured and
   * then invisible.
   */
  app.get('/bom-build', read, async () => {
    const [comps, flagged] = await Promise.all([
      prisma.skuComponent.findMany({
        orderBy: [{ parentPart: 'asc' }, { sortOrder: 'asc' }, { childPart: 'asc' }],
      }),
      prisma.sku.findMany({
        where: { OR: [{ keepParentOnBom: true }, { NOT: { freeIssueVendor: null } }] },
        select: { part: true, keepParentOnBom: true, freeIssueVendor: true },
      }),
    ]);

    const parents = new Map<
      string,
      {
        parentPart: string;
        name: string;
        keepParentOnBom: boolean;
        freeIssueVendor: string | null;
        components: Array<{
          id: string;
          childPart: string;
          name: string;
          quantity: number;
          unitCostMinor: number | null;
          vendor: string | null;
          active: boolean;
          /** True when the component is not in the SKU master — it will cost $0. */
          unknown: boolean;
        }>;
      }
    >();

    const info = await describe([
      ...new Set([
        ...comps.map((c) => c.parentPart.toUpperCase()),
        ...comps.map((c) => c.childPart.toUpperCase()),
        ...flagged.map((f) => f.part.toUpperCase()),
      ]),
    ]);
    const settingOf = new Map(flagged.map((f) => [f.part.toUpperCase(), f]));

    const ensure = (part: string) => {
      const k = part.toUpperCase();
      let row = parents.get(k);
      if (!row) {
        const s = settingOf.get(k);
        row = {
          parentPart: k,
          name: info.get(k)?.description ?? '',
          keepParentOnBom: !!s?.keepParentOnBom,
          freeIssueVendor: s?.freeIssueVendor ?? null,
          components: [],
        };
        parents.set(k, row);
      }
      return row;
    };

    for (const c of comps) {
      const child = c.childPart.toUpperCase();
      const hit = info.get(child);
      ensure(c.parentPart).components.push({
        id: c.id,
        childPart: child,
        name: hit?.description ?? '',
        quantity: c.quantity,
        unitCostMinor: hit?.unitCostMinor ?? null,
        vendor: hit?.manufacturer ?? null,
        active: c.active,
        unknown: !hit,
      });
    }
    for (const f of flagged) ensure(f.part);

    return {
      parents: [...parents.values()].sort((a, b) => a.parentPart.localeCompare(b.parentPart)),
    };
  });

  app.post('/bom-build/components', admin, async (req, reply) => {
    const parsed = ComponentInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid component');
    const { parentPart, childPart, quantity, sortOrder } = parsed.data;
    if (parentPart === childPart)
      throw new ValidationError('A part cannot be a component of itself.');

    // A cycle would make the BOM expansion terminate early and silently drop parts.
    // Cheaper to refuse it here than to explain it later.
    const all = await prisma.skuComponent.findMany({
      where: { active: true },
      select: { parentPart: true, childPart: true },
    });
    const kids = new Map<string, string[]>();
    for (const c of all) {
      const k = c.parentPart.toUpperCase();
      kids.set(k, (kids.get(k) ?? []).concat(c.childPart.toUpperCase()));
    }
    const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (kids.get(from) ?? []).some((c) => reaches(c, target, seen));
    };
    if (reaches(childPart, parentPart))
      throw new ValidationError(
        `${childPart} already contains ${parentPart}, so adding it here would make a loop.`,
      );

    const existing = await prisma.skuComponent.findUnique({
      where: { parentPart_childPart: { parentPart, childPart } },
    });
    if (existing) throw new ConflictError(`${childPart} is already a component of ${parentPart}.`);

    const count = await prisma.skuComponent.count({ where: { parentPart } });
    const row = await prisma.skuComponent.create({
      data: { parentPart, childPart, quantity, sortOrder: sortOrder ?? count },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'bomBuild.component.add',
      entity: 'SkuComponent',
      entityId: row.id,
      details: { parentPart, childPart, quantity },
    });
    reply.code(201);
    return row;
  });

  app.patch('/bom-build/components/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ComponentPatch.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid component');
    const before = await prisma.skuComponent.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Component not found');
    const row = await prisma.skuComponent.update({ where: { id }, data: parsed.data });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'bomBuild.component.update',
      entity: 'SkuComponent',
      entityId: id,
      details: { parentPart: before.parentPart, childPart: before.childPart, patch: parsed.data },
    });
    return row;
  });

  app.delete('/bom-build/components/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const before = await prisma.skuComponent.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Component not found');
    await prisma.skuComponent.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'bomBuild.component.remove',
      entity: 'SkuComponent',
      entityId: id,
      details: { parentPart: before.parentPart, childPart: before.childPart },
    });
    reply.code(204);
  });

  /**
   * The two per-part flags. The part must exist in the SKU master — both settings
   * are read by part number, and a typo would be a rule that never fires.
   */
  app.patch('/bom-build/settings/:part', admin, async (req) => {
    const part = String((req.params as { part: string }).part || '')
      .trim()
      .toUpperCase();
    const parsed = SettingsInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid setting');
    /**
     * Both flags live on the flat Sku row, because that is the record the BOM build
     * engine reads. A part carried only as a Product has no such row yet — the same
     * situation Catalog → Pricing handles by creating one on demand, so this does the
     * same rather than refusing a part the catalog plainly has.
     */
    let sku = await prisma.sku.findUnique({ where: { part } });
    if (!sku) {
      const product = await prisma.product.findUnique({
        where: { sku: part },
        select: { id: true, name: true },
      });
      if (!product)
        throw new NotFoundError(
          `${part} is not in the catalog — neither a product nor a SKU. Add it under Catalog first.`,
        );
      const src = await prisma.productSourcing.findFirst({
        where: { productId: product.id },
        select: { manufacturer: { select: { name: true } } },
      });
      sku = await prisma.sku.create({
        data: {
          part,
          description: product.name || part,
          category: 'OTHER',
          manufacturer: src?.manufacturer?.name ?? null,
        },
      });
    }

    const data: { keepParentOnBom?: boolean; freeIssueVendor?: string | null } = {};
    if (parsed.data.keepParentOnBom !== undefined)
      data.keepParentOnBom = parsed.data.keepParentOnBom;
    if (parsed.data.freeIssueVendor !== undefined) {
      const v = (parsed.data.freeIssueVendor || '').trim();
      if (v) {
        // Checked against the manufacturer list because BOM sections are keyed by
        // vendor NAME: a name that is not a vendor of record would create a section
        // nobody maintains.
        const mfr = await prisma.manufacturer.findFirst({ where: { name: v } });
        if (!mfr)
          throw new ValidationError(
            `"${v}" is not a manufacturer on record. Add the vendor first under Catalog → Manufacturers.`,
          );
      }
      data.freeIssueVendor = v || null;
    }
    const row = await prisma.sku.update({
      where: { part },
      data,
      select: { part: true, description: true, keepParentOnBom: true, freeIssueVendor: true },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'bomBuild.settings.update',
      entity: 'Sku',
      entityId: part,
      details: data,
    });
    return row;
  });

  /**
   * Re-apply the rules to an order that is already locked, so a kit declared today
   * reaches an order locked last week. Idempotent; leaves the proposal alone.
   */
  app.post('/orders/:id/bom/apply-build', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const order = await prisma.acceptedOrder.findUnique({ where: { id }, select: { id: true } });
    if (!order) throw new NotFoundError('Order not found');
    const result = await applyBomBuildToOrder(id, req.user!.sub);
    return result;
  });
}
