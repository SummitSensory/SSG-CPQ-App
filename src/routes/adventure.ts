import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { computeAdventureProposal, type AdvAnswers, type SkuRec } from '../proposals/adventureSeries.js';

/** Server-side Adventure Series pricing engine: answers -> priced, grouped lines.
 *  Prices/weights are read live from the Sku table (editable via import/editor/sync). */
export function registerAdventureRoutes(app: FastifyInstance): void {
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };
  app.post('/proposals/adventure-series/price', write, async (req) => {
    const a = (req.body || {}) as AdvAnswers;
    const rows = await prisma.sku.findMany();
    const map: Record<string, SkuRec> = {};
    for (const r of rows) map[r.part] = { part: r.part, description: r.description, unitPriceMinor: r.unitPriceMinor, weightLbs: r.weightLbs, category: r.category };
    return computeAdventureProposal(a, map);
  });
}
