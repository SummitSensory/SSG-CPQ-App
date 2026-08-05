import { prisma } from '../lib/prisma.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { COMPANY, streetLine } from './bom.js';
import { fetchItemById } from '../integrations/monday/discovery.js';
import { DEAL_COL } from '../integrations/monday/crmMapping.js';

/**
 * Request for Freight (RFQ).
 *
 * A vendor who ships our product quotes the freight on it, and they quote it per
 * shipment — so an RFQ is scoped exactly the way a Bill of Materials is: one
 * document per vendor, built from the lines of the proposal that vendor supplies.
 *
 * Three rules shape everything below:
 *
 *   1. **Cost, not price.** The unit figures are what we pay the vendor. A
 *      freight desk quoting a shipment has no business seeing our margin.
 *   2. **Frozen on send.** The document a vendor holds must never change under
 *      them. Editing a sent RFQ raises a revision instead, which carries the
 *      previous selection forward.
 *   3. **The reference is resolved once.** "RFQ-8050" comes from the monday
 *      Project ID at creation and is then stored. If the board changes later, the
 *      paper trail still lines up.
 */

const s = (v: unknown): string => (v == null ? '' : String(v));
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A line as it sits in ProposalVersion.items. */
interface ProposalLine {
  lineType?: string;
  optional?: boolean;
  name?: string;
  sku?: string;
  quantity?: number;
  rateMinor?: number;
  costEach?: number;
}

export interface RfqVendorOption {
  vendor: string;
  manufacturerId: string | null;
  rfqEnabled: boolean;
  lineCount: number;
  unitCount: number;
  extendedCostMinor: number;
  /** An RFQ already exists for this vendor on this proposal. */
  existingRfqId: string | null;
  existingStatus: string | null;
}

/** Product lines on a version, ignoring notes, headings and optional extras. */
function productLines(items: unknown): ProposalLine[] {
  if (!Array.isArray(items)) return [];
  return (items as ProposalLine[]).filter(
    (l) => l && (l.lineType ?? 'PRODUCT') === 'PRODUCT' && !l.optional && s(l.sku).trim() !== '' && n(l.quantity) > 0,
  );
}

/**
 * Vendor for each SKU on the version. `Sku.manufacturer` is a plain name rather
 * than a relation, which is what the BOM matches on too — one lookup, no product
 * tree walk.
 */
async function vendorBySku(skus: string[]): Promise<Map<string, string>> {
  if (!skus.length) return new Map();
  const rows = await prisma.sku.findMany({
    where: { part: { in: skus } },
    select: { part: true, manufacturer: true, unitCostMinor: true },
  });
  const out = new Map<string, string>();
  for (const r of rows) if (r.manufacturer) out.set(r.part, r.manufacturer);
  return out;
}

/**
 * Every vendor represented on a proposal version, RFQ-capable or not.
 *
 * `draftLines` lets the builder ask about lines it has not saved yet. A rep who
 * has just dropped a Play Sports swing onto the proposal expects the freight
 * prompt to appear immediately, not after a save and a page reload — so the
 * client sends what is on screen and this reads that instead of the stored
 * version.
 *
 * Vendors without the flag are still returned, marked `rfqEnabled: false`: the
 * rep asked for the ability to add items from anywhere, and hiding the vendor
 * entirely would make that impossible to discover.
 */
export async function listRfqVendors(versionId: string, draftLines?: ProposalLine[]): Promise<RfqVendorOption[]> {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: { id: true, items: true, proposalId: true },
  });
  if (!version) throw new NotFoundError('Proposal version not found');

  const lines = draftLines && draftLines.length ? productLines(draftLines) : productLines(version.items);
  const skuVendor = await vendorBySku([...new Set(lines.map((l) => s(l.sku)))]);

  const grouped = new Map<string, { lineCount: number; unitCount: number; cost: number }>();
  for (const l of lines) {
    const vendor = skuVendor.get(s(l.sku));
    if (!vendor) continue;
    const g = grouped.get(vendor) ?? { lineCount: 0, unitCount: 0, cost: 0 };
    g.lineCount += 1;
    g.unitCount += n(l.quantity);
    g.cost += n(l.quantity) * n(l.costEach);
    grouped.set(vendor, g);
  }

  const [mfrs, existing] = await Promise.all([
    prisma.manufacturer.findMany({
      where: { name: { in: [...grouped.keys()] } },
      select: { id: true, name: true, rfqEnabled: true },
    }),
    prisma.freightRfq.findMany({
      where: { proposalId: version.proposalId, status: { not: 'SUPERSEDED' } },
      select: { id: true, vendor: true, status: true },
    }),
  ]);
  const byName = new Map(mfrs.map((m) => [m.name.toLowerCase(), m]));
  const rfqByVendor = new Map(existing.map((r) => [r.vendor.toLowerCase(), r]));

  return [...grouped.entries()]
    .map(([vendor, g]) => {
      const m = byName.get(vendor.toLowerCase());
      const r = rfqByVendor.get(vendor.toLowerCase());
      return {
        vendor,
        manufacturerId: m?.id ?? null,
        rfqEnabled: !!m?.rfqEnabled,
        lineCount: g.lineCount,
        unitCount: g.unitCount,
        extendedCostMinor: Math.round(g.cost),
        existingRfqId: r?.id ?? null,
        existingStatus: r?.status ?? null,
      };
    })
    .sort((a, b) => Number(b.rfqEnabled) - Number(a.rfqEnabled) || a.vendor.localeCompare(b.vendor));
}

/**
 * The monday Project ID behind "RFQ-8050".
 *
 * It lives on the deal row, not in our database, so it is read through the
 * organization's linked opportunity. A board that cannot be reached must not stop
 * a rep raising an RFQ — the proposal number stands in, and the document still
 * makes sense to the vendor.
 */
async function resolveProjectId(organizationId: string, fallback: string): Promise<string> {
  try {
    const opp = await prisma.opportunity.findFirst({
      where: { organizationId, mondayItemId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { mondayItemId: true },
    });
    if (!opp?.mondayItemId) return fallback;
    const item = await fetchItemById(opp.mondayItemId);
    const value = s(item?.text?.[DEAL_COL.projectId]).trim();
    return value || fallback;
  } catch (err) {
    logger.warn({ err, organizationId }, 'freight rfq: could not read the monday Project ID, using the proposal number');
    return fallback;
  }
}

/** "RFQ-8050" for the first, "RFQ-8050 R2" for every revision after it. */
export function rfqReference(projectId: string, revision: number): string {
  return revision <= 1 ? `RFQ-${projectId}` : `RFQ-${projectId} R${revision}`;
}

/**
 * Ship-to, taken from the proposal's shipping address and falling back to
 * billing — a customer with one address on file usually has it filed as billing,
 * and a freight quote to nowhere is useless.
 */
async function shipToFor(organizationId: string) {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, addresses: true },
  });
  if (!org) throw new NotFoundError('Customer not found');
  const ship = org.addresses.find((a) => a.type === 'SHIPPING') ?? org.addresses.find((a) => a.type === 'BILLING');
  return {
    shipToName: org.name,
    shipToLine1: s(ship?.line1) || null,
    shipToLine2: s(ship?.line2) || null,
    shipToCity: s(ship?.city) || null,
    shipToRegion: s(ship?.region) || null,
    shipToPostal: s(ship?.postalCode) || null,
    shipToCountry: s(ship?.country) || 'United States',
  };
}

/**
 * The rep on the document. Their own number is the one a carrier should call, so
 * a blank profile phone falls back to the company line rather than printing an
 * empty field on a document going outside the building.
 */
async function contactFor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, phone: true, email: true },
  });
  return {
    contactName: s(user?.name) || null,
    contactPhone: s(user?.phone).trim() || COMPANY.phone,
    email: s(user?.email),
  };
}

/** Create the vendor's RFQ from the proposal version. */
export async function createRfq(input: { versionId: string; vendor: string }, actorId: string) {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: input.versionId },
    select: {
      id: true, items: true, proposalId: true, createdById: true,
      proposal: { select: { id: true, number: true, organizationId: true } },
    },
  });
  if (!version?.proposal) throw new NotFoundError('Proposal version not found');

  const open = await prisma.freightRfq.findFirst({
    where: { proposalId: version.proposalId, vendor: input.vendor, status: { not: 'SUPERSEDED' } },
  });
  if (open) throw new ValidationError(`There is already an RFQ for ${input.vendor} on this proposal.`);

  const lines = productLines(version.items);
  const skuVendor = await vendorBySku([...new Set(lines.map((l) => s(l.sku)))]);
  const mine = lines.filter((l) => (skuVendor.get(s(l.sku)) ?? '').toLowerCase() === input.vendor.toLowerCase());
  if (!mine.length) throw new ValidationError(`No lines on this proposal are sourced from ${input.vendor}.`);

  const mfr = await prisma.manufacturer.findFirst({ where: { name: input.vendor }, select: { id: true } });
  const projectId = await resolveProjectId(version.proposal.organizationId, version.proposal.number);
  // The rep who built the proposal is the point of contact, not whoever happens
  // to be raising the RFQ.
  const contact = await contactFor(version.createdById);
  const shipTo = await shipToFor(version.proposal.organizationId);

  const rfq = await prisma.freightRfq.create({
    data: {
      proposalId: version.proposalId,
      versionId: version.id,
      organizationId: version.proposal.organizationId,
      vendor: input.vendor,
      manufacturerId: mfr?.id ?? null,
      projectId,
      reference: rfqReference(projectId, 1),
      revision: 1,
      ...shipTo,
      contactName: contact.contactName,
      contactPhone: contact.contactPhone,
      createdById: actorId,
      totalCostMinor: mine.reduce((t, l) => t + n(l.quantity) * n(l.costEach), 0),
      lines: {
        create: mine.map((l, i) => ({
          sku: s(l.sku),
          name: s(l.name),
          quantity: Math.round(n(l.quantity)),
          unitCostMinor: Math.round(n(l.costEach)),
          extendedCostMinor: Math.round(n(l.quantity) * n(l.costEach)),
          sortOrder: (i + 1) * 10,
        })),
      },
    },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });
  return rfq;
}

function assertEditable(rfq: { status: string; reference: string }): void {
  if (rfq.status !== 'DRAFT') {
    throw new ValidationError(`${rfq.reference} has been sent. Start a revision to change it.`);
  }
}

/** Recompute the stored total from whatever is currently ticked. */
async function retotal(rfqId: string): Promise<number> {
  const lines = await prisma.freightRfqLine.findMany({ where: { rfqId, included: true } });
  const total = lines.reduce((t, l) => t + l.extendedCostMinor, 0);
  await prisma.freightRfq.update({ where: { id: rfqId }, data: { totalCostMinor: total } });
  return total;
}

export async function setLineIncluded(rfqId: string, lineId: string, included: boolean) {
  const rfq = await prisma.freightRfq.findUnique({ where: { id: rfqId } });
  if (!rfq) throw new NotFoundError('RFQ not found');
  assertEditable(rfq);
  await prisma.freightRfqLine.update({ where: { id: lineId }, data: { included } });
  return { totalCostMinor: await retotal(rfqId) };
}

/** Add a line the proposal did not source from this vendor. */
export async function addRfqLine(rfqId: string, input: { sku: string; name?: string; quantity: number }) {
  const rfq = await prisma.freightRfq.findUnique({ where: { id: rfqId }, include: { lines: true } });
  if (!rfq) throw new NotFoundError('RFQ not found');
  assertEditable(rfq);
  if (rfq.lines.some((l) => l.sku.toLowerCase() === input.sku.trim().toLowerCase())) {
    throw new ValidationError(`${input.sku} is already on this RFQ.`);
  }

  const sku = await prisma.sku.findUnique({
    where: { part: input.sku.trim() },
    select: { part: true, description: true, unitCostMinor: true },
  });
  if (!sku) throw new ValidationError(`${input.sku} is not in the catalogue.`);

  const qty = Math.max(1, Math.round(input.quantity));
  const last = rfq.lines.reduce((m, l) => Math.max(m, l.sortOrder), 0);
  await prisma.freightRfqLine.create({
    data: {
      rfqId,
      sku: sku.part,
      name: input.name?.trim() || sku.description,
      quantity: qty,
      unitCostMinor: sku.unitCostMinor,
      extendedCostMinor: sku.unitCostMinor * qty,
      addedManually: true,
      sortOrder: last + 10,
    },
  });
  return { totalCostMinor: await retotal(rfqId) };
}

export async function removeRfqLine(rfqId: string, lineId: string) {
  const rfq = await prisma.freightRfq.findUnique({ where: { id: rfqId } });
  if (!rfq) throw new NotFoundError('RFQ not found');
  assertEditable(rfq);
  const line = await prisma.freightRfqLine.findUnique({ where: { id: lineId } });
  // Only hand-added lines are removable. A line that came off the proposal is
  // unticked instead, so the document still shows what was considered.
  if (!line?.addedManually) throw new ValidationError('Untick this line instead — only manually added lines can be removed.');
  await prisma.freightRfqLine.delete({ where: { id: lineId } });
  return { totalCostMinor: await retotal(rfqId) };
}

export async function setRfqNotes(rfqId: string, notes: string) {
  const rfq = await prisma.freightRfq.findUnique({ where: { id: rfqId } });
  if (!rfq) throw new NotFoundError('RFQ not found');
  assertEditable(rfq);
  return prisma.freightRfq.update({
    where: { id: rfqId },
    data: { notes: notes.trim() || null },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });
}

/**
 * Start a revision of a sent RFQ. The previous selection carries forward —
 * a revision is nearly always a small correction, and re-ticking twenty lines to
 * make one change is how mistakes get made.
 */
export async function startRfqRevision(rfqId: string, actorId: string) {
  const prev = await prisma.freightRfq.findUnique({
    where: { id: rfqId },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!prev) throw new NotFoundError('RFQ not found');
  if (prev.status === 'DRAFT') throw new ValidationError('This RFQ has not been sent yet — edit it directly.');

  const revision = prev.revision + 1;
  const [, next] = await prisma.$transaction([
    prisma.freightRfq.update({ where: { id: prev.id }, data: { status: 'SUPERSEDED' } }),
    prisma.freightRfq.create({
      data: {
        proposalId: prev.proposalId,
        versionId: prev.versionId,
        organizationId: prev.organizationId,
        vendor: prev.vendor,
        manufacturerId: prev.manufacturerId,
        projectId: prev.projectId,
        reference: rfqReference(prev.projectId, revision),
        revision,
        notes: prev.notes,
        shipToName: prev.shipToName,
        shipToLine1: prev.shipToLine1,
        shipToLine2: prev.shipToLine2,
        shipToCity: prev.shipToCity,
        shipToRegion: prev.shipToRegion,
        shipToPostal: prev.shipToPostal,
        shipToCountry: prev.shipToCountry,
        contactName: prev.contactName,
        contactPhone: prev.contactPhone,
        createdById: actorId,
        totalCostMinor: prev.totalCostMinor,
        lines: {
          create: prev.lines.map((l) => ({
            sku: l.sku,
            name: l.name,
            quantity: l.quantity,
            unitCostMinor: l.unitCostMinor,
            extendedCostMinor: l.extendedCostMinor,
            included: l.included,
            addedManually: l.addedManually,
            sortOrder: l.sortOrder,
          })),
        },
      },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    }),
  ]);
  return next;
}

export interface RfqModel {
  id: string;
  reference: string;
  revision: number;
  status: string;
  vendor: string;
  notes: string;
  projectId: string;
  todayLabel: string;
  submittedLabel: string;
  company: typeof COMPANY;
  customerName: string;
  shipTo: { name: string; lines: string[] };
  contact: { name: string; phone: string };
  submittedBy: { name: string; email: string };
  lines: Array<{
    id: string; sku: string; name: string; quantity: number;
    unitCostMinor: number; extendedCostMinor: number; included: boolean; addedManually: boolean;
  }>;
  totalCostMinor: number;
  sentAt: string | null;
}

const DATE = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Denver' });
const DATETIME = new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver',
});

/** Everything the document and the panel need, in one read. */
export async function buildRfqModel(rfqId: string): Promise<RfqModel> {
  const rfq = await prisma.freightRfq.findUnique({
    where: { id: rfqId },
    include: {
      lines: { orderBy: { sortOrder: 'asc' } },
      proposal: { select: { number: true, organizationId: true, createdById: true } },
    },
  });
  if (!rfq) throw new NotFoundError('RFQ not found');

  const creator = await prisma.user.findUnique({
    where: { id: rfq.proposal.createdById },
    select: { name: true, email: true },
  });

  const cityLine = [rfq.shipToCity, [rfq.shipToRegion, rfq.shipToPostal].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join(', ');
  const when = rfq.sentAt ?? new Date();

  return {
    id: rfq.id,
    reference: rfq.reference,
    revision: rfq.revision,
    status: rfq.status,
    vendor: rfq.vendor,
    notes: s(rfq.notes),
    projectId: rfq.projectId,
    todayLabel: DATE.format(when),
    submittedLabel: DATETIME.format(when),
    company: COMPANY,
    customerName: rfq.shipToName,
    shipTo: {
      name: rfq.shipToName,
      lines: [streetLine(rfq.shipToLine1, rfq.shipToLine2), cityLine, s(rfq.shipToCountry)].filter(Boolean),
    },
    contact: { name: s(rfq.contactName), phone: s(rfq.contactPhone) },
    submittedBy: { name: s(creator?.name), email: s(creator?.email) || COMPANY.email },
    lines: rfq.lines.map((l) => ({
      id: l.id, sku: l.sku, name: l.name, quantity: l.quantity,
      unitCostMinor: l.unitCostMinor, extendedCostMinor: l.extendedCostMinor,
      included: l.included, addedManually: l.addedManually,
    })),
    totalCostMinor: rfq.lines.filter((l) => l.included).reduce((t, l) => t + l.extendedCostMinor, 0),
    sentAt: rfq.sentAt ? rfq.sentAt.toISOString() : null,
  };
}

/**
 * The RFQ summaries that sit under Profitability on the proposal: who was asked,
 * when, and what was on the request.
 */
export async function listProposalRfqs(proposalId: string) {
  const rows = await prisma.freightRfq.findMany({
    where: { proposalId },
    orderBy: [{ createdAt: 'desc' }],
    include: { lines: { where: { included: true }, orderBy: { sortOrder: 'asc' } } },
  });
  return rows.map((r) => ({
    id: r.id,
    vendor: r.vendor,
    reference: r.reference,
    revision: r.revision,
    status: r.status,
    requestedAt: (r.sentAt ?? r.createdAt).toISOString(),
    totalCostMinor: r.totalCostMinor,
    itemCount: r.lines.length,
    items: r.lines.map((l) => ({ sku: l.sku, name: l.name, quantity: l.quantity })),
  }));
}
