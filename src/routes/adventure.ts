import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { computeAdventureProposal, explainAdventure, frameModelNumber, frameDimensions, type AdvAnswers, type SkuRec } from '../proposals/adventureSeries.js';
import { loadFormulaRules, loadFormulaSettings } from './formulas.js';

/** Server-side Adventure Series pricing engine: answers -> priced, grouped lines.
 *  Prices/weights/costs are read live from the Sku table (editable in Catalog → Pricing & SKUs). */
export function registerAdventureRoutes(app: FastifyInstance): void {
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };

  /**
   * Pricing must never depend on migration timing. `overrideAllowed` arrived in
   * 0024; if the code is live before the migration is, the column is missing and a
   * bare findMany() takes the whole engine down with P2022. Read it optionally and
   * fall back to "nothing is overridable" instead.
   */
  let skuHasOverrideFlag = true;
  const SKU_COLS = {
    part: true, description: true, unitPriceMinor: true, unitCostMinor: true,
    weightLbs: true, category: true, proposalGroup: true,
  } as const;
  async function skuRows(): Promise<Array<Record<string, unknown>>> {
    if (skuHasOverrideFlag) {
      try {
        return await prisma.sku.findMany({ select: { ...SKU_COLS, overrideAllowed: true } });
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2022') throw e;
        skuHasOverrideFlag = false;
        app.log.warn('Sku.overrideAllowed is missing — run migration 0024. Part overrides are off.');
      }
    }
    return await prisma.sku.findMany({ select: SKU_COLS });
  }

  async function skuMap(): Promise<Record<string, SkuRec>> {
    const [rows, products, costs, place] = await Promise.all([
      skuRows(),
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
    for (const row of rows) {
      const r = row as {
        part: string; description: string; unitPriceMinor: number; unitCostMinor: number;
        weightLbs: number; category: string; proposalGroup: string | null; overrideAllowed?: boolean;
      };
      const fb = byPart[r.part];
      const pl = place[r.part];
      map[r.part] = {
        part: r.part, description: r.description, unitPriceMinor: r.unitPriceMinor,
        unitCostMinor: r.unitCostMinor || (fb ? fb.cost : 0),
        weightLbs: r.weightLbs || (fb ? fb.weightLbs : 0),
        category: r.category,
        proposalGroup: (pl ? pl.group : '') || r.proposalGroup || undefined,
        proposalSubgroup: pl ? pl.subgroup || undefined : undefined,
        proposalGroupSort: pl ? pl.groupSort : undefined,
        proposalSubgroupSort: pl ? pl.subSort : undefined,
        overrideAllowed: r.overrideAllowed === true,
      };
    }
    return map;
  }

  /**
   * Where the catalog files each part: tier 1 is the proposal group, tier 2 the
   * subgroup. The engine reads this so a part shows up under the heading it is
   * filed under in Catalog, instead of the heading the engine happened to hardcode.
   */
  interface Placement { group: string; subgroup: string; groupSort: number; subSort: number }

  async function placements(): Promise<Record<string, Placement>> {
    const [cats, products, skus] = await Promise.all([
      prisma.productCategory.findMany({ select: { id: true, name: true, slug: true, parentId: true, productId: true, sortOrder: true } }),
      prisma.product.findMany({ select: { id: true, sku: true, categoryId: true } }),
      prisma.sku.findMany({ select: { part: true } }),
    ]);
    const byId = new Map(cats.map((c) => [c.id, c]));
    const skuById = new Map(products.map((p) => [p.id, p.sku]));
    // A tier node can name a part the Product table has never heard of — accessory
    // parts are often only in the SKU master, so `productId` is null and the node
    // used to be skipped, which dropped the part into Hardware. Recover the part
    // from the node's slug tail so it still prints under the tier it is filed under.
    const partByTail = new Map(skus.map((s) => [s.part.toLowerCase(), s.part]));
    const out: Record<string, Placement> = {};

    type Node = (typeof cats)[number];
    /** Nodes from the outermost tier down to `startId`, inclusive. */
    const chainFrom = (startId: string | null | undefined): Node[] => {
      const chain: Node[] = [];
      let node = startId ? byId.get(startId) : undefined;
      while (node && chain.length < 8) {
        chain.unshift(node);
        node = node.parentId ? byId.get(node.parentId) : undefined;
      }
      return chain;
    };
    const place = (chain: Node[]): Placement => {
      const top = chain[0];
      const leaf = chain.length > 1 ? chain[chain.length - 1] : undefined;
      return {
        group: top ? top.name : '',
        subgroup: leaf ? leaf.name : '',
        // Tree sort order decides the order headings print in. Both default to a
        // large number so an unordered node sinks to the bottom instead of jumping
        // to the top of the proposal.
        groupSort: top ? top.sortOrder : 9_999,
        subSort: leaf ? leaf.sortOrder : 9_999,
      };
    };

    // A product filed UNDER a category is the normal case — its own category is the
    // subgroup and the outermost tier is the group. This is read from
    // Product.categoryId, which the tier-node walk below never sees: that walk only
    // finds parts a category node names directly. Missing this path is why an
    // accessory filed under, say, "Essential Carabiners & Connectors" had no group at
    // all and fell through to the Hardware block.
    for (const p of products) {
      if (!p.sku || !p.categoryId) continue;
      const chain = chainFrom(p.categoryId);
      if (!chain.length) continue;
      out[p.sku] = place(chain);
    }

    // Legacy/secondary path: the tier node itself IS the part. Its own name is the
    // product name, so placement comes from the headers above it. Does not overwrite
    // a placement already resolved from Product.categoryId.
    for (const c of cats) {
      const tail = (c.slug.split('--').pop() || '').toLowerCase();
      const sku = (c.productId ? skuById.get(c.productId) : undefined) || partByTail.get(tail);
      if (!sku || out[sku]) continue;
      out[sku] = place(chainFrom(c.parentId));
    }
    return out;
  }

  /** Catalog category name → its ACTIVE part numbers, so kits print every member.
   *  Ordered by the tree's own sortOrder, so reordering a kit in the product tree
   *  changes the order those lines print in — alphabetical-by-SKU ignored it. */
  async function kitParts(): Promise<Record<string, string[]>> {
    const [cats, products] = await Promise.all([
      prisma.productCategory.findMany({ select: { id: true, name: true } }),
      prisma.product.findMany({
        where: { status: 'ACTIVE' },
        select: { sku: true, categoryId: true },
        orderBy: [{ sortOrder: 'asc' }, { sku: 'asc' }],
      }),
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
    const [skus, rules, kits, settings] = await Promise.all([skuMap(), loadFormulaRules(), kitParts(), loadFormulaSettings()]);
    const out = computeAdventureProposal(a, skus, rules.hardware, rules.frame, kits, settings);
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
