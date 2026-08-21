import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../lib/errors.js';
import { resolveVendors } from './vendorResolution.js';

/**
 * Freight coverage — which product lines on a proposal have had their freight
 * requested, and which are still waiting.
 *
 * The RFQ module answers "who could we ask?". This answers the question a rep
 * actually has after release: "is anything on this job still un-quoted?" — and it
 * has to survive the proposal moving underneath a sent request:
 *
 *   - A line added after an RFQ went out is NOT covered by it. The vendor quoted
 *     a shipment that no longer matches, so the request needs a revision.
 *   - A line removed after an RFQ went out is still on the vendor's document. It
 *     is reported separately rather than forgotten, so the request can be
 *     corrected instead of quietly disagreeing with the proposal.
 *
 * Matching is by SKU. Quantity changes are deliberately not treated as a gap:
 * they are, but flagging every quantity nudge as "not requested" would bury the
 * lines that were never asked about at all.
 */

const s = (v: unknown): string => (v == null ? '' : String(v));
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const key = (v: unknown): string => s(v).trim().toLowerCase();

interface ProposalLine {
  lineType?: string;
  optional?: boolean;
  name?: string;
  sku?: string;
  quantity?: number;
  costEach?: number;
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
 * REQUESTED — on a sent RFQ.
 * DRAFT     — on an RFQ that has been raised but not emailed. Still an open action.
 * PENDING   — the vendor quotes freight and has not been asked about this line.
 * NA        — no vendor on record, or a vendor who does not quote freight for us.
 */
export type FreightLineState = 'REQUESTED' | 'DRAFT' | 'PENDING' | 'NA';

export interface FreightCoverageLine {
  sku: string;
  name: string;
  quantity: number;
  vendor: string | null;
  rfqEnabled: boolean;
  state: FreightLineState;
  rfqId: string | null;
  reference: string | null;
  sentAt: string | null;
}

export interface FreightRemovedLine {
  sku: string;
  name: string;
  quantity: number;
  vendor: string;
  rfqId: string;
  reference: string;
  status: string;
}

export interface FreightPendingVendor {
  vendor: string;
  lineCount: number;
  /** A live (non-superseded) RFQ for this vendor, if one exists. */
  existingRfqId: string | null;
  existingStatus: string | null;
  existingReference: string | null;
}

export interface FreightCoverage {
  proposalId: string;
  versionId: string;
  lines: FreightCoverageLine[];
  removed: FreightRemovedLine[];
  pendingVendors: FreightPendingVendor[];
  requestedCount: number;
  pendingCount: number;
  /** True when something still has to be sent to a vendor. */
  needsRequest: boolean;
}

interface RfqRow {
  id: string;
  vendor: string;
  reference: string;
  status: string;
  sentAt: Date | null;
  lines: Array<{ sku: string; name: string; quantity: number; included: boolean }>;
}

interface Ctx {
  /** SKU part number → vendor name, as it appears on Sku.manufacturer. */
  vendorBySku: Map<string, string>;
  /** Lower-cased vendor names that quote freight for us. */
  rfqVendors: Set<string>;
  rfqsByProposal: Map<string, RfqRow[]>;
}

/** One read of every lookup the computation needs, for any number of versions. */
async function contextFor(versions: Array<{ proposalId: string; items: unknown }>): Promise<Ctx> {
  const skus = new Set<string>();
  for (const v of versions) for (const l of productLines(v.items)) skus.add(s(l.sku).trim());

  const [resolution, mfrs, rfqs] = await Promise.all([
    // Reads Sku AND Product/ProductSourcing. Reading Sku alone left every
    // sourcing-recorded part with no vendor, so it was reported as uncovered
    // freight that no vendor card could ever cover.
    resolveVendors([...skus]),
    prisma.manufacturer.findMany({ where: { rfqEnabled: true }, select: { name: true } }),
    prisma.freightRfq.findMany({
      where: {
        proposalId: { in: [...new Set(versions.map((v) => v.proposalId))] },
        status: { not: 'SUPERSEDED' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        proposalId: true,
        vendor: true,
        reference: true,
        status: true,
        sentAt: true,
        lines: {
          select: { sku: true, name: true, quantity: true, included: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    }),
  ]);

  const vendorBySku = resolution.vendorBySku;

  const rfqsByProposal = new Map<string, RfqRow[]>();
  for (const r of rfqs) {
    const list = rfqsByProposal.get(r.proposalId) ?? [];
    list.push({
      id: r.id,
      vendor: r.vendor,
      reference: r.reference,
      status: r.status,
      sentAt: r.sentAt,
      lines: r.lines,
    });
    rfqsByProposal.set(r.proposalId, list);
  }

  return { vendorBySku, rfqVendors: new Set(mfrs.map((m) => key(m.name))), rfqsByProposal };
}

function computeCoverage(
  version: { id: string; proposalId: string; items: unknown },
  lines: ProposalLine[],
  ctx: Ctx,
): FreightCoverage {
  const rfqs = ctx.rfqsByProposal.get(version.proposalId) ?? [];

  // SKU → the request that covers it. A sent request wins over a draft: the
  // vendor is holding the sent one.
  const cover = new Map<string, RfqRow>();
  for (const r of rfqs) {
    for (const l of r.lines) {
      if (!l.included) continue;
      const k = key(l.sku);
      const held = cover.get(k);
      if (!held || (held.status !== 'SENT' && r.status === 'SENT')) cover.set(k, r);
    }
  }

  const out: FreightCoverageLine[] = lines.map((l) => {
    const sku = s(l.sku).trim();
    const vendor = ctx.vendorBySku.get(key(sku)) ?? null;
    const rfqEnabled = !!vendor && ctx.rfqVendors.has(key(vendor));
    const held = cover.get(key(sku));
    let state: FreightLineState = 'NA';
    if (rfqEnabled) {
      if (held && held.status === 'SENT') state = 'REQUESTED';
      else if (held) state = 'DRAFT';
      else state = 'PENDING';
    }
    return {
      sku,
      name: s(l.name),
      quantity: Math.round(n(l.quantity)),
      vendor,
      rfqEnabled,
      state,
      rfqId: state === 'REQUESTED' || state === 'DRAFT' ? held!.id : null,
      reference: state === 'REQUESTED' || state === 'DRAFT' ? held!.reference : null,
      sentAt: held?.sentAt ? held.sentAt.toISOString() : null,
    };
  });

  // On a request but no longer on the proposal. Kept, never dropped: the vendor's
  // document still lists it.
  const onProposal = new Set(out.map((l) => key(l.sku)));
  const removed: FreightRemovedLine[] = [];
  const seenRemoved = new Set<string>();
  for (const r of rfqs) {
    for (const l of r.lines) {
      if (!l.included) continue;
      const k = key(l.sku);
      if (onProposal.has(k) || seenRemoved.has(k)) continue;
      seenRemoved.add(k);
      removed.push({
        sku: l.sku,
        name: l.name,
        quantity: l.quantity,
        vendor: r.vendor,
        rfqId: r.id,
        reference: r.reference,
        status: r.status,
      });
    }
  }

  const live = new Map<string, RfqRow>();
  for (const r of rfqs) if (!live.has(key(r.vendor))) live.set(key(r.vendor), r);

  const grouped = new Map<string, number>();
  for (const l of out) {
    if (l.state !== 'PENDING' || !l.vendor) continue;
    grouped.set(l.vendor, (grouped.get(l.vendor) ?? 0) + 1);
  }
  const pendingVendors: FreightPendingVendor[] = [...grouped.entries()]
    .map(([vendor, lineCount]) => {
      const r = live.get(key(vendor));
      return {
        vendor,
        lineCount,
        existingRfqId: r?.id ?? null,
        existingStatus: r?.status ?? null,
        existingReference: r?.reference ?? null,
      };
    })
    .sort((a, b) => a.vendor.localeCompare(b.vendor));

  const pendingCount = out.filter((l) => l.state === 'PENDING').length;
  const draftCount = out.filter((l) => l.state === 'DRAFT').length;

  return {
    proposalId: version.proposalId,
    versionId: version.id,
    lines: out,
    removed,
    pendingVendors,
    requestedCount: out.filter((l) => l.state === 'REQUESTED').length,
    pendingCount,
    needsRequest: pendingCount > 0 || draftCount > 0,
  };
}

/**
 * Coverage for one version. `draftLines` lets the builder ask about the lines on
 * screen rather than the stored ones, so a part dropped onto the proposal is
 * flagged straight away instead of after a save.
 */
export async function freightCoverage(
  versionId: string,
  draftLines?: ProposalLine[],
): Promise<FreightCoverage> {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: { id: true, items: true, proposalId: true },
  });
  if (!version) throw new NotFoundError('Proposal version not found');
  const lines =
    draftLines && draftLines.length ? productLines(draftLines) : productLines(version.items);
  const ctx = await contextFor([{ proposalId: version.proposalId, items: lines }]);
  return computeCoverage(version, lines, ctx);
}

export interface FreightAlert {
  proposalId: string;
  versionId: string;
  number: string;
  title: string;
  customer: string;
  version: number;
  releasedAt: string | null;
  pendingCount: number;
  removedCount: number;
  vendors: string[];
  /** A vendor has a request raised but never emailed. */
  hasDraft: boolean;
}

/**
 * Released proposals with freight still to request — the dashboard alert.
 *
 * Only the latest released version of each proposal is examined. An older
 * released version has been superseded by a newer one and nobody is going to
 * quote freight against it.
 */
export async function releasedFreightAlerts(limit = 40): Promise<FreightAlert[]> {
  const versions = await prisma.proposalVersion.findMany({
    where: { status: 'RELEASED' },
    orderBy: [{ releasedAt: 'desc' }, { createdAt: 'desc' }],
    take: 200,
    select: {
      id: true,
      version: true,
      releasedAt: true,
      items: true,
      proposalId: true,
      proposal: { select: { id: true, number: true, title: true, organizationId: true } },
    },
  });

  const latest = new Map<string, (typeof versions)[number]>();
  for (const v of versions) {
    const held = latest.get(v.proposalId);
    if (!held || v.version > held.version) latest.set(v.proposalId, v);
  }
  const rows = [...latest.values()].slice(0, limit);
  if (!rows.length) return [];

  const [ctx, orgs] = await Promise.all([
    contextFor(rows.map((v) => ({ proposalId: v.proposalId, items: v.items }))),
    prisma.organization.findMany({
      where: { id: { in: [...new Set(rows.map((v) => v.proposal.organizationId))] } },
      select: { id: true, name: true },
    }),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  const alerts: FreightAlert[] = [];
  for (const v of rows) {
    const cov = computeCoverage(v, productLines(v.items), ctx);
    if (!cov.needsRequest) continue;
    const draftVendors = cov.pendingVendors.filter((p) => p.existingStatus === 'DRAFT');
    alerts.push({
      proposalId: v.proposalId,
      versionId: v.id,
      number: v.proposal.number,
      title: v.proposal.title,
      customer: orgName.get(v.proposal.organizationId) ?? '',
      version: v.version,
      releasedAt: v.releasedAt ? v.releasedAt.toISOString() : null,
      pendingCount: cov.pendingCount || cov.lines.filter((l) => l.state === 'DRAFT').length,
      removedCount: cov.removed.length,
      vendors: cov.pendingVendors.length
        ? cov.pendingVendors.map((p) => p.vendor)
        : [
            ...new Set(cov.lines.filter((l) => l.state === 'DRAFT').map((l) => l.vendor ?? '')),
          ].filter(Boolean),
      hasDraft: draftVendors.length > 0 || cov.lines.some((l) => l.state === 'DRAFT'),
    });
  }
  return alerts;
}
