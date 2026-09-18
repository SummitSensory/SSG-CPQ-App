import { prisma } from '../lib/prisma.js';
import type { ProcurementSeed } from './lock.js';

/**
 * BOM build rules — the two ways a Bill of Materials differs from the proposal.
 *
 * The proposal is what the customer buys. The BOM is what we order. Those are not
 * the same list, and until now the only place they were allowed to differ was the
 * H-1000 hardware kit, whose expansion was hard-coded into the proposal item's
 * `components` array. Everything else had to be asked for. This file makes both
 * differences configuration:
 *
 *   1. COMPONENTS (`SkuComponent`). A part can be declared as made up of other
 *      parts. UEU-HARKIT is one line on the proposal and four purchasable parts on
 *      the BOM. The parent is REPLACED by its components unless
 *      `Sku.keepParentOnBom` is set, because the parent's cost is by definition the
 *      sum of its children and keeping both would double it. Nesting is supported
 *      (a component may itself have components) to a depth of six, and a cycle
 *      stops rather than recursing.
 *
 *   2. FREE ISSUE (`Sku.freeIssueVendor`). A part we buy from one vendor and have
 *      shipped to another. UEU-ISTRS is bought from Productive Tool Products and
 *      delivered to Goldberg Brothers, who crate it with the structure. Summit has
 *      already paid for it, so it belongs on GOLDBERG's sheet — they need to know
 *      it is in the shipment — but at no cost, and out of Goldberg's cost total.
 *      The line keeps its real `unitCostMinor` in the database, so the order's cost
 *      of goods is unchanged; only the printed sheet and the section total suppress
 *      it. `purchaseVendor` records who we actually bought it from.
 *
 * Both are applied at lock time (see createAcceptedOrder) and can be re-applied to
 * an order that was locked before the rule existed — see applyBomBuildToOrder.
 */

export interface BomBuildSeed extends ProcurementSeed {
  /** Receiving vendor for a free-issue part; overrides the catalog vendor. */
  vendorOverride?: string | null;
  /** Who we bought it from, kept once `vendor` has been redirected. */
  purchaseVendor?: string | null;
  freeIssue?: boolean;
  /**
   * Wins over the catalog-resolved cost unconditionally (see
   * src/handoff/service.ts's procurement-create map). Free issue and kit components
   * never set this — the catalog cost is correct for them. Only a line created by
   * the secondaryVendor rule sets it, because that line's cost is what the SECOND
   * vendor charges, which has nothing to do with what the catalog says the part's
   * own (first) vendor charges for the same part number.
   */
  forcedUnitCostMinor?: number | null;
  /** Set on a line created by the secondaryVendor rule: the part it fired on. */
  secondaryOfSku?: string | null;
}

/** Deep enough for a kit of kits; shallow enough that a bad cycle cannot run away. */
const MAX_DEPTH = 6;

/** Part numbers are compared upper-cased — BOM lines carry them that way. */
const key = (p: string | null | undefined): string => (p || '').trim().toUpperCase();

interface ChildRow {
  childPart: string;
  quantity: number;
}

interface PartInfo {
  name: string;
  unitCostMinor: number;
  weightLbs: number;
  vendor: string | null;
}

interface SecondaryVendorRule {
  vendor: string;
  costMinor: number | null;
}

export interface BuildTables {
  /** Parent part → the parts it explodes into. */
  children: Map<string, ChildRow[]>;
  /** Parents that stay on the sheet beside their components. */
  keepParent: Set<string>;
  /** Part → the vendor it is shipped to at no charge. */
  freeIssueVendor: Map<string, string>;
  /** Part → the second vendor whose sheet it ALSO appears on, and what they charge. */
  secondaryVendor: Map<string, SecondaryVendorRule>;
}

/** Nothing configured: every caller treats this as "leave the order alone". */
const EMPTY_TABLES: BuildTables = {
  children: new Map(),
  keepParent: new Set(),
  freeIssueVendor: new Map(),
  secondaryVendor: new Map(),
};

/**
 * Whether the Prisma client in this process actually knows about these tables.
 *
 * It might not, in two cases that both have to degrade quietly rather than throw in
 * the middle of locking an order: a build that has not re-run `prisma generate`
 * since migration 0058, and a test that injects a partial client. Both mean the same
 * thing operationally — there are no rules — so both return no rules.
 */
function tablesAvailable(): boolean {
  const p = prisma as unknown as Record<string, { findMany?: unknown } | undefined>;
  return typeof p.skuComponent?.findMany === 'function' && typeof p.sku?.findMany === 'function';
}

export async function loadBuildTables(): Promise<BuildTables> {
  if (!tablesAvailable()) return EMPTY_TABLES;
  const [comps, skus] = await Promise.all([
    prisma.skuComponent.findMany({
      where: { active: true },
      orderBy: [{ parentPart: 'asc' }, { sortOrder: 'asc' }, { childPart: 'asc' }],
      select: { parentPart: true, childPart: true, quantity: true },
    }),
    // All three flags are rare, so this reads the handful of rows that carry one
    // rather than the whole SKU master.
    prisma.sku.findMany({
      where: {
        OR: [
          { keepParentOnBom: true },
          { NOT: { freeIssueVendor: null } },
          { NOT: { secondaryVendor: null } },
        ],
      },
      select: {
        part: true,
        keepParentOnBom: true,
        freeIssueVendor: true,
        secondaryVendor: true,
        secondaryVendorCostMinor: true,
      },
    }),
  ]);

  const children = new Map<string, ChildRow[]>();
  for (const c of comps) {
    const k = key(c.parentPart);
    const child = key(c.childPart);
    if (!k || !child) continue;
    const list = children.get(k) ?? [];
    list.push({ childPart: child, quantity: c.quantity > 0 ? c.quantity : 1 });
    children.set(k, list);
  }

  const keepParent = new Set<string>();
  const freeIssueVendor = new Map<string, string>();
  const secondaryVendor = new Map<string, SecondaryVendorRule>();
  for (const s of skus) {
    if (s.keepParentOnBom) keepParent.add(key(s.part));
    const v = (s.freeIssueVendor || '').trim();
    if (v) freeIssueVendor.set(key(s.part), v);
    const sv = (s.secondaryVendor || '').trim();
    if (sv) secondaryVendor.set(key(s.part), { vendor: sv, costMinor: s.secondaryVendorCostMinor });
  }
  return { children, keepParent, freeIssueVendor, secondaryVendor };
}

/** Every part reachable from `roots` through the component table, roots included. */
function reachable(roots: string[], t: BuildTables): string[] {
  const seen = new Set<string>();
  const queue = roots.map(key).filter(Boolean);
  while (queue.length) {
    const p = queue.shift() as string;
    if (seen.has(p)) continue;
    seen.add(p);
    for (const c of t.children.get(p) ?? []) if (!seen.has(c.childPart)) queue.push(c.childPart);
  }
  return [...seen];
}

/** Ounces on the Product record; pounds everywhere a BOM is concerned. */
const lbsFromOz = (oz: number | null | undefined): number =>
  oz ? Math.round((oz / 16) * 1000) / 1000 : 0;

/**
 * Description, cost, weight and vendor for a set of parts.
 *
 * Read across BOTH catalog records, because the catalog has two and a part may be in
 * either. `Sku` is the flat priced record the proposal engine multiplies against.
 * `Product` is the rich record — name, category, sourcing — and a part can exist
 * only there, with its cost in `ProductCost` history and its weight in ounces on the
 * product. P-2526 is one of those: it shows in the catalog as a Product, and reading
 * `Sku` alone made it look like a part number that did not exist.
 *
 * Where both records exist, Sku owns the money and Product is the fallback. A part in
 * neither still becomes a line — it carries its own part number as the description and
 * no cost, which is visible on the sheet and fixable in the catalog.
 */
async function partInfo(parts: string[]): Promise<Map<string, PartInfo>> {
  const out = new Map<string, PartInfo>();
  if (!parts.length || !tablesAvailable()) return out;

  const [skus, products] = await Promise.all([
    prisma.sku.findMany({
      where: { part: { in: parts } },
      select: {
        part: true,
        description: true,
        unitCostMinor: true,
        weightLbs: true,
        manufacturer: true,
      },
    }),
    prisma.product.findMany({
      where: { sku: { in: parts } },
      select: { id: true, sku: true, name: true, weightOz: true },
    }),
  ]);

  const productIds = products.map((p) => p.id);
  const [costs, sourcing] = await Promise.all([
    productIds.length
      ? prisma.productCost.findMany({
          where: { productId: { in: productIds } },
          select: { productId: true, unitCost: true },
          orderBy: { effectiveDate: 'desc' },
        })
      : Promise.resolve([] as Array<{ productId: string; unitCost: bigint }>),
    productIds.length
      ? prisma.productSourcing.findMany({
          where: { productId: { in: productIds } },
          select: { productId: true, manufacturer: { select: { name: true } } },
        })
      : Promise.resolve([] as Array<{ productId: string; manufacturer: { name: string } | null }>),
  ]);

  const latestCost = new Map<string, number>();
  for (const c of costs)
    if (!latestCost.has(c.productId)) latestCost.set(c.productId, Number(c.unitCost));
  const vendorByProduct = new Map<string, string>();
  for (const s of sourcing)
    if (s.manufacturer?.name && !vendorByProduct.has(s.productId))
      vendorByProduct.set(s.productId, s.manufacturer.name);

  // Product first as the floor, then Sku over the top wherever it carries a figure.
  for (const p of products)
    out.set(key(p.sku), {
      name: p.name,
      unitCostMinor: latestCost.get(p.id) ?? 0,
      weightLbs: lbsFromOz(p.weightOz),
      vendor: vendorByProduct.get(p.id) ?? null,
    });
  for (const r of skus) {
    const floor = out.get(key(r.part));
    out.set(key(r.part), {
      name: r.description || floor?.name || '',
      unitCostMinor: r.unitCostMinor || floor?.unitCostMinor || 0,
      weightLbs: Number(r.weightLbs) || floor?.weightLbs || 0,
      vendor: r.manufacturer || floor?.vendor || null,
    });
  }
  return out;
}

function explode(
  seed: BomBuildSeed,
  t: BuildTables,
  info: Map<string, PartInfo>,
  depth: number,
  trail: string[],
): BomBuildSeed[] {
  const k = key(seed.sku);
  const kids = k ? t.children.get(k) : undefined;
  // No rule, too deep, or the graph loops back on itself: the line stands as it is.
  if (!kids || !kids.length || depth >= MAX_DEPTH || trail.indexOf(k) !== -1) return [seed];

  const rows: BomBuildSeed[] = [];
  if (t.keepParent.has(k)) rows.push(seed);
  for (const c of kids) {
    const i = info.get(c.childPart);
    const child: BomBuildSeed = {
      productId: null,
      sku: c.childPart,
      name: i?.name || c.childPart,
      // The parent's quantity multiplies through: two kits means twice the pieces.
      quantity: c.quantity * (seed.quantity || 1),
      // Hardware components keep their flag so the sheet can style/group them as
      // hardware; a generic kit's components are ordinary lines under their own vendor.
      isHardwareComponent: !!seed.isHardwareComponent,
      kitSku: seed.sku ?? null,
      unitCostMinor: i?.unitCostMinor ?? null,
      unitWeightLbs: i?.weightLbs ?? null,
      // Inherited rather than recomputed: a kit's components print at the position
      // the kit itself held on the proposal, not scattered by part number.
      proposalLineOrder: seed.proposalLineOrder,
    };
    rows.push(...explode(child, t, info, depth + 1, trail.concat(k)));
  }
  return rows;
}

function withFreeIssue(s: BomBuildSeed, t: BuildTables): BomBuildSeed {
  const v = t.freeIssueVendor.get(key(s.sku));
  if (!v) return s;
  return { ...s, freeIssue: true, vendorOverride: v };
}

/**
 * A part with a secondaryVendor rule gets a SECOND line on that vendor's sheet, in
 * addition to (not instead of) its own line — the opposite of withFreeIssue above,
 * which redirects. The new line's cost is forced to what the second vendor charges
 * (possibly $0, a receiving note) regardless of what the catalog says the part's own
 * vendor charges for the same part number; see BomBuildSeed.forcedUnitCostMinor.
 */
function withSecondaryVendor(seeds: BomBuildSeed[], t: BuildTables): BomBuildSeed[] {
  if (!t.secondaryVendor.size) return seeds;
  const out: BomBuildSeed[] = [];
  for (const s of seeds) {
    out.push(s);
    const rule = t.secondaryVendor.get(key(s.sku));
    if (!rule) continue;
    out.push({
      productId: null,
      sku: s.sku,
      name: s.name,
      quantity: s.quantity,
      isHardwareComponent: false,
      kitSku: null,
      proposalLineOrder: s.proposalLineOrder,
      vendorOverride: rule.vendor,
      forcedUnitCostMinor: rule.costMinor ?? 0,
      secondaryOfSku: key(s.sku),
    });
  }
  return out;
}

/**
 * Apply all three rules to the seeds `procurementFromItems` produced. Returns the
 * seeds unchanged when no rule exists, so an order on a database with empty rule
 * tables behaves exactly as before.
 */
export async function expandBomBuild(seeds: ProcurementSeed[]): Promise<BomBuildSeed[]> {
  const t = await loadBuildTables();
  if (!t.children.size && !t.freeIssueVendor.size && !t.secondaryVendor.size) return seeds;
  const info = await partInfo(
    reachable(
      seeds.map((s) => s.sku ?? ''),
      t,
    ),
  );
  const out: BomBuildSeed[] = [];
  for (const seed of seeds) out.push(...explode(seed, t, info, 0, []));
  return withSecondaryVendor(
    out.map((s) => withFreeIssue(s, t)),
    t,
  );
}

export interface ApplyBuildResult {
  /** Parent lines replaced (or kept, when configured) by their components. */
  exploded: string[];
  /** Component lines created. */
  componentsAdded: number;
  /** Lines moved onto their receiving vendor's sheet at no cost. */
  redirected: number;
  /** Parts with a rule that were skipped because the order already has them expanded. */
  alreadyExpanded: string[];
  /** New lines created on a second vendor's sheet by the secondaryVendor rule. */
  secondaryAdded: number;
}

/**
 * Re-apply the rules to an order that is already locked.
 *
 * Needed because the rules are configuration: a part declared as a kit today has to
 * be able to reach the orders locked yesterday. Idempotent — a parent whose
 * components are already on the order is skipped (its components carry `kitSku`),
 * and a line already sitting with its receiving vendor is left alone.
 *
 * The accepted proposal is not touched. This changes only what we purchase.
 */
export async function applyBomBuildToOrder(
  orderId: string,
  actorId: string,
): Promise<ApplyBuildResult> {
  const t = await loadBuildTables();
  const result: ApplyBuildResult = {
    exploded: [],
    componentsAdded: 0,
    redirected: 0,
    alreadyExpanded: [],
    secondaryAdded: 0,
  };
  if (!t.children.size && !t.freeIssueVendor.size && !t.secondaryVendor.size) return result;

  const lines = await prisma.procurementLine.findMany({
    where: { orderId },
    select: {
      id: true,
      sku: true,
      name: true,
      quantity: true,
      vendor: true,
      kitSku: true,
      freeIssue: true,
      purchaseVendor: true,
      isHardwareComponent: true,
      proposalLineOrder: true,
    },
  });
  const expandedAlready = new Set(lines.map((l) => key(l.kitSku)).filter(Boolean));
  const info = await partInfo(
    reachable(
      lines.map((l) => l.sku ?? ''),
      t,
    ),
  );

  const toCreate: BomBuildSeed[] = [];
  const toDelete: string[] = [];
  for (const l of lines) {
    const k = key(l.sku);
    const kids = k ? t.children.get(k) : undefined;
    if (!kids || !kids.length) continue;
    if (expandedAlready.has(k)) {
      result.alreadyExpanded.push(k);
      continue;
    }
    const seed: BomBuildSeed = {
      productId: null,
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      isHardwareComponent: l.isHardwareComponent,
      kitSku: l.kitSku,
      // A rule added after the order was locked still explodes at the parent's
      // existing position, rather than the new fasteners losing it.
      proposalLineOrder: l.proposalLineOrder ?? undefined,
    };
    const rows = explode(seed, t, info, 0, []).filter((r) => key(r.sku) !== k);
    if (!rows.length) continue;
    result.exploded.push(k);
    toCreate.push(...rows);
    if (!t.keepParent.has(k)) toDelete.push(l.id);
  }

  if (toCreate.length) {
    await prisma.procurementLine.createMany({
      data: toCreate.map((p) => {
        const i = info.get(key(p.sku));
        return {
          orderId,
          productId: null,
          sku: p.sku,
          name: p.name,
          quantity: p.quantity,
          quantityOriginal: p.quantity,
          vendor: i?.vendor ?? null,
          unitCostMinor: p.unitCostMinor ?? null,
          unitWeightLbs: p.unitWeightLbs ?? null,
          isHardwareComponent: !!p.isHardwareComponent,
          kitSku: p.kitSku ?? null,
          proposalLineOrder: p.proposalLineOrder ?? null,
        };
      }),
    });
    result.componentsAdded = toCreate.length;
  }
  if (toDelete.length) await prisma.procurementLine.deleteMany({ where: { id: { in: toDelete } } });

  // Free issue runs over the order as it now stands, so a component that came out of
  // a kit in this same pass is redirected too.
  if (t.freeIssueVendor.size) {
    const after = await prisma.procurementLine.findMany({
      where: { orderId },
      select: { id: true, sku: true, vendor: true, freeIssue: true, purchaseVendor: true },
    });
    for (const l of after) {
      const v = t.freeIssueVendor.get(key(l.sku));
      if (!v) continue;
      if (l.freeIssue && (l.vendor || '') === v) continue;
      await prisma.procurementLine.update({
        where: { id: l.id },
        data: {
          vendor: v,
          freeIssue: true,
          // Only recorded the first time, so a re-run cannot overwrite the real
          // purchase vendor with the receiving one.
          purchaseVendor: l.purchaseVendor ?? l.vendor ?? null,
        },
      });
      result.redirected += 1;
    }
  }

  // Secondary vendor runs over the order as it now stands too, for the same reason
  // free issue does above — a component that just came out of a kit may itself carry
  // the rule. ADDITIVE, not a redirect: the matched line is left exactly as it is,
  // and a new line is created for the second vendor unless one already exists
  // (secondaryOfSku), so re-running this is safe.
  if (t.secondaryVendor.size) {
    const current = await prisma.procurementLine.findMany({
      where: { orderId },
      select: {
        sku: true,
        name: true,
        quantity: true,
        proposalLineOrder: true,
        secondaryOfSku: true,
      },
    });
    const alreadySecondary = new Set(current.map((l) => l.secondaryOfSku).filter(Boolean));
    const secondaryToCreate = current
      .filter((l) => !l.secondaryOfSku)
      .map((l) => ({ line: l, rule: t.secondaryVendor.get(key(l.sku)) }))
      .filter(
        (x): x is { line: (typeof current)[number]; rule: SecondaryVendorRule } =>
          !!x.rule && !alreadySecondary.has(key(x.line.sku)),
      );
    if (secondaryToCreate.length) {
      await prisma.procurementLine.createMany({
        data: secondaryToCreate.map(({ line, rule }) => ({
          orderId,
          productId: null,
          sku: line.sku,
          name: line.name,
          quantity: line.quantity,
          quantityOriginal: line.quantity,
          vendor: rule.vendor,
          unitCostMinor: rule.costMinor ?? 0,
          proposalLineOrder: line.proposalLineOrder ?? null,
          secondaryOfSku: key(line.sku),
        })),
      });
      result.secondaryAdded = secondaryToCreate.length;
    }
  }

  if (result.exploded.length || result.redirected || result.secondaryAdded) {
    await prisma.orderEvent.create({
      data: {
        orderId,
        action: 'order.bomBuildApplied',
        actorId,
        detail: {
          exploded: result.exploded,
          componentsAdded: result.componentsAdded,
          redirected: result.redirected,
          secondaryAdded: result.secondaryAdded,
        } as object,
      },
    });
  }
  return result;
}
