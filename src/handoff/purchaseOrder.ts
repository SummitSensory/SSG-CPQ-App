import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { buildBom, COMPANY, type BomLine } from './bom.js';
import { vendorAbbrev } from './freightRfq.js';
import { bomPhone } from './bomDelivery.js';

/**
 * Purchase orders to vendors.
 *
 * Raised from a vendor's section of a LOCKED order's Bill of Materials, for vendors
 * flagged "Can receive purchase orders" on their profile. The rep picks which of that
 * vendor's products go on it, confirms the freight, and sends it; the sent PO is
 * frozen and its number lands on the Manufacturing Process board (see
 * integrations/monday/purchaseOrderPush.ts).
 *
 * The lines come from `buildBom` for that vendor, not from the procurement table
 * directly, so a PO lists exactly what the vendor's BOM lists — the same roll-up of
 * hardware, the same vendor part numbers, the same frozen purchase prices — and a PO
 * and a BOM for one shipment can never disagree about what was ordered.
 */

const s = (v: unknown): string => (v == null ? '' : String(v));

/**
 * PO-\<Project ID\>-\<vendor code\>, then -2, -3 for a second and later PO to the same
 * vendor on the same order. The format is Bryan's; the suffix exists because the
 * reference is unique and a vendor can be ordered from twice on one job.
 */
export function poReference(projectId: string, abbrev: string, sequence = 1): string {
  const base = abbrev ? `PO-${projectId}-${abbrev}` : `PO-${projectId}`;
  return sequence > 1 ? `${base}-${sequence}` : base;
}

/** The Project ID in a proposal version's header (its meta section). */
function metaProjectId(sections: unknown): string {
  if (!Array.isArray(sections)) return '';
  for (const sec of sections as Array<{ id?: unknown; data?: { projectId?: unknown } }>) {
    const v = s(sec?.data?.projectId).trim();
    if (v) return v;
  }
  return '';
}

/**
 * The order's Project ID: the order's own copy, else the one on the accepted proposal
 * (the same rule as ordersForProjectIds), else the order number so a PO can still be
 * raised on an order that was never linked to a deal.
 */
async function projectIdForOrder(order: {
  mondayProjectId: string | null;
  proposalVersionId: string;
  number: string;
}): Promise<string> {
  if (s(order.mondayProjectId).trim()) return s(order.mondayProjectId).trim();
  const version = await prisma.proposalVersion.findUnique({
    where: { id: order.proposalVersionId },
    select: { sections: true },
  });
  return metaProjectId(version?.sections) || order.number;
}

/** What a PO line is built from. A free-issue part is already paid for, so it is not orderable. */
function orderable(lines: BomLine[]): BomLine[] {
  return lines.filter((l) => !l.freeIssue && l.quantity > 0);
}

async function lockedOrder(orderId: string) {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      number: true,
      locked: true,
      status: true,
      organizationId: true,
      mondayProjectId: true,
      proposalVersionId: true,
    },
  });
  if (!order) throw new NotFoundError('Order not found');
  if (!order.locked)
    throw new ValidationError('Purchase orders can only be raised on a locked order.');
  if (order.status === 'CANCELLED') throw new ValidationError('This order has been cancelled.');
  return order;
}

async function manufacturerNamed(vendor: string) {
  return prisma.manufacturer.findFirst({
    where: { name: { equals: vendor, mode: 'insensitive' } },
    select: {
      id: true,
      name: true,
      poEnabled: true,
      rfqAbbrev: true,
      paymentTerms: true,
      accountNumber: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postalCode: true,
    },
  });
}

/**
 * Everything the "Create Purchase Order" window opens with: the vendor's orderable
 * products, the freight figure already on their BOM section, and which SKUs are
 * already on a PO that went out — so the rep can see what has been ordered before
 * ordering it again.
 */
export async function purchaseOrderSource(orderId: string, vendor: string) {
  await lockedOrder(orderId);
  const mfr = await manufacturerNamed(vendor);
  const bom = await buildBom(orderId, { vendor });
  const existing = await prisma.purchaseOrder.findMany({
    where: { orderId, vendor },
    orderBy: { sequence: 'asc' },
    include: { lines: { select: { sku: true } } },
  });
  const onSent = new Map<string, string>();
  for (const po of existing) {
    if (po.status !== 'SENT') continue;
    for (const l of po.lines) if (!onSent.has(l.sku)) onSent.set(l.sku, po.reference);
  }
  return {
    vendor,
    poEnabled: !!mfr?.poEnabled,
    lines: orderable(bom.lines).map((l) => ({
      id: l.id,
      sku: l.sku,
      vendorSku: l.vendorSku,
      name: l.name,
      quantity: l.quantity,
      unitCostMinor: l.unitCostMinor,
      extendedCostMinor: l.extendedCostMinor,
      powderColor: l.powderColor,
      onPurchaseOrder: onSent.get(l.sku) ?? null,
    })),
    /** The vendor section's "Estimated shipment quote", as typed and as a number where it reads as one. */
    freight: { text: bom.financials.shipmentQuote, minor: bom.financials.shipmentMinor },
    drafts: existing
      .filter((p) => p.status === 'DRAFT')
      .map((p) => ({ id: p.id, reference: p.reference })),
  };
}

export interface PurchaseOrderInput {
  lineIds: string[];
  freightMinor: number | null;
  noFreightCharge: boolean;
  notes?: string | null;
}

/** Snapshot the chosen BOM lines as PO lines. */
async function chosenLines(orderId: string, vendor: string, lineIds: string[]) {
  const wanted = new Set(lineIds);
  const bom = await buildBom(orderId, { vendor });
  const picked = orderable(bom.lines).filter((l) => wanted.has(l.id));
  if (!picked.length)
    throw new ValidationError('Select at least one product for the purchase order.');
  return {
    bom,
    lines: picked.map((l, i) => ({
      sku: l.sku,
      vendorSku: l.vendorSku || null,
      name: l.name,
      quantity: l.quantity,
      unitCostMinor: l.unitCostMinor,
      extendedCostMinor: l.extendedCostMinor,
      // The colour the Bill of Materials prints for this part, frozen with the PO.
      powderColor: l.powderColor.trim() || null,
      sortOrder: i,
    })),
  };
}

function freightFields(input: PurchaseOrderInput) {
  if (
    input.freightMinor != null &&
    (!Number.isInteger(input.freightMinor) || input.freightMinor < 0)
  )
    throw new ValidationError('Freight must be zero or more.');
  return {
    freightMinor: input.noFreightCharge ? 0 : input.freightMinor,
    noFreightCharge: input.noFreightCharge,
  };
}

function totals(lines: Array<{ extendedCostMinor: number }>, freightMinor: number | null) {
  const subtotalMinor = lines.reduce((t, l) => t + l.extendedCostMinor, 0);
  return { subtotalMinor, totalMinor: subtotalMinor + (freightMinor ?? 0) };
}

/** Raise a draft PO. Nothing leaves the building until it is sent. */
export async function createPurchaseOrder(
  orderId: string,
  vendor: string,
  input: PurchaseOrderInput,
  actorId: string,
) {
  const order = await lockedOrder(orderId);
  const mfr = await manufacturerNamed(vendor);
  if (!mfr?.poEnabled) {
    throw new ValidationError(
      `${vendor} is not set up to receive purchase orders. Turn on "Can receive purchase orders" on the vendor's profile first.`,
    );
  }
  const { bom, lines } = await chosenLines(orderId, vendor, input.lineIds);
  const freight = freightFields(input);
  const projectId = await projectIdForOrder(order);
  const abbrev = vendorAbbrev(mfr.name, mfr.rfqAbbrev);
  const last = await prisma.purchaseOrder.findFirst({
    where: { orderId, vendor },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  const sequence = (last?.sequence ?? 0) + 1;

  return prisma.purchaseOrder.create({
    data: {
      orderId,
      vendor,
      manufacturerId: mfr.id,
      projectId,
      vendorAbbrev: abbrev,
      sequence,
      reference: poReference(projectId, abbrev, sequence),
      notes: s(input.notes).trim() || null,
      ...freight,
      ...totals(lines, freight.freightMinor),
      // Frozen from the vendor's BOM section: where this vendor ships and who receives it.
      shipToName: bom.shipTo.name,
      shipToLines: bom.shipTo.lines.filter((l) => s(l).trim()),
      contactName: s(bom.shipTo.contactName) || null,
      // Formatted the way the BOM prints it: (XXX) XXX-XXXX.
      contactPhone: bomPhone(bom.shipTo.phone).text || null,
      createdById: actorId,
      lines: { create: lines },
    },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });
}

async function draft(poId: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
  if (!po) throw new NotFoundError('Purchase order not found');
  if (po.status !== 'DRAFT')
    throw new ValidationError(`${po.reference} has been sent and can no longer be changed.`);
  return po;
}

/** Change a draft's products, freight or notes. */
export async function updatePurchaseOrder(poId: string, input: PurchaseOrderInput) {
  const po = await draft(poId);
  const { lines } = await chosenLines(po.orderId, po.vendor, input.lineIds);
  const freight = freightFields(input);
  await prisma.$transaction([
    prisma.purchaseOrderLine.deleteMany({ where: { poId } }),
    prisma.purchaseOrder.update({
      where: { id: poId },
      data: {
        notes: s(input.notes).trim() || null,
        ...freight,
        ...totals(lines, freight.freightMinor),
        lines: { create: lines },
      },
    }),
  ]);
  return buildPurchaseOrderModel(poId);
}

/** Throw away a draft. A sent PO is a record of what the vendor was asked for and stays. */
export async function deletePurchaseOrder(poId: string) {
  await draft(poId);
  await prisma.purchaseOrder.delete({ where: { id: poId } });
  return { deleted: true };
}

const DATE = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'America/Denver',
});
const DATETIME = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Denver',
});

export interface PurchaseOrderModel {
  id: string;
  orderId: string;
  orderNumber: string;
  reference: string;
  status: 'DRAFT' | 'SENT';
  vendor: string;
  vendorBlock: { lines: string[]; paymentTerms: string; accountNumber: string };
  projectId: string;
  notes: string;
  todayLabel: string;
  submittedLabel: string;
  company: typeof COMPANY;
  /** The address vendors reply to about a PO — the orders desk, as on the BOM. */
  replyEmail: string;
  customerName: string;
  shipTo: { name: string; lines: string[] };
  contact: { name: string; phone: string };
  orderedBy: { name: string };
  lines: Array<{
    id: string;
    sku: string;
    vendorSku: string;
    name: string;
    quantity: number;
    unitCostMinor: number;
    extendedCostMinor: number;
    /** '' when the part has no colour. */
    powderColor: string;
  }>;
  subtotalMinor: number;
  freightMinor: number | null;
  noFreightCharge: boolean;
  totalMinor: number;
  sentAt: string | null;
  mondayResult: unknown;
}

/** Everything the document and the order screen need, in one read. */
export async function buildPurchaseOrderModel(poId: string): Promise<PurchaseOrderModel> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      lines: { orderBy: { sortOrder: 'asc' } },
      order: { select: { number: true, organizationId: true } },
    },
  });
  if (!po) throw new NotFoundError('Purchase order not found');
  const [org, orderedBy, mfr] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: po.order.organizationId },
      select: { name: true },
    }),
    prisma.user.findUnique({
      where: { id: po.sentById ?? po.createdById },
      select: { name: true },
    }),
    manufacturerNamed(po.vendor),
  ]);
  const when = po.sentAt ?? new Date();
  const vendorCity = [s(mfr?.city), [s(mfr?.region), s(mfr?.postalCode)].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return {
    id: po.id,
    orderId: po.orderId,
    orderNumber: po.order.number,
    reference: po.reference,
    status: po.status,
    vendor: po.vendor,
    vendorBlock: {
      lines: [
        s(mfr?.contactName) ? `ATTN: ${s(mfr?.contactName)}` : '',
        [s(mfr?.addressLine1), s(mfr?.addressLine2)].filter(Boolean).join(', '),
        vendorCity,
        s(mfr?.contactPhone),
        s(mfr?.contactEmail),
      ].filter(Boolean),
      paymentTerms: s(mfr?.paymentTerms),
      accountNumber: s(mfr?.accountNumber),
    },
    projectId: po.projectId,
    notes: s(po.notes),
    todayLabel: DATE.format(when),
    submittedLabel: DATETIME.format(when),
    company: COMPANY,
    replyEmail: env.BOM_REPLY_TO,
    customerName: s(org?.name),
    shipTo: { name: po.shipToName, lines: po.shipToLines },
    contact: { name: s(po.contactName), phone: s(po.contactPhone) },
    orderedBy: { name: s(orderedBy?.name) },
    lines: po.lines.map((l) => ({
      id: l.id,
      sku: l.sku,
      vendorSku: s(l.vendorSku),
      name: l.name,
      quantity: l.quantity,
      unitCostMinor: l.unitCostMinor,
      extendedCostMinor: l.extendedCostMinor,
      powderColor: s(l.powderColor),
    })),
    subtotalMinor: po.subtotalMinor,
    freightMinor: po.freightMinor,
    noFreightCharge: po.noFreightCharge,
    totalMinor: po.totalMinor,
    sentAt: po.sentAt ? po.sentAt.toISOString() : null,
    mondayResult: po.mondayResult ?? null,
  };
}

/** The POs on an order, for the vendor sections of the order screen. */
export async function listOrderPurchaseOrders(orderId: string) {
  const pos = await prisma.purchaseOrder.findMany({
    where: { orderId },
    orderBy: [{ vendor: 'asc' }, { sequence: 'asc' }],
    include: {
      _count: { select: { lines: true } },
      sends: { orderBy: { createdAt: 'desc' } },
    },
  });
  // Sender ids are plain strings on the send row, not relations: one lookup for all.
  const senderIds = [...new Set(pos.flatMap((p) => p.sends.map((s) => s.sentById)))];
  const senders = senderIds.length
    ? await prisma.user.findMany({
        where: { id: { in: senderIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const senderName = new Map(senders.map((u) => [u.id, u.name?.trim() || u.email]));
  return pos.map((p) => ({
    id: p.id,
    vendor: p.vendor,
    reference: p.reference,
    status: p.status,
    lineCount: p._count.lines,
    totalMinor: p.totalMinor,
    sentAt: p.sentAt ? p.sentAt.toISOString() : null,
    lastSend: p.sends[0]
      ? { status: p.sends[0].status, to: p.sends[0].toEmail, error: p.sends[0].error }
      : null,
    /** Every emailing, newest first — the send record shown under the PO. */
    sends: p.sends.map((s) => ({
      id: s.id,
      sentAt: s.createdAt.toISOString(),
      toName: s.toName,
      to: s.toEmail,
      cc: s.ccEmails,
      subject: s.subject,
      sentBy: senderName.get(s.sentById) ?? null,
      status: s.status,
      deliveredAt: s.deliveredAt ? s.deliveredAt.toISOString() : null,
      error: s.error,
    })),
    mondayResult: p.mondayResult ?? null,
  }));
}
