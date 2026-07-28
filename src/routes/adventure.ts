import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { computeAdventureProposal, explainAdventure, frameModelNumber, frameDimensions, type AdvAnswers, type SkuRec } from '../proposals/adventureSeries.js';
import { loadFormulaRules } from './formulas.js';

/** Server-side Adventure Series pricing engine: answers -> priced, grouped lines.
 *  Prices/weights/costs are read live from the Sku table (editable in Catalog → Pricing & SKUs). */
export function registerAdventureRoutes(app: FastifyInstance): void {
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };

  async function skuMap(): Promise<Record<string, SkuRec>> {
    const [rows, products, costs, place] = await Promise.all([
      prisma.sku.findMany(),
      prisma.product.findMany({ select: { id: true, sku: true, weightOz: true } }),
      prisma.productCost.findMany({ select: { productId: true, unitCost: true, effectiveDate: true }, orderBy: { effectiveDate: 'desc' } }),
      placements(),
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
      const pl = place[r.part];
      map[r.part] = {
        part: r.part, description: r.description, unitPriceMinor: r.unitPriceMinor,
        unitCostMinor: r.unitCostMinor || (fb ? fb.cost : 0),
        weightLbs: r.weightLbs || (fb ? fb.weightLbs : 0),
        category: r.category,
        proposalGroup: (pl ? pl.group : '') || r.proposalGroup || undefined,
        proposalSubgroup: pl ? pl.subgroup || undefined : undefined,
      };
    }
    return map;
  }

  /**
   * Where the catalog files each part: tier 1 is the proposal group, tier 2 the
   * subgroup. The engine reads this so a part shows up under the heading it is
   * filed under in Catalog, instead of the heading the engine happened to hardcode.
   */
  async function placements(): Promise<Record<string, { group: string; subgroup: string }>> {
    const [cats, products] = await Promise.all([
      prisma.productCategory.findMany({ select: { id: true, name: true, parentId: true, productId: true } }),
      prisma.product.findMany({ select: { id: true, sku: true } }),
    ]);
    const byId = new Map(cats.map((c) => [c.id, c]));
    const skuById = new Map(products.map((p) => [p.id, p.sku]));
    const out: Record<string, { group: string; subgroup: string }> = {};
    for (const c of cats) {
      if (!c.productId) continue;
      const sku = skuById.get(c.productId);
      if (!sku) continue;
      const chain: string[] = [];
      let node: (typeof cats)[number] | undefined = c;
      while (node && chain.length < 8) {
        chain.unshift(node.name);
        node = node.parentId ? byId.get(node.parentId) : undefined;
      }
      out[sku] = { group: chain[0] || '', subgroup: chain.length > 2 ? chain[1] : '' };
    }
    return out;
  }

  /** Catalog category name → its ACTIVE part numbers, so kits print every member. */
  async function kitParts(): Promise<Record<string, string[]>> {
    const [cats, products] = await Promise.all([
      prisma.productCategory.findMany({ select: { id: true, name: true } }),
      prisma.product.findMany({ where: { status: 'ACTIVE' }, select: { sku: true, categoryId: true }, orderBy: { sku: 'asc' } }),
    ]);
    const nameById = new Map(cats.map((c) => [c.id, c.name]));
    const out: Record<string, string[]> = {};
    for (const p of products) {
      const name = nameById.get(p.categoryId);
      if (!name) continue;
      (out[name] ||= []).push(p.sku);
    }
    return out;
  }

  app.post('/proposals/adventure-series/price', write, async (req) => {
    const a = (req.body || {}) as AdvAnswers;
    const [skus, rules, kits] = await Promise.all([skuMap(), loadFormulaRules(), kitParts()]);
    const out = computeAdventureProposal(a, skus, rules.hardware, rules.frame, kits);
    return { ...out, frameModel: frameModelNumber(a), frameDimensions: frameDimensions(a) };
  });

  /** Logic trace: every derived quantity, the expression behind it, and the live
   *  price/cost it was multiplied by — for cross-referencing against the workbook. */
  app.post('/proposals/adventure-series/trace', write, async (req) => {
    const a = (req.body || {}) as AdvAnswers;
    const [skus, rules] = await Promise.all([skuMap(), loadFormulaRules()]);
    return explainAdventure(a, skus, rules.hardware, rules.frame);
  });
}
