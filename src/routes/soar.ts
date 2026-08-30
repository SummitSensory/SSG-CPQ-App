import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import {
  computeSoarProposal,
  SOAR_FRAMES,
  SOAR_PAD_ROWS,
  type SoarAnswers,
  type SoarSkuRec,
} from '../proposals/soarSeries.js';

/** Server-side Summit Soar pricing engine: answers -> priced, grouped lines.
 *  Prices, costs and weights are read live from the catalog. */
export function registerSoarRoutes(app: FastifyInstance): void {
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };

  /**
   * Sku is the proposal-side price list and the authority on price. Product carries
   * the catalog tree, dimensions and weight, and ProductCost carries COGS — they fill
   * in weight/cost for a part whose Sku row has none, but never price.
   */
  async function skuMap(): Promise<Record<string, SoarSkuRec>> {
    const [rows, products, costs] = await Promise.all([
      prisma.sku.findMany({
        select: {
          part: true,
          description: true,
          unitPriceMinor: true,
          unitCostMinor: true,
          weightLbs: true,
          category: true,
        },
      }),
      prisma.product.findMany({ select: { id: true, sku: true, name: true, weightOz: true } }),
      prisma.productCost.findMany({
        select: { productId: true, unitCost: true, effectiveDate: true },
        orderBy: { effectiveDate: 'desc' },
      }),
    ]);
    const latestCost: Record<string, number> = {};
    for (const c of costs)
      if (latestCost[c.productId] === undefined) latestCost[c.productId] = Number(c.unitCost);
    const map: Record<string, SoarSkuRec> = {};
    for (const p of products) {
      map[p.sku] = {
        part: p.sku,
        description: p.name,
        unitPriceMinor: 0,
        unitCostMinor: latestCost[p.id] || 0,
        weightLbs: p.weightOz ? p.weightOz / 16 : 0,
      };
    }
    for (const r of rows) {
      const prev = map[r.part];
      map[r.part] = {
        part: r.part,
        description: r.description,
        unitPriceMinor: r.unitPriceMinor,
        unitCostMinor: r.unitCostMinor || (prev ? prev.unitCostMinor : 0),
        weightLbs: r.weightLbs || (prev ? prev.weightLbs : 0),
        category: r.category,
      };
    }
    return map;
  }

  /** Everything the builder needs to render: the eight frames and the padding rows,
   *  each with a live price, so the rep sees real money before pricing runs. */
  app.get('/proposals/soar-series/catalog', read, async () => {
    const skus = await skuMap();
    const decorate = (part: string) => {
      const rec = skus[part];
      return {
        description: rec ? rec.description : part,
        unitPriceMinor: rec ? rec.unitPriceMinor : 0,
        weightLbs: rec ? rec.weightLbs : 0,
        inCatalog: !!(rec && rec.unitPriceMinor > 0),
      };
    };
    return {
      frames: SOAR_FRAMES.map((f) => ({ ...f, ...decorate(f.part) })),
      padRows: SOAR_PAD_ROWS.map((r) => ({ ...r, ...decorate(r.part) })),
    };
  });

  app.post('/proposals/soar-series/price', write, async (req) => {
    const a = (req.body || {}) as SoarAnswers;
    return computeSoarProposal(a, await skuMap());
  });
}
