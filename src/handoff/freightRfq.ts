import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { COMPANY, streetLine } from './bom.js';
import { fetchItemById } from '../integrations/monday/discovery.js';
import { DEAL_COL } from '../integrations/monday/crmMapping.js';
import { confirmedAddressForProposal } from '../integrations/monday/portalDelivery.js';
import { resolvePartDetails, resolveVendors, skuKey } from './vendorResolution.js';

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
 *   3. **The reference is resolved once.** "RFQ-12414494509-SE" is built from the
 *      monday Project ID (`pulse_id_mm5kc9f8`) and the vendor's code at creation,
 *      then stored. If the board or the vendor record changes later, the paper
 *      trail still lines up with what the vendor is holding.
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

/**
 * What the vendor list answers with: the vendors, plus the parts it could not
 * attribute to any vendor.
 *
 * The unmatched list is the point. Before this existed, an unattributable part was
 * skipped in silence, so a proposal could show one vendor card and give no hint
 * that twenty other lines had been passed over.
 */
export interface RfqVendorList {
  vendors: RfqVendorOption[];
  /** SKUs on the proposal that match no catalog row, or none naming a vendor. */
  unmatchedSkus: string[];
  /** Those lines' names, for a message a rep can act on. */
  unmatchedNames: string[];
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

/**
 * Product lines on a version, ignoring notes and headings.
 *
 * Optional lines ARE included. An option the customer takes still has to ship, so
 * excluding it here meant a taken option arrived with no freight ever quoted for
 * it — and on a proposal where most sections are optional, it meant the freight
 * rail showed a handful of items out of dozens.
 */
function productLines(items: unknown): ProposalLine[] {
  if (!Array.isArray(items)) return [];
  return (items as ProposalLine[]).filter(
    (l) =>
      l && (l.lineType ?? 'PRODUCT') === 'PRODUCT' && s(l.sku).trim() !== '' && n(l.quantity) > 0,
  );
}

/**
 * Vendor for each SKU on the version.
 *
 * Delegates to vendorResolution.ts, which reads BOTH catalog tables. This used to
 * query `Sku` alone, so every part whose vendor is recorded through
 * `ProductSourcing` came back with no vendor and was dropped by the caller — the
 * cause of a Freight Requests rail that listed one vendor when the proposal had
 * several.
 */
async function vendorBySku(skus: string[]): Promise<Map<string, string>> {
  const { vendorBySku: map } = await resolveVendors(skus);
  return map;
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
export async function listRfqVendors(
  versionId: string,
  draftLines?: ProposalLine[],
): Promise<RfqVendorList> {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: { id: true, items: true, proposalId: true },
  });
  if (!version) throw new NotFoundError('Proposal version not found');

  const lines =
    draftLines && draftLines.length ? productLines(draftLines) : productLines(version.items);
  const { vendorBySku: skuVendor } = await resolveVendors(lines.map((l) => s(l.sku)));

  const grouped = new Map<string, { lineCount: number; unitCount: number; cost: number }>();
  const unmatchedSkus: string[] = [];
  const unmatchedNames: string[] = [];
  for (const l of lines) {
    // Keyed on the normalized SKU, so a stray trailing space on a proposal line
    // no longer costs the line its vendor.
    const vendor = skuVendor.get(skuKey(l.sku));
    if (!vendor) {
      // Reported, not skipped. An unattributable part is precisely the one that
      // would otherwise miss its freight request unnoticed.
      const sku = s(l.sku).trim();
      if (sku && !unmatchedSkus.includes(sku)) {
        unmatchedSkus.push(sku);
        unmatchedNames.push(s(l.name).trim() || sku);
      }
      continue;
    }
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

  const vendors = [...grouped.entries()]
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
    .sort(
      (a, b) => Number(b.rfqEnabled) - Number(a.rfqEnabled) || a.vendor.localeCompare(b.vendor),
    );

  return { vendors, unmatchedSkus, unmatchedNames };
}

/**
 * The Project ID in the middle of "RFQ-12414494509-SE".
 *
 * It is monday's Project ID column, `pulse_id_mm5kc9f8` (DEAL_COL.projectId). That
 * is an Item ID column by type, so its value IS the monday item id — 12414494509
 * for the Remedy Speech Therapy deal. An earlier version of this function threw the
 * value away whenever it matched the item id, on the assumption that a number that
 * long could not be the intended reference. It is: that column is the convention,
 * and discarding it silently fell back to the proposal number instead.
 *
 * Three sources, in the order they can be trusted:
 *
 *   1. The Project ID typed on the proposal itself. It prints on the customer's
 *      document, so an RFQ quoting a different number would contradict paperwork
 *      the customer is holding.
 *   2. A live read of the monday deal row's Project ID column.
 *   3. The proposal number, so an unreachable board never blocks the rep.
 */
async function resolveProjectId(
  organizationId: string,
  metaProjectId: string,
  fallback: string,
): Promise<string> {
  const typed = s(metaProjectId).trim();
  if (typed) return typed;
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
    logger.warn(
      { err, organizationId },
      'freight rfq: could not read the monday Project ID, using the proposal number',
    );
    return fallback;
  }
}

/** The Project ID a rep typed into the proposal builder, if any. */
function metaProjectIdOf(sections: unknown): string {
  if (!Array.isArray(sections)) return '';
  for (const sec of sections as Array<{ data?: { projectId?: unknown } }>) {
    const v = s(sec?.data?.projectId).trim();
    if (v) return v;
  }
  return '';
}

/**
 * Vendor short code for the RFQ reference.
 *
 * The code chosen on the manufacturer profile wins. Where none is set, initials are
 * derived from the name — "Southpaw Enterprises" gives SE, "Goldberg Brothers"
 * gives GB, a single-word vendor gives its first three letters — so every request
 * is distinguishable the day this ships, without anyone editing 40 vendor records
 * first. Set the field to override a derivation that reads badly.
 */
export function vendorAbbrev(vendor: string, stored?: string | null): string {
  const explicit = (stored || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
  if (explicit) return explicit.slice(0, 8);
  const words = String(vendor || '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(the|and|of|inc|llc|co|company|corp|ltd)$/i.test(w));
  const first = words[0];
  if (!first) return '';
  if (words.length === 1) return first.slice(0, 3).toUpperCase();
  return words
    .map((w) => w[0])
    .join('')
    .slice(0, 4)
    .toUpperCase();
}

/**
 * RFQ-\<Project ID\>-\<vendor code\>\[ R\<revision\>\]\[ S\<submission\>\].
 *
 *   RFQ-12414494509-SE          Southpaw Enterprises, Remedy Speech Therapy
 *   RFQ-12414494509-SE S2       the same request emailed a second time
 *   RFQ-12414494509-SE R2       revised content, first send of that revision
 *   RFQ-12414494509-SE R2 S3    that revision, emailed a third time
 *
 * R and S mean different things and both are needed. R changes when the CONTENT
 * changes — lines added, quantities corrected — and the vendor should quote the new
 * document instead of the old one. S changes when the SAME document goes out again
 * because it was mislaid or never answered. Collapsing them would lose the
 * distinction between "please requote" and "please look at this again".
 *
 * The vendor code sits before both, because it is the part that never changes for
 * the life of the request. Without a code the bare "RFQ-12414494509" form is
 * produced unchanged, so references raised before any of this existed still parse.
 */
export function rfqReference(
  projectId: string,
  revision: number,
  abbrev?: string | null,
  submission = 1,
): string {
  let ref = abbrev ? `RFQ-${projectId}-${abbrev}` : `RFQ-${projectId}`;
  if (revision > 1) ref += ` R${revision}`;
  if (submission > 1) ref += ` S${submission}`;
  return ref;
}

/**
 * Ship-to for the request.
 *
 * Three sources, in the order they can be trusted:
 *
 *   1. **The address the customer confirmed in the portal.** They typed it, about
 *      their own building, for this job. Nothing beats it.
 *   2. The organization's SHIPPING address.
 *   3. Its BILLING address — a customer with one address on file usually has it
 *      filed as billing, and a freight quote to nowhere is useless.
 *
 * The organization record is the BILLING entity, which on a job site with a
 * trailer, or a school district with a central office, is the wrong building. It
 * was the only source this used; that was a bug, and quoting freight to the wrong
 * city is a bug that costs money. `shipToSource` is stored beside the frozen
 * fields so the RFQ screen can show which of the three is in play before anyone
 * sends it.
 *
 * `proposalId` is optional because the portal address usually does not exist yet
 * when the RFQ is raised — the invite goes out after the order, and RFQs are
 * quoted at proposal time. When it does exist, it wins.
 */
async function shipToFor(organizationId: string, proposalId?: string) {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, addresses: true },
  });
  if (!org) throw new NotFoundError('Customer not found');

  if (proposalId) {
    const confirmed = await confirmedAddressForProposal(proposalId).catch(() => null);
    if (confirmed?.line1 && confirmed.city) {
      return {
        shipToName: org.name,
        shipToLine1: s(confirmed.line1) || null,
        shipToLine2: s(confirmed.line2) || null,
        shipToCity: s(confirmed.city) || null,
        shipToRegion: s(confirmed.region) || null,
        shipToPostal: s(confirmed.postalCode) || null,
        shipToCountry: s(confirmed.country) || 'United States',
        shipToSource: 'PORTAL_CONFIRMED',
      };
    }
  }

  const shipping = org.addresses.find((a) => a.type === 'SHIPPING');
  const ship = shipping ?? org.addresses.find((a) => a.type === 'BILLING');
  return {
    shipToName: org.name,
    shipToLine1: s(ship?.line1) || null,
    shipToLine2: s(ship?.line2) || null,
    shipToCity: s(ship?.city) || null,
    shipToRegion: s(ship?.region) || null,
    shipToPostal: s(ship?.postalCode) || null,
    shipToCountry: s(ship?.country) || 'United States',
    shipToSource: !ship ? 'NONE' : shipping ? 'ORG_SHIPPING' : 'ORG_BILLING',
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
      id: true,
      items: true,
      sections: true,
      proposalId: true,
      createdById: true,
      proposal: { select: { id: true, number: true, organizationId: true } },
    },
  });
  if (!version?.proposal) throw new NotFoundError('Proposal version not found');

  const open = await prisma.freightRfq.findFirst({
    where: { proposalId: version.proposalId, vendor: input.vendor, status: { not: 'SUPERSEDED' } },
  });
  if (open)
    throw new ValidationError(`There is already an RFQ for ${input.vendor} on this proposal.`);

  const lines = productLines(version.items);
  const skuVendor = await vendorBySku(lines.map((l) => s(l.sku)));
  // skuKey, matching listRfqVendors exactly. If these two disagreed about which
  // lines belong to a vendor, the card would offer a count the document did not
  // contain.
  const mine = lines.filter(
    (l) => (skuVendor.get(skuKey(l.sku)) ?? '').toLowerCase() === input.vendor.toLowerCase(),
  );
  if (!mine.length)
    throw new ValidationError(`No lines on this proposal are sourced from ${input.vendor}.`);

  const mfr = await prisma.manufacturer.findFirst({
    where: { name: input.vendor },
    select: { id: true, rfqAbbrev: true },
  });
  const projectId = await resolveProjectId(
    version.proposal.organizationId,
    metaProjectIdOf(version.sections),
    version.proposal.number,
  );
  // The rep who built the proposal is the point of contact, not whoever happens
  // to be raising the RFQ.
  const contact = await contactFor(version.createdById);
  const shipTo = await shipToFor(version.proposal.organizationId, version.proposalId);
  // Resolved once, then frozen on the row — see vendorAbbrev above.
  const abbrev = vendorAbbrev(input.vendor, mfr?.rfqAbbrev ?? null);

  const rfq = await prisma.freightRfq.create({
    data: {
      proposalId: version.proposalId,
      versionId: version.id,
      organizationId: version.proposal.organizationId,
      vendor: input.vendor,
      manufacturerId: mfr?.id ?? null,
      projectId,
      vendorAbbrev: abbrev,
      reference: rfqReference(projectId, 1, abbrev),
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
export async function addRfqLine(
  rfqId: string,
  input: { sku: string; name?: string; quantity: number },
) {
  const rfq = await prisma.freightRfq.findUnique({
    where: { id: rfqId },
    include: { lines: true },
  });
  if (!rfq) throw new NotFoundError('RFQ not found');
  assertEditable(rfq);
  if (rfq.lines.some((l) => l.sku.toLowerCase() === input.sku.trim().toLowerCase())) {
    throw new ValidationError(`${input.sku} is already on this RFQ.`);
  }

  // Both catalog tables. Reading Sku alone rejected every Product-only part,
  // which is the same set the rail reports as having no supplier — so the one
  // remedy offered for them did not work.
  const sku = await resolvePartDetails(input.sku);
  if (!sku) throw new ValidationError(`${input.sku} is not in the catalogue.`);

  const qty = Math.max(1, Math.round(input.quantity));
  const last = rfq.lines.reduce((m, l) => Math.max(m, l.sortOrder), 0);
  await prisma.freightRfqLine.create({
    data: {
      rfqId,
      sku: sku.part,
      name: input.name?.trim() || sku.name,
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
  if (!line?.addedManually)
    throw new ValidationError(
      'Untick this line instead — only manually added lines can be removed.',
    );
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
  if (prev.status === 'DRAFT')
    throw new ValidationError('This RFQ has not been sent yet — edit it directly.');

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
        vendorAbbrev: prev.vendorAbbrev,
        reference: rfqReference(prev.projectId, revision, prev.vendorAbbrev),
        revision,
        notes: prev.notes,
        shipToName: prev.shipToName,
        shipToLine1: prev.shipToLine1,
        shipToLine2: prev.shipToLine2,
        shipToCity: prev.shipToCity,
        shipToRegion: prev.shipToRegion,
        shipToPostal: prev.shipToPostal,
        shipToCountry: prev.shipToCountry,
        // Carried forward, not re-resolved: a revision corrects the LINES. Moving
        // the ship-to under the vendor because a portal submission landed between
        // revisions would change the shipment without anyone asking for it. Clear
        // the address on the screen to pick it up deliberately.
        shipToSource: prev.shipToSource,
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
  /** How many times this same document has been emailed — the "S2" in the reference. */
  submission: number;
  status: string;
  vendor: string;
  notes: string;
  projectId: string;
  todayLabel: string;
  submittedLabel: string;
  company: typeof COMPANY;
  customerName: string;
  shipTo: {
    name: string;
    lines: string[];
    /** PORTAL_CONFIRMED | ORG_SHIPPING | ORG_BILLING | NONE — shown on the screen, not on the document. */
    source: string;
    /** One line the screen can print as-is. */
    sourceLabel: string;
  };
  contact: { name: string; phone: string };
  submittedBy: { name: string; email: string };
  lines: Array<{
    id: string;
    sku: string;
    name: string;
    quantity: number;
    unitCostMinor: number;
    extendedCostMinor: number;
    included: boolean;
    addedManually: boolean;
  }>;
  totalCostMinor: number;
  sentAt: string | null;
}

/**
 * What the screen says about where the ship-to came from. Plain sentences: the
 * person about to email a freight desk needs to know whether this is the site the
 * customer confirmed or the address on the invoice, and "ORG_BILLING" does not
 * tell them that.
 */
export function shipToSourceLabel(source: string | null | undefined): string {
  switch (s(source)) {
    case 'PORTAL_CONFIRMED':
      return 'Confirmed by the customer in the portal';
    case 'ORG_SHIPPING':
      return 'Shipping address on the customer record';
    case 'ORG_BILLING':
      return 'Billing address on the customer record — no shipping address on file';
    case 'NONE':
      return 'No address on file — fill this in before sending';
    default:
      return 'Customer record';
  }
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
    submission: rfq.submission,
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
      lines: [streetLine(rfq.shipToLine1, rfq.shipToLine2), cityLine, s(rfq.shipToCountry)].filter(
        Boolean,
      ),
      source: s(rfq.shipToSource) || 'ORG',
      sourceLabel: shipToSourceLabel(rfq.shipToSource),
    },
    contact: { name: s(rfq.contactName), phone: s(rfq.contactPhone) },
    // The name is the rep who owns the job; the address is the sales desk. A
    // vendor replying to a personal inbox is a quote nobody else can see, and
    // it is the same address the email's reply-to carries.
    submittedBy: { name: s(creator?.name), email: env.RFQ_REPLY_TO },
    lines: rfq.lines.map((l) => ({
      id: l.id,
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      unitCostMinor: l.unitCostMinor,
      extendedCostMinor: l.extendedCostMinor,
      included: l.included,
      addedManually: l.addedManually,
    })),
    totalCostMinor: rfq.lines
      .filter((l) => l.included)
      .reduce((t, l) => t + l.extendedCostMinor, 0),
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
    include: {
      lines: { where: { included: true }, orderBy: { sortOrder: 'asc' } },
      // The most recent send carries the delivery answer. Earlier sends are history —
      // a request sent three times has one current state, and that is the last one.
      sends: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    vendor: r.vendor,
    reference: r.reference,
    revision: r.revision,
    submission: r.submission,
    status: r.status,
    shipToSource: r.shipToSource ?? 'ORG',
    shipToSourceLabel: shipToSourceLabel(r.shipToSource),
    requestedAt: (r.sentAt ?? r.createdAt).toISOString(),
    totalCostMinor: r.totalCostMinor,
    itemCount: r.lines.length,
    items: r.lines.map((l) => ({ sku: l.sku, name: l.name, quantity: l.quantity })),
    /**
     * What the mail provider reported about the last send.
     *
     * Distinct from `status` above, which is where the REQUEST is in its lifecycle —
     * sent, quoted, cancelled. A request can be SENT and undelivered at the same time,
     * and that combination is the one worth surfacing: a vendor who never received it
     * is not slow, they are absent, and nobody finds out until the job needs the number.
     */
    delivery: r.sends[0]
      ? {
          status: r.sends[0].status,
          toEmail: r.sends[0].toEmail,
          sentAt: r.sends[0].createdAt.toISOString(),
          deliveredAt: r.sends[0].deliveredAt ? r.sends[0].deliveredAt.toISOString() : null,
          openedAt: r.sends[0].openedAt ? r.sends[0].openedAt.toISOString() : null,
          error: r.sends[0].error,
        }
      : null,
  }));
}
