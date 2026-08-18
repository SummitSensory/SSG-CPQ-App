import { prisma } from '../lib/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { dealItemIdFor } from '../integrations/monday/dealLink.js';
import { vendorPartLookup } from './vendorParts.js';
import {
  buildContentSnapshot,
  computeIntegrityHash,
  depositFromSnapshot,
  defaultRequirements,
  defaultTasks,
  procurementFromItems,
  type AcceptedVersionLike,
  type PriceSnapshotLike,
} from './lock.js';
import { qboGateState } from './manufacturingRelease.js';
import { versionTotals, metaOf } from '../proposals/analytics.js';
import { createNewVersion } from '../proposals/service.js';
import { loadFormulaSettings } from '../routes/formulas.js';
import { setting } from '../proposals/formulaSettings.js';
import { matProcurementRef } from '../proposals/matPricing.js';
import type {
  RequirementCategory,
  RequirementStatus,
  HandoffTaskStatus,
  HandoffStatus,
  CustomerApprovalMethod,
  Role,
  BomShipTo,
} from '@prisma/client';
import { allocateNumbered } from '../lib/documentNumber.js';

/** A catalog ref with nothing resolved — the parallel-array fallback. */
const EMPTY_REF = { sku: null, vendor: null, unitCostMinor: null, unitWeightLbs: null } as const;

/** This year's order-number prefix, and its high-water mark, for the retry loop. */
function orderNumberPrefix(year = new Date().getFullYear()): string {
  return `SO-${year}-`;
}
async function highestOrderNumber(): Promise<string | null> {
  const last = await prisma.acceptedOrder.findFirst({
    where: { number: { startsWith: orderNumberPrefix() } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  return last?.number ?? null;
}

export interface CustomerApprovalInput {
  method: CustomerApprovalMethod;
  approverName: string;
  approverTitle?: string;
  approverEmail?: string;
  poNumber?: string;
  documentRef?: string;
  ipAddress?: string;
  approvedAt: Date;
  notes?: string;
}

/**
 * Lock an ACCEPTED proposal version into an immutable operational order. The
 * order snapshots the exact accepted content + price snapshot and an integrity
 * hash, then seeds the handoff scaffold (requirements, procurement, tasks).
 * Idempotent: a version already locked returns its existing order.
 */
/**
 * Freeze the accepted proposal content into a PriceSnapshot. Uses the same math
 * as the builder and the reports (`versionTotals`), so the order's grand total can
 * never disagree with the proposal the customer signed.
 */
export async function snapshotAcceptedContent(
  versionId: string,
  sections: unknown,
  items: unknown,
  userId: string,
) {
  const t = versionTotals(items, sections);
  const meta = metaOf(sections);
  // Deposit percentage is a business number (Administration → Formulas).
  const settings = await loadFormulaSettings();
  // FormulaSettings is a Record, so the key is optional to the compiler even though
  // loadFormulaSettings() fills every key. setting() falls back to the declared
  // default (50) rather than 0, which would snapshot a zero deposit.
  const depositPct = setting(settings, 'depositPct');
  const deposit = Math.round((t.total * depositPct) / 100);
  return prisma.priceSnapshot.create({
    data: {
      subjectRef: `proposalVersion:${versionId}`,
      currency: 'USD',
      engineVersion: 'proposal-builder-1',
      input: { proposalVersionId: versionId, meta } as object,
      breakdown: {
        subtotalMinor: t.subtotal,
        discountMinor: t.discount,
        thirdPartyFreightMinor: t.tpFreight,
        taxMinor: t.tax,
        structureFreightMinor: t.structureFreight,
        matsFreightMinor: t.matsFreight,
        stdFreightMinor: t.stdFreight,
        cogsMinor: t.cogs,
        marginMinor: t.margin,
        weightLbs: t.weight,
        payment: { deposit, depositPct, balanceDueMinor: t.total - deposit },
      } as object,
      grandTotal: BigInt(t.total),
      createdById: userId,
    },
  });
}

/**
 * Resolve the catalog identity of procurement lines — part number and supplying
 * vendor. Three keys, in order of confidence: the line's productId, its part
 * number, and — for generated frame / adventure lines that carry neither — an
 * exact match on the catalog name (Product.name or Sku.description). The part
 * number IS the catalog SKU: `Product.sku` / `Sku.part`, the same value the
 * Catalog screen shows. The vendor comes from the product's sourcing record
 * (primary Manufacturer) or the SKU master's manufacturer column.
 */
export async function resolveCatalogRefs(
  lines: Array<{ productId?: string | null; sku?: string | null; name?: string | null }>,
): Promise<
  Array<{
    sku: string | null;
    vendor: string | null;
    unitCostMinor: number | null;
    unitWeightLbs: number | null;
  }>
> {
  const productIds = [...new Set(lines.map((l) => l.productId).filter((v): v is string => !!v))];
  const parts = [...new Set(lines.map((l) => l.sku).filter((v): v is string => !!v))];
  const names = [...new Set(lines.map((l) => (l.name || '').trim()).filter(Boolean))];
  if (!productIds.length && !parts.length && !names.length)
    return lines.map(() => ({ sku: null, vendor: null, unitCostMinor: null, unitWeightLbs: null }));

  const [products, skus] = await Promise.all([
    prisma.product.findMany({
      where: { OR: [{ id: { in: productIds } }, { sku: { in: parts } }, { name: { in: names } }] },
      select: {
        id: true,
        sku: true,
        name: true,
        weightOz: true,
        sourcing: { select: { isPrimary: true, manufacturer: { select: { name: true } } } },
      },
    }),
    prisma.sku.findMany({
      where: { OR: [{ part: { in: parts } }, { description: { in: names } }] },
      select: {
        part: true,
        description: true,
        manufacturer: true,
        unitCostMinor: true,
        weightLbs: true,
      },
    }),
  ]);

  type Ref = {
    sku: string | null;
    vendor: string | null;
    unitCostMinor: number | null;
    unitWeightLbs: number | null;
  };
  const vendorOf = (p: (typeof products)[number]): string | null => {
    const s = p.sourcing.find((x) => x.isPrimary) ?? p.sourcing[0];
    return s?.manufacturer?.name ?? null;
  };
  const byId = new Map<string, Ref>();
  const byPart = new Map<string, Ref>();
  const byName = new Map<string, Ref>();
  for (const p of products) {
    const ref: Ref = {
      sku: p.sku ?? null,
      vendor: vendorOf(p),
      unitCostMinor: null,
      // A product with no weight on record weighs zero for our purposes: the
      // catalog has 277 such items and no shipper is waiting on them, so a blank
      // is read as 0 lb rather than "unknown" and never blocks a freight request.
      unitWeightLbs: Math.round(((p.weightOz ?? 0) / 16) * 1000) / 1000,
    };
    byId.set(p.id, ref);
    if (p.sku && !byPart.has(p.sku)) byPart.set(p.sku, ref);
    if (p.name && !byName.has(p.name)) byName.set(p.name, ref);
  }
  for (const s of skus) {
    // The flat SKU row is where money lives, so cost and pound weight always come
    // from here; a Product match only ever wins on vendor.
    const ref: Ref = {
      sku: s.part,
      vendor: s.manufacturer ?? null,
      unitCostMinor: s.unitCostMinor ?? null,
      unitWeightLbs: s.weightLbs == null ? null : Number(s.weightLbs),
    };
    const priorPart = byPart.get(s.part);
    byPart.set(
      s.part,
      priorPart
        ? {
            sku: priorPart.sku ?? ref.sku,
            vendor: priorPart.vendor ?? ref.vendor,
            unitCostMinor: ref.unitCostMinor,
            unitWeightLbs: ref.unitWeightLbs ?? priorPart.unitWeightLbs,
          }
        : ref,
    );
    const existing = s.description ? byName.get(s.description) : undefined;
    if (s.description) {
      if (!existing) byName.set(s.description, ref);
      else
        byName.set(s.description, {
          sku: existing.sku ?? ref.sku,
          vendor: existing.vendor ?? ref.vendor,
          unitCostMinor: ref.unitCostMinor,
          unitWeightLbs: ref.unitWeightLbs ?? existing.unitWeightLbs,
        });
    }
  }

  // Mats are priced, never stocked, so no catalog row exists to resolve and the
  // line would land on the BOM as Unassigned vendor at $0.00. Derive their vendor
  // and cost from the part number instead — but only for fields the catalog left
  // blank, so adding real Resilite SKUs later simply takes over.
  const matSkus = lines.map((l) => l.sku).filter((v): v is string => !!v);
  const matSettings = matSkus.some((sku) => matProcurementRef(sku) !== null)
    ? await loadFormulaSettings()
    : null;

  return lines.map((l) => {
    const hit =
      (l.productId ? byId.get(l.productId) : undefined) ??
      (l.sku ? byPart.get(l.sku) : undefined) ??
      byName.get((l.name || '').trim());
    const byPartHit = l.sku ? byPart.get(l.sku) : undefined;
    const sku = l.sku || hit?.sku || null;
    const mat = matSettings ? matProcurementRef(sku, matSettings) : null;
    return {
      sku,
      vendor: hit?.vendor ?? mat?.vendor ?? null,
      unitCostMinor: hit?.unitCostMinor ?? byPartHit?.unitCostMinor ?? mat?.unitCostMinor ?? null,
      unitWeightLbs: hit?.unitWeightLbs ?? byPartHit?.unitWeightLbs ?? mat?.unitWeightLbs ?? null,
    };
  });
}

/**
 * Fill in part numbers, vendors, unit cost and unit weight on lines locked before
 * catalog resolution existed (or before the part was given a manufacturer).
 * Idempotent, and only ever writes a field that is still blank — an operator's
 * manual override is never overwritten.
 */
async function backfillCatalogRefs(orderId: string): Promise<void> {
  const blanks = await prisma.procurementLine.findMany({
    where: {
      orderId,
      OR: [{ vendor: null }, { sku: null }, { unitCostMinor: null }, { unitWeightLbs: null }],
    },
    select: {
      id: true,
      productId: true,
      sku: true,
      name: true,
      vendor: true,
      unitCostMinor: true,
      unitWeightLbs: true,
    },
  });
  if (!blanks.length) return;
  const refs = await resolveCatalogRefs(blanks);
  await Promise.all(
    blanks
      .map((l, i) => {
        // refs is built parallel to blanks, so this always resolves; the fallback is
        // only here to satisfy noUncheckedIndexedAccess.
        const ref = refs[i] ?? EMPTY_REF;
        const data: {
          sku?: string;
          vendor?: string;
          unitCostMinor?: number;
          unitWeightLbs?: number;
        } = {};
        if (!l.sku && ref.sku) data.sku = ref.sku;
        if (!l.vendor && ref.vendor) data.vendor = ref.vendor;
        if (l.unitCostMinor == null && ref.unitCostMinor != null)
          data.unitCostMinor = ref.unitCostMinor;
        if (l.unitWeightLbs == null && ref.unitWeightLbs != null)
          data.unitWeightLbs = ref.unitWeightLbs;
        return Object.keys(data).length
          ? prisma.procurementLine.update({ where: { id: l.id }, data })
          : null;
      })
      .filter(Boolean) as Promise<unknown>[],
  );
}

export async function createAcceptedOrder(
  versionId: string,
  approval: CustomerApprovalInput,
  userId: string,
) {
  if (!approval?.approverName?.trim())
    throw new ValidationError('Customer approver name is required');

  const existing = await prisma.acceptedOrder.findUnique({
    where: { proposalVersionId: versionId },
  });
  if (existing) return existing;

  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    include: { proposal: true },
  });
  if (!version) throw new NotFoundError('Proposal version not found');
  if (version.status !== 'ACCEPTED')
    throw new ConflictError('Only an ACCEPTED proposal version can be locked into an order');

  // Proposals built in the builder carry their priced content on the version
  // itself rather than through the pricing engine, so an accepted version often
  // has no PriceSnapshot yet. Freeze one from the accepted content at lock time —
  // that snapshot is the price of record the order and its integrity hash use.
  const snap = version.priceSnapshotId
    ? await prisma.priceSnapshot.findUnique({ where: { id: version.priceSnapshotId } })
    : await snapshotAcceptedContent(version.id, version.sections, version.items, userId);
  if (!snap) throw new NotFoundError('Price snapshot not found');
  if (!version.priceSnapshotId) {
    await prisma.proposalVersion.update({
      where: { id: version.id },
      data: { priceSnapshotId: snap.id },
    });
  }

  const vLike: AcceptedVersionLike = {
    id: version.id,
    version: version.version,
    proposalId: version.proposalId,
    sections: version.sections,
    items: version.items,
    priceSnapshotId: snap.id,
    status: version.status,
    frozen: version.frozen,
  };
  const sLike: PriceSnapshotLike = {
    id: snap.id,
    currency: snap.currency,
    grandTotal: snap.grandTotal,
    breakdown: snap.breakdown,
  };
  const contentSnapshot = buildContentSnapshot(vLike, sLike);
  const integrityHash = computeIntegrityHash(contentSnapshot);
  const depositDue = depositFromSnapshot(sLike);
  const procurement = procurementFromItems(version.items);
  const refs = await resolveCatalogRefs(procurement);

  // The deal this order belongs to, resolved at accept time and stored on the order.
  //
  // This is where the link belongs. It was previously written only by an explicit call
  // to /orders/:id/integrations, which nothing in this flow made and no screen offered —
  // so mondayProjectId was null on every order ever created, and the Bill of Materials
  // could not pull freight or tax from the deal for any of them.
  //
  // The proposal names its own opportunity, so for a customer with two concurrent
  // projects this is an answer rather than an inference. Where a proposal predates the
  // picker and names none, the shared rule falls back to the customer's most recently
  // updated linked deal and flags that it did.
  //
  // Resolved once, here, for the same reason the QuickBooks estimate reference is: the
  // deal an order was accepted against is a fact about the accept, and looking it up
  // later risks answering with whatever the board says by then. A customer with no
  // linked opportunity leaves it null and the BOM says what to do about it — a missing
  // deal must never stop an acceptance being recorded.
  const deal = await dealItemIdFor(
    version.proposal.organizationId,
    version.proposal.opportunityId,
  ).catch(() => ({
    itemId: undefined,
    opportunityId: undefined,
    note: 'the deal lookup failed',
  }));
  if (!deal.itemId) {
    logger.info(
      { versionId, organizationId: version.proposal.organizationId, reason: deal.note },
      'accept: no monday deal to link',
    );
  }

  // Order numbering is read-then-write against a unique column: two acceptances in
  // the same second allocated the same SO number and the loser threw P2002, failing
  // an acceptance that had nothing wrong with it. The number is allocated inside the
  // retry, so each attempt re-reads the high-water mark. A P2002 on
  // proposalVersionId — this version is already accepted — is rethrown untouched.
  const allocatedOrder = await allocateNumbered({
    prefix: orderNumberPrefix(),
    field: 'number',
    highest: highestOrderNumber,
    create: (number: string) =>
      prisma.$transaction(async (tx) => {
        const o = await tx.acceptedOrder.create({
          data: {
            number,
            organizationId: version.proposal.organizationId,
            proposalId: version.proposalId,
            proposalVersionId: version.id,
            acceptedVersion: version.version,
            // Both halves of the deal link. The proposal's own choice wins; opportunityId
            // was never set either, which is why an order could not name its own deal.
            opportunityId: version.proposal.opportunityId ?? deal.opportunityId ?? null,
            mondayProjectId: deal.itemId ?? null,
            priceSnapshotId: snap.id,
            ruleSnapshotId: version.ruleSnapshotId,
            currency: snap.currency,
            grandTotalMinor: snap.grandTotal,
            depositRequired: depositDue > 0n,
            depositDueMinor: depositDue,
            contentSnapshot: contentSnapshot as object,
            integrityHash,
            acceptedById: userId,
            customerApproval: {
              create: {
                method: approval.method,
                approverName: approval.approverName,
                approverTitle: approval.approverTitle ?? null,
                approverEmail: approval.approverEmail ?? null,
                poNumber: approval.poNumber ?? null,
                documentRef: approval.documentRef ?? null,
                ipAddress: approval.ipAddress ?? null,
                approvedAt: approval.approvedAt,
                notes: approval.notes ?? null,
                recordedById: userId,
              },
            },
            requirements: {
              create: defaultRequirements().map((r) => ({
                category: r.category as RequirementCategory,
                title: r.title,
                createdById: userId,
              })),
            },
            // A kit component carries its own cost and weight from the breakdown, because
            // a fastener is often not in the SKU master at all and would otherwise land on
            // the BOM at $0.00 and 0 lb.
            procurement: {
              create: procurement.map((p, i) => {
                const ref = refs[i] ?? EMPTY_REF;
                return {
                  productId: p.productId,
                  sku: ref.sku ?? p.sku,
                  name: p.name,
                  quantity: p.quantity,
                  // The formula figure, kept alongside the operational one so a later
                  // hand edit can be badged and the original recovered. They are equal
                  // at creation by definition — nothing has edited the line yet.
                  quantityOriginal: p.quantity,
                  vendor: ref.vendor,
                  unitCostMinor: ref.unitCostMinor ?? p.unitCostMinor ?? null,
                  unitWeightLbs: ref.unitWeightLbs ?? p.unitWeightLbs ?? null,
                  isHardwareComponent: !!p.isHardwareComponent,
                  kitSku: p.kitSku ?? null,
                };
              }),
            },
            tasks: {
              create: defaultTasks(depositDue > 0n).map((t) => ({
                title: t.title,
                assigneeRole: (t.assigneeRole as Role) ?? null,
                category: (t.category as RequirementCategory) ?? null,
                createdById: userId,
              })),
            },
            events: {
              create: {
                action: 'order.locked',
                actorId: userId,
                detail: { number, acceptedVersion: version.version, integrityHash } as object,
              },
            },
          },
        });
        return o;
      }),
  });
  const order = allocatedOrder.row;
  const number = allocatedOrder.number;

  await recordAudit({
    actorId: userId,
    action: 'order.lock',
    entity: 'AcceptedOrder',
    entityId: order.id,
    details: { number, proposalVersionId: version.id, integrityHash },
  });
  return order;
}

/** The order locked from a given proposal version, if there is one. */
export async function orderForVersion(versionId: string) {
  const o = await prisma.acceptedOrder.findUnique({
    where: { proposalVersionId: versionId },
    select: { id: true, number: true, status: true, acceptedVersion: true },
  });
  return o ?? null;
}

/**
 * Unlock an order so a last-minute customer change can be made. The locked order
 * is never deleted — it is CANCELLED, with the reason on the order's audit
 * timeline — and a fresh DRAFT proposal version is cloned from the accepted
 * content for the edit. The accepted version itself stays frozen as the record of
 * what was signed.
 */
export async function unlockOrder(
  orderId: string,
  opts: { reason: string; createRevision?: boolean },
  userId: string,
) {
  const reason = (opts.reason || '').trim();
  if (!reason) throw new ValidationError('A reason is required to unlock an order');

  const order = await prisma.acceptedOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError('Order not found');
  if (order.status === 'CANCELLED') throw new ConflictError('This order has already been unlocked');
  if (order.status === 'COMPLETE')
    throw new ConflictError(
      'A completed order cannot be unlocked — raise a new proposal for the change',
    );

  // A financial document already exists in QuickBooks: that has to be voided
  // there first, or the books and the order would disagree.
  const live = await prisma.qboTransaction.findFirst({
    where: { proposalId: order.proposalId, status: 'CREATED' },
    orderBy: { createdAt: 'desc' },
  });
  if (live) {
    const doc = live.qboDocNumber || live.qboId || 'created';
    throw new ConflictError(
      `A QuickBooks ${live.type.toLowerCase().replace(/_/g, ' ')} (${doc}) exists for this order. Void it in QuickBooks before unlocking.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.acceptedOrder.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });
    await tx.orderEvent.create({
      data: {
        orderId,
        action: 'order.unlocked',
        actorId: userId,
        detail: { reason, previousStatus: order.status } as object,
      },
    });
  });
  await recordAudit({
    actorId: userId,
    action: 'order.unlock',
    entity: 'AcceptedOrder',
    entityId: orderId,
    details: { number: order.number, reason, proposalVersionId: order.proposalVersionId },
  });

  // A new editable version is the point of unlocking; skip it only when the caller
  // just wants the order cancelled.
  const revision =
    opts.createRevision === false ? null : await createNewVersion(order.proposalId, userId);
  return {
    orderId,
    number: order.number,
    status: 'CANCELLED' as const,
    proposalId: order.proposalId,
    revision,
  };
}

export async function getOrder(id: string) {
  await backfillCatalogRefs(id);
  const order = await prisma.acceptedOrder.findUnique({
    where: { id },
    include: {
      customerApproval: true,
      requirements: true,
      procurement: true,
      tasks: true,
      events: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!order) throw new NotFoundError('Order not found');

  // Resolve the last editor of each requirement and task to a display name. The
  // order page shows status, person and date in one column, and an id there would
  // be useless to the person reading it.
  const editorIds = [
    ...new Set(
      [
        ...order.requirements.map((r) => r.updatedById),
        ...order.tasks.map((t) => t.updatedById),
        // Who overrode a quantity, and who released the order to manufacturing:
        // both are shown by name on the order page.
        ...order.procurement.map((p) => p.quantityEditedById),
        order.manufacturingReleasedById,
      ].filter(Boolean) as string[],
    ),
  ];
  const editors = editorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: editorIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(editors.map((u) => [u.id, u.name]));

  // Where each part can be bought. Lives on the SKU, not the line, so it is
  // resolved here — the Bill of Materials shows it as a "Buy" link.
  const parts = [...new Set(order.procurement.map((p) => p.sku).filter(Boolean) as string[])];
  const skus = parts.length
    ? await prisma.sku.findMany({
        where: { part: { in: parts } },
        select: { part: true, productUrl: true, packagingBag: true },
      })
    : [];
  const urlByPart = new Map(skus.map((s) => [s.part, s.productUrl]));
  // Which paint colour group each part belongs to. The BOM asks for a brand and a
  // code per group, so the screen has to know which lines fall in which.
  const paintRows = parts.length
    ? await prisma.paintColorGroupSku.findMany({
        where: { sku: { in: parts, mode: 'insensitive' } },
        include: { group: { select: { name: true, label: true, sortOrder: true } } },
      })
    : [];
  const paintBySku = new Map(paintRows.map((r) => [r.sku.toUpperCase(), r.group]));
  // What each vendor calls the part, where they number it differently to us. The
  // Bill of Materials screen shows it beside our number; nothing else reads it.
  const vendorParts = await vendorPartLookup(
    order.procurement.map((p) => ({
      vendor: (p.vendor && p.vendor.trim()) || 'Unassigned vendor',
      sku: p.sku,
    })),
  );
  // Which packaging bag the part ships in. Also a SKU fact, not a line fact.
  const bagByPart = new Map(skus.map((s) => [s.part, s.packagingBag]));

  // The customer name leads every BOM filename and email subject, so it travels
  // with the order rather than being fetched again by each caller.
  const org = await prisma.organization.findUnique({
    where: { id: order.organizationId },
    select: { name: true },
  });

  return {
    ...order,
    customerName: org?.name ?? '',
    /**
     * The full order value, NOT the total less the deposit — the same rule the
     * orders list follows. A deposit is a payment schedule, not a reduction in what
     * the customer owes; payments actually received live in QuickBooks.
     */
    balanceDueMinor: order.grandTotalMinor.toString(),
    manufacturingReleasedByName: order.manufacturingReleasedById
      ? (nameById.get(order.manufacturingReleasedById) ?? null)
      : null,
    procurement: order.procurement.map((p) => ({
      ...p,
      productUrl: (p.sku && urlByPart.get(p.sku)) || null,
      packagingBag: (p.sku && bagByPart.get(p.sku)) || null,
      vendorPart: vendorParts.get((p.vendor && p.vendor.trim()) || 'Unassigned vendor', p.sku),
      paintGroup: (p.sku && paintBySku.get(p.sku.toUpperCase())?.name) || null,
      paintGroupLabel: (p.sku && paintBySku.get(p.sku.toUpperCase())?.label) || null,
      quantityEditedBy: p.quantityEditedById ? (nameById.get(p.quantityEditedById) ?? null) : null,
    })),
    requirements: order.requirements.map((r) => ({
      ...r,
      updatedByName: r.updatedById ? (nameById.get(r.updatedById) ?? null) : null,
    })),
    tasks: order.tasks.map((t) => ({
      ...t,
      updatedByName: t.updatedById ? (nameById.get(t.updatedById) ?? null) : null,
    })),
  };
}

/**
 * Orders list. Each row carries the fields the list view can show as columns —
 * customer and signed date lead, the rest are opt-in from the column picker — so
 * the client never has to fan out a request per order to label a row.
 */
export async function listOrders(filter: { status?: HandoffStatus; organizationId?: string } = {}) {
  const rows = await prisma.acceptedOrder.findMany({
    where: {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.organizationId ? { organizationId: filter.organizationId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      customerApproval: true,
      tasks: { select: { status: true } },
      requirements: { select: { status: true } },
      procurement: { select: { sourced: true } },
    },
  });

  const orgIds = [...new Set(rows.map((r) => r.organizationId))];
  const proposalIds = [...new Set(rows.map((r) => r.proposalId))];
  const [orgs, proposals, invoices] = await Promise.all([
    prisma.organization.findMany({
      where: { id: { in: orgIds } },
      select: { id: true, name: true },
    }),
    prisma.proposal.findMany({
      where: { id: { in: proposalIds } },
      select: { id: true, number: true, title: true },
    }),
    // Created QuickBooks invoices for every proposal in the page, in ONE query.
    // The orders table shows whether an invoice exists and when it was generated,
    // and a lookup per row would be a query per order.
    prisma.qboTransaction.findMany({
      where: { proposalId: { in: proposalIds }, type: 'INVOICE', status: 'CREATED' },
      select: { id: true, proposalId: true, qboDocNumber: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const prop = new Map(proposals.map((p) => [p.id, p]));

  // The generated date comes from the append-only audit entry, not from the
  // transaction's updatedAt — that column moves on every later billing re-sync,
  // which would make the "generated" date creep forwards forever.
  const created = invoices.length
    ? await prisma.auditLog.findMany({
        where: {
          action: 'qbo.txn.create',
          entity: 'QboTransaction',
          entityId: { in: invoices.map((i) => i.id) },
        },
        select: { entityId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      })
    : [];
  const createdAtByTxn = new Map<string, Date>();
  for (const c of created)
    if (c.entityId && !createdAtByTxn.has(c.entityId)) createdAtByTxn.set(c.entityId, c.createdAt);

  const invoiceByProposal = new Map<string, { docNumber: string | null; generatedAt: Date }>();
  for (const inv of invoices) {
    if (invoiceByProposal.has(inv.proposalId)) continue;
    invoiceByProposal.set(inv.proposalId, {
      docNumber: inv.qboDocNumber ?? null,
      generatedAt: createdAtByTxn.get(inv.id) ?? inv.createdAt,
    });
  }

  return rows.map(({ customerApproval, tasks, requirements, procurement, ...o }) => {
    const p = prop.get(o.proposalId);
    const inv = invoiceByProposal.get(o.proposalId) ?? null;
    return {
      ...o,
      customer: orgName.get(o.organizationId) ?? null,
      signedAt: customerApproval?.approvedAt ?? null,
      approvedBy: customerApproval?.approverName ?? null,
      approvalMethod: customerApproval?.method ?? null,
      poNumber: customerApproval?.poNumber ?? null,
      proposalNumber: p?.number ?? null,
      proposalTitle: p?.title ?? null,
      // The full invoice value, NOT the total less the deposit. A deposit is a
      // payment schedule, not a reduction in what the customer owes, and showing
      // the post-deposit figure here read as though half the job had been paid for
      // before any money arrived. Payments actually received live in QuickBooks and
      // are surfaced separately.
      balanceDueMinor: o.grandTotalMinor.toString(),
      openTasks: tasks.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED').length,
      taskCount: tasks.length,
      openRequirements: requirements.filter((r) => r.status !== 'COMPLETE' && r.status !== 'WAIVED')
        .length,
      requirementCount: requirements.length,
      procurementCount: procurement.length,
      procurementSourced: procurement.filter((l) => l.sourced).length,
      // ---- QuickBooks invoice, for the two columns on the orders table ----
      qboInvoiceCreated: !!inv,
      qboInvoiceDocNumber: inv?.docNumber ?? null,
      qboInvoiceGeneratedAt: inv ? inv.generatedAt.toISOString() : null,
      // Whether the invoice requirement was deliberately skipped, so the column can
      // say "Waived" rather than showing a bare "No" that looks like an oversight.
      qboInvoiceWaived: !!o.qboInvoiceWaivedAt,
    };
  });
}

async function logEvent(
  orderId: string,
  action: string,
  actorId: string,
  detail?: Record<string, unknown>,
) {
  await prisma.orderEvent.create({
    data: { orderId, action, actorId, detail: (detail ?? {}) as object },
  });
}

/**
 * Re-verify that the order still matches the accepted proposal version. Detects
 * (defense in depth) any drift between the frozen snapshot and the live version.
 * The order total NEVER changes — this proves it.
 */
export async function verifyIntegrity(orderId: string) {
  const order = await prisma.acceptedOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError('Order not found');
  const version = await prisma.proposalVersion.findUnique({
    where: { id: order.proposalVersionId },
  });
  const snap = order.priceSnapshotId
    ? await prisma.priceSnapshot.findUnique({ where: { id: order.priceSnapshotId } })
    : null;
  if (!version || !snap)
    return {
      ok: false,
      reason: 'referenced version or snapshot missing',
      storedHash: order.integrityHash,
    };

  const rebuilt = computeIntegrityHash(
    buildContentSnapshot(
      {
        id: version.id,
        version: version.version,
        proposalId: version.proposalId,
        sections: version.sections,
        items: version.items,
        priceSnapshotId: version.priceSnapshotId,
        status: version.status,
        frozen: version.frozen,
      },
      {
        id: snap.id,
        currency: snap.currency,
        grandTotal: snap.grandTotal,
        breakdown: snap.breakdown,
      },
    ),
  );
  const ok = rebuilt === order.integrityHash && snap.grandTotal === order.grandTotalMinor;
  return {
    ok,
    storedHash: order.integrityHash,
    currentHash: rebuilt,
    totalMatches: snap.grandTotal === order.grandTotalMinor,
  };
}

// ---- Handoff sub-record management (operational data is mutable; the locked financial snapshot is not) ----

export async function addRequirement(
  orderId: string,
  input: {
    category: RequirementCategory;
    title: string;
    detail?: Record<string, unknown>;
    targetDate?: Date;
  },
  userId: string,
) {
  await getOrder(orderId);
  const r = await prisma.handoffRequirement.create({
    data: {
      orderId,
      category: input.category,
      title: input.title,
      detail: (input.detail ?? {}) as object,
      targetDate: input.targetDate ?? null,
      createdById: userId,
    },
  });
  await logEvent(orderId, 'requirement.add', userId, {
    requirementId: r.id,
    category: input.category,
  });
  return r;
}

export async function updateRequirement(
  id: string,
  patch: {
    status?: RequirementStatus;
    targetDate?: Date | null;
    detail?: Record<string, unknown>;
    isException?: boolean;
    exceptionReason?: string;
  },
  userId: string,
) {
  const existing = await prisma.handoffRequirement.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Requirement not found');
  if (patch.isException && !patch.exceptionReason?.trim())
    throw new ValidationError('An exception requires a reason');
  const r = await prisma.handoffRequirement.update({
    where: { id },
    data: {
      updatedById: userId,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.targetDate !== undefined ? { targetDate: patch.targetDate } : {}),
      ...(patch.detail ? { detail: patch.detail as object } : {}),
      ...(patch.isException !== undefined
        ? { isException: patch.isException, exceptionReason: patch.exceptionReason ?? null }
        : {}),
    },
  });
  await logEvent(existing.orderId, 'requirement.update', userId, { requirementId: id, ...patch });
  await recomputeStatus(existing.orderId, userId);
  return r;
}

export async function addTask(
  orderId: string,
  input: {
    title: string;
    description?: string;
    category?: RequirementCategory;
    assigneeId?: string;
    assigneeRole?: Role;
    dueDate?: Date;
  },
  userId: string,
) {
  await getOrder(orderId);
  const t = await prisma.handoffTask.create({
    data: {
      orderId,
      title: input.title,
      description: input.description ?? null,
      category: input.category ?? null,
      assigneeId: input.assigneeId ?? null,
      assigneeRole: input.assigneeRole ?? null,
      dueDate: input.dueDate ?? null,
      createdById: userId,
    },
  });
  await logEvent(orderId, 'task.add', userId, { taskId: t.id, title: input.title });
  return t;
}

export async function updateTask(
  id: string,
  patch: {
    status?: HandoffTaskStatus;
    assigneeId?: string | null;
    assigneeRole?: Role | null;
    dueDate?: Date | null;
    isException?: boolean;
    exceptionReason?: string;
  },
  userId: string,
) {
  const existing = await prisma.handoffTask.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Task not found');
  if (patch.isException && !patch.exceptionReason?.trim())
    throw new ValidationError('An exception requires a reason');
  const t = await prisma.handoffTask.update({
    where: { id },
    data: {
      updatedById: userId,
      ...(patch.status
        ? { status: patch.status, ...(patch.status === 'DONE' ? { completedAt: new Date() } : {}) }
        : {}),
      ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
      ...(patch.assigneeRole !== undefined ? { assigneeRole: patch.assigneeRole } : {}),
      ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
      ...(patch.isException !== undefined
        ? { isException: patch.isException, exceptionReason: patch.exceptionReason ?? null }
        : {}),
    },
  });
  await logEvent(existing.orderId, 'task.update', userId, { taskId: id, ...patch });
  await recomputeStatus(existing.orderId, userId);
  return t;
}

/**
 * A submitted vendor section is the sheet that vendor already has, so its line-up is
 * frozen with it: nothing may be added to it or taken off it until it is unlocked.
 * 'Unassigned vendor' is the catch-all bucket and never has a section of its own.
 */
async function assertSectionOpen(orderId: string, vendor: string | null | undefined) {
  const name = (vendor && vendor.trim()) || 'Unassigned vendor';
  const section = await prisma.bomVendorSection.findUnique({
    where: { orderId_vendor: { orderId, vendor: name } },
    select: { status: true },
  });
  if (section?.status === 'SUBMITTED') {
    throw new ValidationError(
      `The ${name} Bill of Materials is submitted. Unlock it for changes first.`,
    );
  }
}

/**
 * Add or update a Bill of Materials line.
 *
 * A part added by hand goes through the same catalog resolution as an accepted one,
 * so it arrives with its vendor, unit cost and weight already filled in — someone
 * adding a forgotten bracket types a part number and a quantity, not a cost. An
 * explicitly supplied vendor or cost always wins, which is what keeps a part added
 * inside a vendor's section in that section even when the catalog disagrees.
 */
export async function upsertProcurementLine(
  orderId: string,
  input: {
    id?: string;
    productId?: string;
    sku?: string;
    name: string;
    quantity: number;
    vendor?: string;
    poNumber?: string;
    sourced?: boolean;
    targetDate?: Date;
    notes?: string;
    isException?: boolean;
    exceptionReason?: string;
    unitCostMinor?: number | null;
    unitWeightLbs?: number | null;
  },
  userId: string,
) {
  await getOrder(orderId);
  const [ref = EMPTY_REF] = await resolveCatalogRefs([
    { productId: input.productId ?? null, sku: input.sku ?? null, name: input.name },
  ]);
  const vendor = input.vendor?.trim() || ref.vendor || null;
  await assertSectionOpen(orderId, vendor);

  const data = {
    orderId,
    productId: input.productId ?? null,
    sku: input.sku ?? ref.sku ?? null,
    name: input.name,
    quantity: input.quantity,
    vendor,
    poNumber: input.poNumber ?? null,
    sourced: input.sourced ?? false,
    targetDate: input.targetDate ?? null,
    notes: input.notes ?? null,
    isException: input.isException ?? false,
    exceptionReason: input.exceptionReason ?? null,
    unitCostMinor: input.unitCostMinor ?? ref.unitCostMinor ?? null,
    unitWeightLbs: input.unitWeightLbs ?? ref.unitWeightLbs ?? null,
  };
  const line = input.id
    ? await prisma.procurementLine.update({ where: { id: input.id }, data })
    : await prisma.procurementLine.create({ data });
  await logEvent(orderId, input.id ? 'procurement.update' : 'procurement.add', userId, {
    lineId: line.id,
    sku: data.sku,
    name: data.name,
    quantity: data.quantity,
    vendor: data.vendor,
  });
  await recomputeStatus(orderId, userId);
  return line;
}

/**
 * Take a line off the Bill of Materials.
 *
 * The accepted proposal is untouched — this is the purchasing list, and a part the
 * shop is not buying does not belong on it. What was removed is written to the order
 * timeline with its part number and quantity, because a BOM that no longer matches
 * what the customer signed has to be explainable months later.
 */
export async function deleteProcurementLine(lineId: string, userId: string) {
  const existing = await prisma.procurementLine.findUnique({ where: { id: lineId } });
  if (!existing) throw new NotFoundError('Bill of Materials line not found');
  await assertSectionOpen(existing.orderId, existing.vendor);

  await prisma.procurementLine.delete({ where: { id: lineId } });
  await logEvent(existing.orderId, 'procurement.remove', userId, {
    lineId,
    sku: existing.sku,
    name: existing.name,
    quantity: existing.quantity,
    vendor: existing.vendor,
  });
  await recomputeStatus(existing.orderId, userId);
  return { ok: true };
}

/**
 * Edit one Bill of Materials line. Quantity, part number and vendor come from the
 * accepted proposal and the catalog, so they are not editable here — changing them
 * would put the BOM out of step with what the customer signed. Powder colour,
 * vendor notes, PO number and the sourced flag are operational and are.
 */
export async function patchProcurementLine(
  lineId: string,
  patch: {
    powderColor?: string | null;
    vendorNotes?: string | null;
    poNumber?: string | null;
    sourced?: boolean;
    targetDate?: Date | null;
    unitCostMinor?: number | null;
    /** Brand from the managed list; null clears it. */
    powderBrandId?: string | null;
    /** The colour code as typed for this part. */
    powderColorCode?: string | null;
    /**
     * Operational quantity override. The formula figure stays in
     * `quantityOriginal`; a difference between the two badges the line as edited.
     * Passing the original value back clears the override.
     */
    quantity?: number;
  },
  userId: string,
) {
  const existing = await prisma.procurementLine.findUnique({ where: { id: lineId } });
  if (!existing) throw new NotFoundError('Bill of Materials line not found');

  const vendor = (existing.vendor && existing.vendor.trim()) || 'Unassigned vendor';
  const section = await prisma.bomVendorSection.findUnique({
    where: { orderId_vendor: { orderId: existing.orderId, vendor } },
    select: { status: true },
  });

  /**
   * A submitted section is the sheet the vendor already has, so its lines are
   * frozen with it — with one deliberate exception.
   *
   * `sourced` (the per-line Pending/Ordered status) stays editable after
   * submission, because it records what happened to the part AFTER the sheet went
   * out. Freezing it would mean receiving could never be tracked against the
   * document the vendor was actually sent, which is the only document worth
   * tracking it against. Everything else — quantity, colour, notes, cost — would
   * put the BOM out of step with the vendor's copy and is refused.
   */
  if (section?.status === 'SUBMITTED') {
    const touched = Object.keys(patch).filter(
      (k) => (patch as Record<string, unknown>)[k] !== undefined,
    );
    const frozen = touched.filter((k) => k !== 'sourced');
    if (frozen.length) {
      throw new ValidationError(
        `The ${vendor} Bill of Materials is submitted. Unlock it for changes first. ` +
          'Only the per-line status can be changed on a submitted sheet.',
      );
    }
  }

  /**
   * The quantity override. Validated here rather than at the route so a direct API
   * call cannot write a negative or fractional count onto a shop document.
   *
   * Setting the quantity back to the formula figure CLEARS the override rather than
   * recording an edit that happens to match — otherwise a line nudged up and back
   * again would carry an "edited" badge forever with nothing to show for it.
   */
  let quantityData: Record<string, unknown> = {};
  if (patch.quantity !== undefined) {
    const q = Number(patch.quantity);
    if (!Number.isInteger(q) || q < 1)
      throw new ValidationError('Quantity must be a whole number of at least 1');
    if (q > 100000) throw new ValidationError('Quantity must be 100,000 or fewer');
    // A line created before this column existed, or added by hand, has no formula
    // figure. The first edit establishes one, so the badge has something to compare
    // against and the original stays recoverable.
    const original = existing.quantityOriginal ?? existing.quantity;
    quantityData =
      q === original
        ? {
            quantity: q,
            quantityOriginal: original,
            quantityEditedById: null,
            quantityEditedAt: null,
          }
        : {
            quantity: q,
            quantityOriginal: original,
            quantityEditedById: userId,
            quantityEditedAt: new Date(),
          };
  }

  // Brand + code are the source of truth; `powderColor` is the text that prints, so
  // it is kept in step whenever either half changes.
  const brandId = patch.powderBrandId !== undefined ? patch.powderBrandId : existing.powderBrandId;
  const code =
    patch.powderColorCode !== undefined ? patch.powderColorCode : existing.powderColorCode;
  const colorTouched = patch.powderBrandId !== undefined || patch.powderColorCode !== undefined;
  let printed: string | null = null;
  if (colorTouched) {
    const brand = brandId
      ? await prisma.powderColorBrand.findUnique({ where: { id: brandId }, select: { name: true } })
      : null;
    printed = [brand?.name, (code || '').trim()].filter(Boolean).join(' ') || null;
  }

  const line = await prisma.procurementLine.update({
    where: { id: lineId },
    data: {
      ...(patch.powderBrandId !== undefined ? { powderBrandId: patch.powderBrandId || null } : {}),
      ...(patch.powderColorCode !== undefined
        ? { powderColorCode: (patch.powderColorCode || '').trim() || null }
        : {}),
      ...(colorTouched ? { powderColor: printed } : {}),
      ...(!colorTouched && patch.powderColor !== undefined
        ? { powderColor: patch.powderColor || null }
        : {}),
      ...(patch.vendorNotes !== undefined ? { vendorNotes: patch.vendorNotes || null } : {}),
      ...(patch.poNumber !== undefined ? { poNumber: patch.poNumber || null } : {}),
      ...(patch.sourced !== undefined ? { sourced: patch.sourced } : {}),
      ...(patch.targetDate !== undefined ? { targetDate: patch.targetDate } : {}),
      ...(patch.unitCostMinor !== undefined ? { unitCostMinor: patch.unitCostMinor } : {}),
      ...quantityData,
    },
  });
  await logEvent(
    existing.orderId,
    patch.quantity !== undefined ? 'bom.line.quantity' : 'bom.line.update',
    userId,
    patch.quantity !== undefined
      ? {
          ...(patch as Record<string, unknown>),
          sku: existing.sku,
          name: existing.name,
          from: existing.quantity,
          to: patch.quantity,
        }
      : (patch as Record<string, unknown>),
  );
  return line;
}

/**
 * The BOM header: the fields a vendor document needs that a proposal has no
 * concept of — job name, who it ships to, delivery type, powder-coat brand and the
 * freight quote. Operational, so editable while the order stays locked.
 */
export async function updateOrderBomHeader(
  orderId: string,
  patch: {
    jobName?: string | null;
    bomShipTo?: BomShipTo;
    bomSubmittedOn?: Date | null;
    deliveryType?: string | null;
    powderCoatBrand?: string | null;
    shipmentQuote?: string | null;
    bomNotes?: string | null;
  },
  userId: string,
) {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order not found');
  const updated = await prisma.acceptedOrder.update({
    where: { id: orderId },
    data: {
      ...(patch.jobName !== undefined ? { jobName: patch.jobName || null } : {}),
      ...(patch.bomShipTo !== undefined ? { bomShipTo: patch.bomShipTo } : {}),
      ...(patch.bomSubmittedOn !== undefined ? { bomSubmittedOn: patch.bomSubmittedOn } : {}),
      ...(patch.deliveryType !== undefined ? { deliveryType: patch.deliveryType || null } : {}),
      ...(patch.powderCoatBrand !== undefined
        ? { powderCoatBrand: patch.powderCoatBrand || null }
        : {}),
      ...(patch.shipmentQuote !== undefined ? { shipmentQuote: patch.shipmentQuote || null } : {}),
      ...(patch.bomNotes !== undefined ? { bomNotes: patch.bomNotes || null } : {}),
    },
  });
  await logEvent(orderId, 'bom.header.update', userId, patch as Record<string, unknown>);
  return updated;
}

/**
 * Apply one powder colour to every steel line on the order — the common case,
 * since a job is powder coated one colour. Lines that already carry a colour are
 * left alone unless `overwrite` is set.
 */
export async function applyPowderColorToOrder(
  orderId: string,
  color: string,
  opts: { overwrite?: boolean },
  userId: string,
) {
  const [lines, steel] = await Promise.all([
    prisma.procurementLine.findMany({
      where: { orderId },
      select: { id: true, vendor: true, powderColor: true },
    }),
    prisma.manufacturer.findMany({ where: { isSteelFabricator: true }, select: { name: true } }),
  ]);
  const steelNames = new Set(steel.map((m) => m.name.toLowerCase()));
  const target = lines.filter(
    (l) => steelNames.has((l.vendor || '').toLowerCase()) && (opts.overwrite || !l.powderColor),
  );
  if (target.length) {
    await prisma.procurementLine.updateMany({
      where: { id: { in: target.map((l) => l.id) } },
      data: { powderColor: color || null },
    });
  }
  await logEvent(orderId, 'bom.powder.apply', userId, {
    color,
    count: target.length,
    overwrite: !!opts.overwrite,
  });
  return { updated: target.length };
}

/** Link integration outputs (QuickBooks estimate txn, monday project) to the order. */
export async function recordIntegrationRef(
  orderId: string,
  refs: { qboEstimateTxnId?: string; mondayProjectId?: string },
  userId: string,
) {
  await getOrder(orderId);
  const order = await prisma.acceptedOrder.update({
    where: { id: orderId },
    data: {
      ...(refs.qboEstimateTxnId ? { qboEstimateTxnId: refs.qboEstimateTxnId } : {}),
      ...(refs.mondayProjectId ? { mondayProjectId: refs.mondayProjectId } : {}),
    },
  });
  await logEvent(orderId, 'integration.link', userId, refs);
  return order;
}

/** Derive the overall handoff status from tasks + requirements. */
async function recomputeStatus(orderId: string, userId: string): Promise<HandoffStatus> {
  const [tasks, reqs, order] = await Promise.all([
    prisma.handoffTask.findMany({ where: { orderId } }),
    prisma.handoffRequirement.findMany({ where: { orderId } }),
    prisma.acceptedOrder.findUnique({ where: { id: orderId } }),
  ]);
  if (order?.status === 'CANCELLED') return 'CANCELLED';

  const openTasks = tasks.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED');
  const openReqs = reqs.filter((r) => r.status !== 'COMPLETE' && r.status !== 'WAIVED');
  const anyBlocked =
    tasks.some((t) => t.status === 'BLOCKED') || reqs.some((r) => r.status === 'BLOCKED');
  const anyProgress =
    tasks.some((t) => t.status !== 'TODO') || reqs.some((r) => r.status !== 'OPEN');

  let next: HandoffStatus;
  if (openTasks.length === 0 && openReqs.length === 0) next = 'COMPLETE';
  else if (anyBlocked) next = 'BLOCKED';
  else if (anyProgress) next = 'IN_PROGRESS';
  else next = 'NEW';

  if (order && order.status !== next) {
    await prisma.acceptedOrder.update({ where: { id: orderId }, data: { status: next } });
    await logEvent(orderId, 'status.change', userId, { from: order.status, to: next });
  }
  return next;
}

/** Handoff-status report: rollups, open exceptions, deposit + integration + integrity. */
export async function handoffStatus(orderId: string) {
  const order = await getOrder(orderId);
  const byStatus = <T extends { status: string }>(rows: T[]) =>
    rows.reduce<Record<string, number>>((a, r) => {
      a[r.status] = (a[r.status] ?? 0) + 1;
      return a;
    }, {});
  const integrity = await verifyIntegrity(orderId);
  const qboGate = await qboGateState(orderId);

  const exceptions = [
    ...order.requirements
      .filter((r) => r.isException)
      .map((r) => ({
        kind: 'requirement',
        id: r.id,
        category: r.category,
        reason: r.exceptionReason,
      })),
    ...order.tasks
      .filter((t) => t.isException)
      .map((t) => ({ kind: 'task', id: t.id, title: t.title, reason: t.exceptionReason })),
    ...order.procurement
      .filter((p) => p.isException)
      .map((p) => ({ kind: 'procurement', id: p.id, name: p.name, reason: p.exceptionReason })),
  ];

  return {
    orderId: order.id,
    number: order.number,
    status: order.status,
    locked: order.locked,
    acceptedVersion: order.acceptedVersion,
    proposalVersionId: order.proposalVersionId,
    priceSnapshotId: order.priceSnapshotId,
    grandTotalMinor: order.grandTotalMinor.toString(),
    deposit: { required: order.depositRequired, dueMinor: order.depositDueMinor.toString() },
    customerApproval: order.customerApproval
      ? {
          method: order.customerApproval.method,
          approverName: order.customerApproval.approverName,
          approvedAt: order.customerApproval.approvedAt.toISOString(),
          poNumber: order.customerApproval.poNumber,
        }
      : null,
    tasks: { total: order.tasks.length, byStatus: byStatus(order.tasks) },
    requirements: { total: order.requirements.length, byStatus: byStatus(order.requirements) },
    procurement: {
      total: order.procurement.length,
      sourced: order.procurement.filter((p) => p.sourced).length,
    },
    exceptions,
    exceptionCount: exceptions.length,
    integrations: {
      qboEstimateTxnId: order.qboEstimateTxnId,
      mondayProjectId: order.mondayProjectId,
    },
    /**
     * Manufacturing release. Reported as state PLUS a reason rather than a bare
     * boolean, so the button can be disabled with the explanation attached instead
     * of looking available and then refusing on click.
     */
    manufacturing: {
      released: !!order.manufacturingReleasedAt,
      releasedAt: order.manufacturingReleasedAt
        ? order.manufacturingReleasedAt.toISOString()
        : null,
      canRelease:
        !order.manufacturingReleasedAt && order.status !== 'CANCELLED' && qboGate.satisfied,
      blockedReason: order.manufacturingReleasedAt
        ? null
        : order.status === 'CANCELLED'
          ? 'This order is cancelled.'
          : qboGate.satisfied
            ? null
            : 'A QuickBooks invoice has to be created first — steps 1 to 3.',
      qbo: qboGate,
    },
    integrity,
  };
}

/** Full order audit timeline (order-scoped events, chronological). */
export async function orderAudit(orderId: string) {
  await getOrder(orderId);
  const events = await prisma.orderEvent.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  });
  return events.map((e) => ({
    action: e.action,
    actorId: e.actorId,
    detail: e.detail,
    at: e.createdAt.toISOString(),
  }));
}
