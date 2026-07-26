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
    const rows = await prisma.sku.findMany();
    const map: Record<string, SkuRec> = {};
    for (const r of rows) {
      map[r.part] = {
        part: r.part, description: r.description, unitPriceMinor: r.unitPriceMinor,
        unitCostMinor: r.unitCostMinor, weightLbs: r.weightLbs, category: r.category,
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
