import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { computeAdventureProposal, explainAdventure, frameModelNumber, frameDimensions, type AdvAnswers, type SkuRec } from '../proposals/adventureSeries.js';

/** Server-side Adventure Series pricing engine: answers -> priced, grouped lines.
 *  Prices/weights/costs are read live from the Sku table (editable in Catalog → Pricing & SKUs). */
export function registerAdventureRoutes(app: FastifyInstance): void {
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };

  async function skuMap(): Promise<Record<string, SkuRec>> {
    const [rows, products, costs] = await Promise.all([
      prisma.sku.findMany(),
      prisma.product.findMany({ select: { id: true, sku: true, weightOz: true } }),
      prisma.productCost.findMany({ select: { productId: true, unitCost: true, effectiveDate: true }, orderBy: { effectiveDate: 'desc' } }),
    ]);
    // Costs and weights imported from the product workbook live on ProductCost /
    // Product.weightOz; use them when the flat SKU row has none of its own.
    const latestCost: Record<string, number> = {};
    for (const c of costs) if (latestCost[c.productId] === undefined) latestCost[c.productId] = Number(c.unitCost);
    const byPart: Record<string, { cost: number; weightLbs: number }> = {};
    for (const p of products) {
      byPart[p.sku] = { cost: latestCost[p.id] || 0, weightLbs: p.weightOz ? p.weightOz / 16 : 0 };
    }
    const map: Record<string, SkuRec> = {};
    for (const r of rows) {
      const fb = byPart[r.part];
      map[r.part] = {
        part: r.part, description: r.description, unitPriceMinor: r.unitPriceMinor,
        unitCostMinor: r.unitCostMinor || (fb ? fb.cost : 0),
        weightLbs: r.weightLbs || (fb ? fb.weightLbs : 0),
        category: r.category,
      };
    }
    return map;
  }

  app.post('/proposals/adventure-series/price', write, async (req) => {
    const a = (req.body || {}) as AdvAnswers;
    const out = computeAdventureProposal(a, await skuMap());
    return { ...out, frameModel: frameModelNumber(a), frameDimensions: frameDimensions(a) };
  });

  /** Logic trace: every derived quantity, the expression behind it, and the live
   *  price/cost it was multiplied by — for cross-referencing against the workbook. */
  app.post('/proposals/adventure-series/trace', write, async (req) => {
    const a = (req.body || {}) as AdvAnswers;
    return explainAdventure(a, await skuMap());
  });
}
