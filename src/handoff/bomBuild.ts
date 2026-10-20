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
 *   2. PROCESSING SERVICE SUPPLIER (`Sku.processingEnabled` + `Sku.secondaryVendor`).
 *      A part bought from one vendor (its Procurement Supplier — Amazon) and shipped
 *      to another (the Processing Service Supplier — Goldberg Brothers), who
 *      repackages it and ships it on with the structure. It must be on BOTH sheets:
 *      Amazon's, because that is the purchase, and Goldberg's, because they receive,
 *      repackage and ship it. So the purchase line is left exactly where it is and ONE
 *      more line is added on the processing supplier's sheet, for the part's whole
 *      quantity, at their Repackaging Service Fee — per unit, or once per order
 *      (`costPerOrder`) — under their Repackaging SKU (`vendorPartNo`).
 *
 *      This replaced FREE ISSUE (`Sku.freeIssueVendor`), which MOVED the purchase
 *      line to the receiving vendor at $0 and so took the part off the sheet of the
 *      vendor it is bought from. Lines an order locked under free issue keep their
 *      `freeIssue` flag and still print as they did; nothing creates new ones.
 *
 * Both are applied at lock time (see createAcceptedOrder) and can be re-applied to
 * an order that was locked before the rule existed — see applyBomBuildToOrder.
 */

export interface BomBuildSeed extends ProcurementSeed {
  /** The processing supplier, on a processing line; overrides the catalog vendor. */
  vendorOverride?: string | null;
  /**
   * Wins over the catalog-resolved cost unconditionally (see
   * src/handoff/service.ts's procurement-create map). Kit components never set this —
   * the catalog cost is correct for them. Only a processing line sets it, because its
   * cost is the processing supplier's Repackaging Service Fee, which has nothing to do
   * with what the catalog says the Procurement Supplier charges for the part.
   */
  forcedUnitCostMinor?: number | null;
  /** Set on a processing line: the part it was added for. */
  secondaryOfSku?: string | null;
  /** The fee is charged once for the line rather than per unit. */
  costPerOrder?: boolean;
  /** The Repackaging SKU, printed as the part number on the processing supplier's sheet. */
  vendorPartNo?: string | null;
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

export interface ProcessingRule {
  /** The Processing Service Supplier. */
  vendor: string;
  /** The Repackaging Service Fee; null = no charge. */
  costMinor: number | null;
  /** Charged once per order rather than per unit. */
  perOrder: boolean;
  /** The Repackaging SKU, if one is on file. */
  vendorPartNo: string | null;
}

export interface BuildTables {
  /** Parent part → the parts it explodes into. */
  children: Map<string, ChildRow[]>;
  /** Parents that stay on the sheet beside their components. */
  keepParent: Set<string>;
  /** Part → the processing supplier whose sheet it ALSO appears on, and their fee. */
  processing: Map<string, ProcessingRule>;
}

/** Nothing configured: every caller treats this as "leave the order alone". */
const EMPTY_TABLES: BuildTables = {
  children: new Map(),
  keepParent: new Set(),
  processing: new Map(),
};

/** Nothing for this file to do: no kits, no processing parts. */
const noRules = (t: BuildTables): boolean => !t.children.size && !t.processing.size;

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
    // Both flags are rare, so this reads the handful of rows that carry one rather
    // than the whole SKU master.
    prisma.sku.findMany({
      where: {
        OR: [
          { keepParentOnBom: true },
          { processingEnabled: true, NOT: { secondaryVendor: null } },
        ],
      },
      select: {
        part: true,
        keepParentOnBom: true,
        processingEnabled: true,
        secondaryVendor: true,
        secondaryVendorCostMinor: true,
        processingFeeBasis: true,
        processingSku: true,
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
  const processing = new Map<string, ProcessingRule>();
  for (const s of skus) {
    if (s.keepParentOnBom) keepParent.add(key(s.part));
    const sv = (s.secondaryVendor || '').trim();
    if (s.processingEnabled && sv)
      processing.set(key(s.part), {
        vendor: sv,
        costMinor: s.secondaryVendorCostMinor,
        perOrder: s.processingFeeBasis === 'PER_ORDER',
        vendorPartNo: (s.processingSku || '').trim() || null,
      });
  }
  return { children, keepParent, processing };
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
      // Part numbers arrive upper-cased (see key()); the catalog may hold them in any case.
      where: { part: { in: parts, mode: 'insensitive' } },
      select: {
        part: true,
        description: true,
        unitCostMinor: true,
        weightLbs: true,
        manufacturer: true,
      },
    }),
    prisma.product.findMany({
      where: { sku: { in: parts, mode: 'insensitive' } },
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
          // Deterministic: a primary source first, then the oldest — the same rule
          // lock-time resolveCatalogRefs uses.
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
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
      // Zero parents means zero pieces; only a missing quantity counts as one.
      quantity: c.quantity * (seed.quantity ?? 1),
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

/**
 * The processing line for a part: ONE line on the processing supplier's sheet, for the
 * part's whole quantity on the order, at their fee and under their Repackaging SKU.
 * One rather than one per purchase line, because a per-order fee is charged once per
 * order and because the processing supplier repackages the part, not our lines. Its
 * cost is forced (see BomBuildSeed.forcedUnitCostMinor).
 */
export function processingSeed(
  sku: string,
  name: string,
  quantity: number,
  rule: ProcessingRule,
  proposalLineOrder?: number,
): BomBuildSeed {
  return {
    productId: null,
    sku,
    name,
    quantity,
    isHardwareComponent: false,
    kitSku: null,
    proposalLineOrder,
    vendorOverride: rule.vendor,
    forcedUnitCostMinor: rule.costMinor ?? 0,
    secondaryOfSku: key(sku),
    costPerOrder: rule.perOrder,
    vendorPartNo: rule.vendorPartNo,
  };
}

/**
 * Every part with a processing rule gets its processing line IN ADDITION to (never
 * instead of) its purchase lines, which come back untouched. Runs after kits explode,
 * so a component that carries the rule gets its line too.
 */
function withProcessing(seeds: BomBuildSeed[], t: BuildTables): BomBuildSeed[] {
  if (!t.processing.size) return seeds;
  const totals = new Map<string, { first: BomBuildSeed; quantity: number }>();
  for (const s of seeds) {
    const k = key(s.sku);
    if (!k || !t.processing.has(k)) continue;
    const at = totals.get(k);
    if (at) at.quantity += Number(s.quantity) || 0;
    else totals.set(k, { first: s, quantity: Number(s.quantity) || 0 });
  }
  const out = seeds.slice();
  for (const [k, { first, quantity }] of totals) {
    const rule = t.processing.get(k);
    if (!rule || quantity <= 0) continue;
    out.push(processingSeed(first.sku ?? k, first.name, quantity, rule, first.proposalLineOrder));
  }
  return out;
}

/**
 * Apply both rules to the seeds `procurementFromItems` produced. Returns the seeds
 * unchanged when no rule exists, so an order on a database with empty rule tables
 * behaves exactly as before.
 */
export async function expandBomBuild(seeds: ProcurementSeed[]): Promise<BomBuildSeed[]> {
  const t = await loadBuildTables();
  if (noRules(t)) return seeds;
  const info = await partInfo(
    reachable(
      seeds.map((s) => s.sku ?? ''),
      t,
    ),
  );
  const out: BomBuildSeed[] = [];
  for (const seed of seeds) out.push(...explode(seed, t, info, 0, []));
  return withProcessing(out, t);
}

export interface ApplyBuildResult {
  /** Parent lines replaced (or kept, when configured) by their components. */
  exploded: string[];
  /** Component lines created. */
  componentsAdded: number;
  /** Parts with a rule that were skipped because the order already has them expanded. */
  alreadyExpanded: string[];
  /** Processing lines created on a processing supplier's sheet. */
  secondaryAdded: number;
  /** Parts whose processing line was raised to cover their purchase lines. */
  secondaryTopUps: string[];
  /** Processing lines that could not be added or raised, and why (a submitted sheet). */
  secondarySkipped: string[];
  /** Retired free-issue lines put back on their Procurement Supplier's sheet. */
  freeIssueRestored: string[];
  /** Kit parents put back beside their components because they are now kept. */
  parentsRestored: string[];
}

/**
 * Re-apply the rules to an order that is already locked.
 *
 * Needed because the rules are configuration: a part declared as a kit today has to
 * be able to reach the orders locked yesterday. Idempotent — a parent whose
 * components are already on the order is skipped (its components carry `kitSku`),
 * and a part that already has its processing line is only topped up, never doubled.
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
    alreadyExpanded: [],
    secondaryAdded: 0,
    secondaryTopUps: [],
    secondarySkipped: [],
    freeIssueRestored: [],
    parentsRestored: [],
  };
  if (noRules(t)) return result;

  const lines = await prisma.procurementLine.findMany({
    where: { orderId },
    select: {
      id: true,
      sku: true,
      name: true,
      quantity: true,
      quantityOriginal: true,
      vendor: true,
      kitSku: true,
      isHardwareComponent: true,
      proposalLineOrder: true,
      secondaryOfSku: true,
    },
  });
  const expandedAlready = new Set(lines.map((l) => key(l.kitSku)).filter(Boolean));
  const onOrder = new Set(lines.map((l) => key(l.sku)).filter(Boolean));
  // Parents now marked "keep on the sheet" whose components are here but which are
  // not: locked while the rule still REPLACED the parent. A-2216 was set to keep at
  // 2026-10-19, after the orders that needed it, and re-applying skipped it as
  // already expanded — so the slide deck never came back without being re-typed.
  const keptParents = [...t.keepParent].filter((k) => expandedAlready.has(k) && !onOrder.has(k));
  const info = await partInfo(reachable(lines.map((l) => l.sku ?? '').concat(keptParents), t));

  const toCreate: BomBuildSeed[] = [];
  const toDelete: string[] = [];
  for (const l of lines) {
    // A processing line is the processing supplier's service on the part, not a
    // purchase of it: it is never exploded into components.
    if (l.secondaryOfSku) continue;
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

  for (const k of keptParents) {
    const kids = t.children.get(k) ?? [];
    // Its quantity is read back off a component: the component's ORIGINAL count over
    // what one parent takes, so a hand-edited component does not skew it.
    const kid = lines.find(
      (l) => key(l.kitSku) === k && kids.some((c) => c.childPart === key(l.sku)),
    );
    if (!kid) continue;
    const per = kids.find((c) => c.childPart === key(kid.sku))?.quantity || 1;
    const i = info.get(k);
    toCreate.push({
      productId: null,
      sku: k,
      name: i?.name || k,
      quantity: Math.max(1, Math.round((kid.quantityOriginal ?? kid.quantity) / per)),
      unitCostMinor: i?.unitCostMinor ?? null,
      unitWeightLbs: i?.weightLbs ?? null,
      proposalLineOrder: kid.proposalLineOrder ?? undefined,
    });
    result.parentsRestored.push(k);
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
    result.componentsAdded = toCreate.length - result.parentsRestored.length;
  }
  if (toDelete.length) await prisma.procurementLine.deleteMany({ where: { id: { in: toDelete } } });

  if (t.processing.size) {
    const locked = await submittedVendors(orderId);
    const now = await prisma.procurementLine.findMany({
      where: { orderId },
      select: {
        id: true,
        sku: true,
        vendor: true,
        freeIssue: true,
        purchaseVendor: true,
        secondaryOfSku: true,
      },
    });
    // An order locked under the retired free issue had the purchase line MOVED to the
    // receiving vendor, off the sheet of the vendor it is bought from. Its part is a
    // processing part now (migration 0120), so the line goes back to its Procurement
    // Supplier as an ordinary purchase — its cost was never changed — and reconcile
    // below gives the processing supplier their line. Lines on a submitted sheet are
    // the vendor's document and stay as they are.
    for (const l of now) {
      if (!l.freeIssue || l.secondaryOfSku || !t.processing.has(key(l.sku))) continue;
      const back = (l.purchaseVendor || '').trim() || info.get(key(l.sku))?.vendor || null;
      if (!back) continue;
      if (locked.has(vendorKey(l.vendor)) || locked.has(vendorKey(back))) {
        result.secondarySkipped.push(`${key(l.sku)}: free-issue line on a submitted sheet`);
        continue;
      }
      await prisma.procurementLine.update({
        where: { id: l.id },
        data: { vendor: back, freeIssue: false, purchaseVendor: null },
      });
      result.freeIssueRestored.push(key(l.sku));
    }
    // A kit parent exploded in this pass may have had its own processing line; with
    // none of that part bought any more, the fee line would bill for nothing.
    const explodedNow = new Set(
      lines.filter((l) => toDelete.includes(l.id)).map((l) => key(l.sku)),
    );
    for (const l of now) {
      const k = key(l.secondaryOfSku);
      if (!k || !explodedNow.has(k) || locked.has(vendorKey(l.vendor))) continue;
      if (now.some((x) => !x.secondaryOfSku && key(x.sku) === k && !toDelete.includes(x.id)))
        continue;
      await prisma.procurementLine.delete({ where: { id: l.id } });
    }
  }

  // Processing runs over the order as it now stands, so a component that came out of a
  // kit in this same pass gets its processing line too. ADDITIVE, never a redirect:
  // purchase lines are left exactly as they are. Re-running is safe — a part that
  // already has its processing line is only topped up to cover its purchase lines.
  if (t.processing.size) {
    const sync = await reconcileProcessingLines(orderId, t);
    result.secondaryAdded = sync.created;
    result.secondaryTopUps = sync.toppedUp;
    // Appended, not assigned: the free-issue pass above may already have reported one.
    result.secondarySkipped.push(...sync.skipped);
  }

  if (
    result.exploded.length ||
    result.secondaryAdded ||
    result.secondaryTopUps.length ||
    result.freeIssueRestored.length ||
    result.parentsRestored.length
  ) {
    await prisma.orderEvent.create({
      data: {
        orderId,
        action: 'order.bomBuildApplied',
        actorId,
        detail: {
          exploded: result.exploded,
          componentsAdded: result.componentsAdded,
          secondaryAdded: result.secondaryAdded,
          secondaryTopUps: result.secondaryTopUps,
          freeIssueRestored: result.freeIssueRestored,
          parentsRestored: result.parentsRestored,
        } as object,
      },
    });
  }
  return result;
}

/**
 * The database row for a processing line. `purchaseVendor` records the Procurement
 * Supplier, so the processing supplier's sheet can say where the part is coming from.
 */
export function processingLineData(
  orderId: string,
  seed: BomBuildSeed,
  purchaseVendor: string | null,
  unitWeightLbs: number | null = null,
) {
  return {
    orderId,
    productId: null,
    sku: seed.sku,
    name: seed.name,
    quantity: seed.quantity,
    quantityOriginal: seed.quantity,
    vendor: seed.vendorOverride ?? null,
    purchaseVendor: purchaseVendor ?? null,
    unitCostMinor: seed.forcedUnitCostMinor ?? 0,
    proposalLineOrder: seed.proposalLineOrder ?? null,
    secondaryOfSku: seed.secondaryOfSku ?? key(seed.sku),
    costPerOrder: !!seed.costPerOrder,
    vendorPartNo: seed.vendorPartNo ?? null,
    unitWeightLbs,
  };
}

/** Vendors whose section on this order is submitted: their lines are the vendor's now. */
async function submittedVendors(orderId: string): Promise<Set<string>> {
  const rows = await prisma.bomVendorSection.findMany({
    where: { orderId, status: 'SUBMITTED' },
    select: { vendor: true },
  });
  return new Set(rows.map((r) => vendorKey(r.vendor)));
}
const vendorKey = (v: string | null | undefined): string =>
  ((v && v.trim()) || 'Unassigned vendor').toLowerCase();

/**
 * Make sure every processing part on the order has a processing line covering at
 * least the units on its purchase lines: create a missing one, raise a short one.
 * Never lowers or deletes — a processing line someone trimmed by hand is theirs to
 * keep — and never touches a submitted sheet; those are reported in `skipped`.
 */
export async function reconcileProcessingLines(
  orderId: string,
  tables?: BuildTables,
): Promise<{ created: number; toppedUp: string[]; skipped: string[] }> {
  const t = tables ?? (await loadBuildTables());
  const out = { created: 0, toppedUp: [] as string[], skipped: [] as string[] };
  if (!t.processing.size) return out;
  const lines = await prisma.procurementLine.findMany({
    where: { orderId },
    select: {
      id: true,
      sku: true,
      name: true,
      quantity: true,
      vendor: true,
      proposalLineOrder: true,
      secondaryOfSku: true,
      unitWeightLbs: true,
    },
    orderBy: [{ proposalLineOrder: 'asc' }, { id: 'asc' }],
  });
  type Row = (typeof lines)[number];
  const bought = new Map<string, { first: Row; quantity: number }>();
  const processed = new Map<string, Row[]>();
  for (const l of lines) {
    if (l.secondaryOfSku) {
      const k = key(l.secondaryOfSku);
      processed.set(k, (processed.get(k) ?? []).concat(l));
      continue;
    }
    const k = key(l.sku);
    const rule = k ? t.processing.get(k) : undefined;
    // A line of the part already on the processing supplier's own sheet is theirs to
    // supply; adding a processing line beside it would print the part twice there.
    if (!rule || vendorKey(l.vendor) === vendorKey(rule.vendor)) continue;
    const at = bought.get(k);
    if (at) at.quantity += Number(l.quantity) || 0;
    else bought.set(k, { first: l, quantity: Number(l.quantity) || 0 });
  }
  if (!bought.size) return out;
  const locked = await submittedVendors(orderId);
  for (const [k, { first, quantity }] of bought) {
    const rule = t.processing.get(k);
    if (!rule || quantity <= 0) continue;
    const mine = processed.get(k) ?? [];
    const have = mine.reduce((a, l) => a + (Number(l.quantity) || 0), 0);
    if (have >= quantity) continue;
    if (!mine.length) {
      if (locked.has(vendorKey(rule.vendor))) {
        out.skipped.push(`${k}: ${rule.vendor}’s sheet is submitted`);
        continue;
      }
      const seed = processingSeed(
        first.sku ?? k,
        first.name,
        quantity,
        rule,
        first.proposalLineOrder ?? undefined,
      );
      await prisma.procurementLine.create({
        data: processingLineData(
          orderId,
          seed,
          first.vendor,
          first.unitWeightLbs == null ? null : Number(first.unitWeightLbs),
        ),
      });
      out.created += 1;
      continue;
    }
    const target = mine.find((l) => !locked.has(vendorKey(l.vendor)));
    if (!target) {
      out.skipped.push(`${k}: ${mine[0]?.vendor ?? rule.vendor}’s sheet is submitted`);
      continue;
    }
    await prisma.procurementLine.update({
      where: { id: target.id },
      data: { quantity: (Number(target.quantity) || 0) + (quantity - have) },
    });
    out.toppedUp.push(k);
  }
  return out;
}

/**
 * A purchase line's quantity moved by `delta` — edited, added by hand, or removed:
 * move the part's processing line by the same amount, so the processing supplier's
 * sheet keeps covering what is bought. Adds the processing line if the part has the
 * rule and none yet; removes it once none of the part is left on the order.
 *
 * Returns a sentence for the person who made the change when it could not follow
 * (the processing supplier's sheet is submitted), so the mismatch is said out loud
 * rather than found on the dock.
 */
export async function followPurchaseQuantity(
  orderId: string,
  sku: string | null | undefined,
  delta: number,
  lineVendor?: string | null,
): Promise<{ changed: boolean; warning: string | null }> {
  const k = key(sku);
  if (!k || !delta || !tablesAvailable()) return { changed: false, warning: null };
  const t = await loadBuildTables();
  const rule = t.processing.get(k);
  // A line sitting with the processing supplier itself is not a purchase for them to
  // repackage — reconcileProcessingLines leaves those out for the same reason.
  if (rule && lineVendor !== undefined && vendorKey(lineVendor) === vendorKey(rule.vendor))
    return { changed: false, warning: null };
  const mine = await prisma.procurementLine.findMany({
    where: { orderId, secondaryOfSku: { equals: k, mode: 'insensitive' } },
    select: { id: true, quantity: true, vendor: true },
    orderBy: { id: 'asc' },
  });
  if (!mine.length) {
    if (delta < 0 || !rule) return { changed: false, warning: null };
    const r = await reconcileProcessingLines(orderId, t);
    return {
      changed: r.created > 0 || r.toppedUp.length > 0,
      warning: r.skipped.length ? `Processing line not added — ${r.skipped.join('; ')}.` : null,
    };
  }
  const locked = await submittedVendors(orderId);
  const target = mine.find((l) => !locked.has(vendorKey(l.vendor)));
  if (!target)
    return {
      changed: false,
      warning: `${mine[0]?.vendor ?? 'The processing supplier'}’s sheet is submitted, so its line for ${k} still shows the old quantity. Unlock that sheet and correct it there.`,
    };
  const next = (Number(target.quantity) || 0) + delta;
  if (next > 0) {
    await prisma.procurementLine.update({ where: { id: target.id }, data: { quantity: next } });
    return { changed: true, warning: null };
  }
  const stillBought = (
    await prisma.procurementLine.findMany({
      where: { orderId, secondaryOfSku: null, sku: { equals: k, mode: 'insensitive' } },
      select: { vendor: true },
    })
  ).filter((l) => !rule || vendorKey(l.vendor) !== vendorKey(rule.vendor)).length;
  if (!stillBought && mine.length === 1) {
    // None of the part is left on the order: its processing line goes with it.
    await prisma.procurementLine.delete({ where: { id: target.id } });
    return { changed: true, warning: null };
  }
  await prisma.procurementLine.update({ where: { id: target.id }, data: { quantity: 1 } });
  return { changed: true, warning: null };
}
