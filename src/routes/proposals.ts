import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { releaseFreightRequest } from './freight.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError, NotFoundError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import {
  createProposal,
  updateVersionContent,
  createNewVersion,
  changeStatus,
  compareProposalVersions,
  discardDraftVersion,
  renameProposalForVersion,
  priceEntryStatus,
} from '../proposals/service.js';
import { snapshotAcceptedContent } from '../handoff/service.js';
import {
  resolveVisibleSections,
  reorderSections,
  type ProposalSection,
} from '../proposals/sections.js';
import { pushReleasedProposal } from '../integrations/monday/proposalPush.js';
import { backfillProjectIdOnVersions } from '../crm/projectId.js';

const SectionSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  order: z.number().int(),
  enabled: z.boolean(),
  condition: z.object({ field: z.string(), equals: z.unknown() }).optional(),
  body: z.string().optional(),
  data: z.record(z.unknown()).optional(),
});
const ItemSchema = z.object({
  ref: z.string(),
  productId: z.string(),
  name: z.string(),
  kind: z.enum(['INCLUDED', 'OPTIONAL', 'ALTERNATE']),
  quantity: z.number().int().positive(),
  alternateForRef: z.string().optional(),
  // Unit price in minor units. Nullable and optional on purpose: absent means the
  // line is still awaiting a price, which is a different state from 0. The gate in
  // changeStatus is what enforces an answer before the proposal goes out.
  rateMinor: z.number().int().nullish(),
  // Why a line is $0.00. Required by the gate whenever rateMinor is 0.
  priceNote: z.string().trim().max(200).nullish(),
});
const CreateSchema = z.object({
  organizationId: z.string().min(1),
  /** Which of the customer's deals this proposal is for. Optional — see the schema. */
  opportunityId: z.string().min(1).nullish(),
  title: z.string().min(2),
  sections: z.array(SectionSchema),
  items: z.array(ItemSchema),
  priceSnapshotId: z.string().optional(),
  ruleSnapshotId: z.string().optional(),
  expirationDate: z.coerce.date().optional(),
});

/**
 * How long after release a proposal is chased. Overridable per customer from the
 * proposal page or CRM; this is only the value used when nobody has said otherwise.
 */
const FOLLOW_UP_DAYS = 7;

/**
 * Roles that may archive or restore ANY proposal. Everyone else holding
 * PROPOSAL_ARCHIVE (a sales rep) is limited to the ones they created.
 */
const MANAGES_ANY_PROPOSAL = ['SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_MANAGER', 'ACCOUNTING'];

export function registerProposalRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };
  const review = { preHandler: requirePermission(Permission.PROPOSAL_REVIEW) };
  const release = { preHandler: requirePermission(Permission.PROPOSAL_RELEASE) };
  const archive = { preHandler: requirePermission(Permission.PROPOSAL_ARCHIVE) };

  // The list view needs the customer name, the created/modified/expiration dates
  // and the version count in one round trip — the proposal record itself carries
  // only organizationId, so the org names are resolved here rather than by the
  // client (which previously over-fetched /crm/organizations and came back empty).
  app.get('/proposals', read, async () => {
    const rows = await prisma.proposal.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    const orgIds = [...new Set(rows.map((r) => r.organizationId))];
    const [orgs, users, invoices] = await Promise.all([
      prisma.organization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, name: true, customerType: true },
      }),
      prisma.user.findMany({ select: { id: true, name: true, email: true } }),
      // An accepted proposal that has been billed is a closed deal, and the invoice
      // existing in QuickBooks is what says so. Only CREATED counts: a prepared or
      // authorized invoice has not been raised yet, and a VOIDED one has been undone.
      prisma.qboTransaction.findMany({
        where: { type: 'INVOICE', status: 'CREATED' },
        orderBy: { createdAt: 'asc' },
        select: { proposalId: true, qboDocNumber: true, createdAt: true, amountMinor: true },
      }),
    ]);
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const userById = new Map(users.map((u) => [u.id, u.name || u.email]));
    const invoiceByProposal = new Map(invoices.map((t) => [t.proposalId, t]));
    return rows.map((p) => {
      const latest = p.versions[0];
      const org = orgById.get(p.organizationId);
      const inv = invoiceByProposal.get(p.id) ?? null;
      return {
        ...p,
        versions: p.versions.slice(0, 1),
        versionCount: p.versions.length,
        organizationName: org?.name ?? null,
        customerType: org?.customerType ?? null,
        preparedBy: userById.get(p.createdById) ?? null,
        expirationDate: latest?.expirationDate ?? null,
        lastModifiedAt: latest?.updatedAt ?? p.updatedAt,
        archivedBy: p.archivedById ? (userById.get(p.archivedById) ?? null) : null,
        /** Deal Closed: accepted and invoiced in QuickBooks. */
        invoiced: !!inv,
        invoiceDocNumber: inv?.qboDocNumber ?? null,
        invoicedAt: inv?.createdAt ?? null,
      };
    });
  });

  app.post('/proposals', write, async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const { expirationDate, sections, ...rest } = parsed.data;
    // SectionSchema types `type` as a free string for forward compatibility; the
    // service narrows it to the ProposalSectionType union.
    const result = await createProposal(
      { ...rest, sections: sections as ProposalSection[], expirationDate: expirationDate ?? null },
      req.user!.sub,
    );
    return reply.status(201).send(result);
  });

  /**
   * One proposal with everything its page shows.
   *
   * The customer name and the three customer-level dates are resolved here rather
   * than left to the client. The page leads with the customer name, and a header that
   * needs a second request to say whose proposal this is renders blank first — which
   * is exactly what it did.
   *
   * The dates live on Organization, not on the proposal: one account has one decision
   * window, and a per-proposal copy would disagree with itself across versions.
   *
   * The Project ID is backfilled here for the same reason it is stamped at creation:
   * the builder reads it off the version, and a draft that predates that stamping
   * would still open blank and refuse to request freight. Editable drafts keep the
   * backfilled value; frozen versions are only annotated in the response.
   */
  app.get('/proposals/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    const proposal = await prisma.proposal.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: 'asc' } } },
    });
    if (!proposal) return null;
    const versions = await backfillProjectIdOnVersions(proposal.organizationId, proposal.versions);
    const org = await prisma.organization.findUnique({
      where: { id: proposal.organizationId },
      select: {
        name: true,
        decisionFrom: true,
        decisionTo: true,
        followUpDate: true,
      },
    });
    const day = (d: Date | null | undefined): string | null =>
      d ? d.toISOString().slice(0, 10) : null;
    return {
      ...proposal,
      versions,
      organizationName: org?.name ?? null,
      // Same YYYY-MM-DD shape the date inputs and PATCH /crm/organizations/:id/dates
      // both use, so the panel round-trips without reformatting.
      customerDates: {
        decisionFrom: day(org?.decisionFrom),
        decisionTo: day(org?.decisionTo),
        followUpDate: day(org?.followUpDate),
      },
    };
  });

  // Preview: returns visible sections resolved for the given facts (conditional + reordered).
  app.post('/proposals/versions/:versionId/preview', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const facts = (req.body as { facts?: Record<string, unknown> })?.facts ?? {};
    const v = await prisma.proposalVersion.findUnique({ where: { id: versionId } });
    if (!v) throw new ValidationError('Version not found');
    const sections = v.sections as unknown as ProposalSection[];
    return {
      visibleSections: resolveVisibleSections(sections, facts),
      status: v.status,
      frozen: v.frozen,
    };
  });

  /**
   * Which lines still need a price. The builder calls this as the proposal is
   * written so the rows can be badged in place — the hard stop at release should
   * never be the first anyone hears of an unpriced line.
   */
  app.get('/proposals/versions/:versionId/price-check', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    return priceEntryStatus(versionId);
  });

  app.patch('/proposals/versions/:versionId', write, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const body = req.body as {
      title?: string;
      sections?: ProposalSection[];
      items?: unknown[];
      orderedSectionIds?: string[];
      expirationDate?: string;
    };
    let sections = body.sections;
    if (body.orderedSectionIds && sections)
      sections = reorderSections(sections, body.orderedSectionIds);
    // The title belongs to the proposal, not the version, so it is saved alongside
    // the version content rather than needing its own call from the builder.
    if (typeof body.title === 'string' && body.title.trim()) {
      await renameProposalForVersion(versionId, body.title.trim(), req.user!.sub);
    }
    await updateVersionContent(
      versionId,
      {
        ...(sections ? { sections } : {}),
        ...(body.items ? { items: body.items as never } : {}),
        ...(body.expirationDate ? { expirationDate: new Date(body.expirationDate) } : {}),
      },
      req.user!.sub,
    );
    // Saving never blocks — an unpriced line is a normal state mid-build. The audit
    // rides back on the save so the builder can badge the rows without a second call.
    return { ok: true, priceEntry: await priceEntryStatus(versionId) };
  });

  // New version — the ONLY way to change a released proposal.
  app.post('/proposals/:id/versions', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await createNewVersion(id, req.user!.sub);
    return reply.status(201).send(result);
  });

  app.get('/proposals/:id/compare', read, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { a?: string; b?: string };
    if (!q.a || !q.b) throw new ValidationError('a and b version numbers required');
    return compareProposalVersions(id, parseInt(q.a, 10), parseInt(q.b, 10));
  });

  /**
   * The tier tree for a product line configurator (e.g. "Start from Summit
   * Flex"), flattened for the client to rebuild as a checkbox tree. `:lineSlug`
   * matches on slug OR name, since a line's slug does not always derive from
   * its display name (e.g. "Summit Soar" is slug "soar").
   *
   * defaultQuantity resolves tier-first: a tier node can override the quantity
   * a product defaults to elsewhere in the builder (Product.defaultQuantity),
   * so the configurator always shows one number, never two disagreeing ones.
   */
  app.get('/proposals/line-tree/:lineSlug', read, async (req) => {
    const { lineSlug } = req.params as { lineSlug: string };
    const line = await prisma.productLine.findFirst({
      where: { OR: [{ slug: lineSlug }, { name: lineSlug }] },
      select: { id: true },
    });
    if (!line) throw new NotFoundError(`Product line "${lineSlug}" not found`);

    const cats = await prisma.productCategory.findMany({
      where: { productLineId: line.id, isActive: true },
      orderBy: [{ tierLevel: 'asc' }, { sortOrder: 'asc' }],
      select: {
        id: true,
        slug: true,
        name: true,
        tierLevel: true,
        sortOrder: true,
        defaultQuantity: true,
        parentId: true,
        product: { select: { sku: true, weightOz: true, defaultQuantity: true, status: true } },
      },
    });

    const slugOf = new Map(cats.map((c) => [c.id, c.slug]));
    const skus = [...new Set(cats.map((c) => c.product?.sku).filter((v): v is string => !!v))];
    const priceBySku = skus.length
      ? new Map(
          (
            await prisma.sku.findMany({
              where: { part: { in: skus } },
              select: { part: true, unitPriceMinor: true },
            })
          ).map((s) => [s.part, s.unitPriceMinor]),
        )
      : new Map<string, number>();

    return cats
      .filter((c) => !c.product || c.product.status === 'ACTIVE')
      .map((c) => {
        const sku = c.product?.sku ?? null;
        // null, not 0, when the part has no price on record: the builder copies this
        // straight onto the line, and a 0 here would look like a decision nobody made.
        const priced = sku ? priceBySku.get(sku) : undefined;
        return {
          slug: c.slug,
          name: c.name,
          tierLevel: c.tierLevel,
          parentSlug: c.parentId ? (slugOf.get(c.parentId) ?? null) : null,
          sortOrder: c.sortOrder,
          sku,
          unitPriceMinor: priced ?? null,
          /** True when this part is priced per proposal — the builder prompts for a rate. */
          requiresPriceEntry: !!sku && priced == null,
          weightOz: c.product?.weightOz ?? null,
          defaultQuantity: c.defaultQuantity ?? c.product?.defaultQuantity ?? null,
        };
      });
  });

  // Status transitions, permission-gated by target.
  /**
   * Discard a draft version. Only a draft, only when another version remains, and
   * never when an accepted order is locked to it — the service enforces all three.
   */
  app.delete('/proposals/versions/:versionId', write, async (req) => {
    const { versionId } = req.params as { versionId: string };
    return discardDraftVersion(versionId, req.user!.sub);
  });

  /**
   * Submit for review. Unpriced lines do not block here — they come back as
   * warnings, and are recorded on the status timeline so the reviewer sees the
   * proposal arrived incomplete.
   */
  app.post('/proposals/versions/:versionId/submit-review', write, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const result = await changeStatus(
      versionId,
      'INTERNAL_REVIEW',
      req.user!.sub,
      (req.body as { note?: string })?.note,
    );
    return {
      status: 'INTERNAL_REVIEW',
      warnings: result.warnings,
      priceEntry: result.priceEntry,
    };
  });
  app.post('/proposals/versions/:versionId/return-draft', review, async (req) => {
    const { versionId } = req.params as { versionId: string };
    await changeStatus(versionId, 'DRAFT', req.user!.sub, (req.body as { note?: string })?.note);
    return { status: 'DRAFT' };
  });
  app.post('/proposals/versions/:versionId/release', release, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const body = (req.body ?? {}) as {
      note?: string;
      proposalHtml?: string;
      proposalFilename?: string;
    };
    const before = await prisma.proposalVersion.findUnique({
      where: { id: versionId },
      select: { priceSnapshotId: true, sections: true, items: true },
    });
    // Throws before anything is written when a line is still unpriced, or is $0.00
    // with no reason given — the proposal stays exactly as it was.
    await changeStatus(versionId, 'RELEASED', req.user!.sub, body.note);
    // A released version is the price of record from here on, so it gets a
    // PriceSnapshot at release time rather than waiting for acceptance — but never
    // overwrite one a prior release or acceptance already froze.
    if (before && !before.priceSnapshotId) {
      const snap = await snapshotAcceptedContent(
        versionId,
        before.sections,
        before.items,
        req.user!.sub,
      );
      await prisma.proposalVersion.update({
        where: { id: versionId },
        data: { priceSnapshotId: snap.id },
      });
    }
    // Releasing books the follow-up: seven days after the release, on the customer.
    //
    // Applied here rather than in the browser so it holds however the release
    // happened — the builder, the list's quick-status picker, or a script. It only
    // ever fills a gap: a date already sitting on or after the release is a decision
    // somebody made deliberately (a customer who asked for three weeks), and
    // overwriting that with a default would be the app arguing with its user. A date
    // in the past is a stale follow-up from an earlier round, so that one is replaced.
    const released = await prisma.proposalVersion.findUnique({
      where: { id: versionId },
      select: { releasedAt: true, proposal: { select: { organizationId: true } } },
    });
    if (released?.releasedAt && released.proposal) {
      const org = await prisma.organization.findUnique({
        where: { id: released.proposal.organizationId },
        select: { followUpDate: true },
      });
      const due = new Date(released.releasedAt);
      due.setUTCDate(due.getUTCDate() + FOLLOW_UP_DAYS);
      const existing = org?.followUpDate ?? null;
      if (!existing || existing < released.releasedAt) {
        await prisma.organization.update({
          where: { id: released.proposal.organizationId },
          data: {
            followUpDate: new Date(
              Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()),
            ),
          },
        });
      }
    }
    // Release is also the handoff to the deal board: subtotal, title and the proposal
    // document itself. Reported, never fatal — the proposal is released whatever
    // monday does, and the rep is told if the push did not land.
    const monday = await pushReleasedProposal({
      versionId,
      proposalHtml: body.proposalHtml,
      filename: body.proposalFilename,
    });
    return { status: 'RELEASED', monday };
  });
  app.post('/proposals/versions/:versionId/accept', review, async (req) => {
    const { versionId } = req.params as { versionId: string };
    await changeStatus(versionId, 'ACCEPTED', req.user!.sub, (req.body as { note?: string })?.note);
    return { status: 'ACCEPTED' };
  });
  // Rejecting or shelving a proposal also takes any unanswered freight request back
  // off the monday.com board — the desk works a queue of flagged items and a dead
  // proposal in it costs them a quote nobody will use. releaseFreightRequest never
  // throws, so an unreachable board cannot stop a proposal being marked lost, and it
  // leaves a request the desk has already answered alone.
  app.post('/proposals/versions/:versionId/reject', review, async (req) => {
    const { versionId } = req.params as { versionId: string };
    await changeStatus(versionId, 'REJECTED', req.user!.sub, (req.body as { note?: string })?.note);
    const v = await prisma.proposalVersion.findUnique({
      where: { id: versionId },
      select: { proposalId: true },
    });
    if (v) await releaseFreightRequest(v.proposalId, req.user!.sub, 'proposal rejected');
    return { status: 'REJECTED' };
  });
  app.post('/proposals/versions/:versionId/expire', review, async (req) => {
    const { versionId } = req.params as { versionId: string };
    await changeStatus(versionId, 'EXPIRED', req.user!.sub, (req.body as { note?: string })?.note);
    const v = await prisma.proposalVersion.findUnique({
      where: { id: versionId },
      select: { proposalId: true },
    });
    if (v) await releaseFreightRequest(v.proposalId, req.user!.sub, 'proposal no longer active');
    return { status: 'EXPIRED' };
  });

  /**
   * Archive a proposal — the whole proposal, every version with it.
   *
   * Nothing is deleted and no status changes: an accepted proposal stays accepted, its
   * snapshots and QuickBooks documents stay exactly where they are. The proposal simply
   * leaves every pipeline view and the win-rate maths, and shows up under Archived with
   * its reason. Restoring it clears the three columns and it is back as it was.
   *
   * Two guards. A sales rep may archive only proposals they created — the permission is
   * granted broadly but ownership is checked here, because a rep tidying their own bad
   * quotes must not be able to pull a colleague’s live deal out of the pipeline. And a
   * proposal with live QuickBooks documents comes back needsConfirm on the first call:
   * archiving does NOT void an estimate or an invoice, so somebody has to say out loud
   * that they know the document is still standing in QuickBooks.
   */
  app.post('/proposals/:id/archive', archive, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string; confirm?: string };
    const proposal = await prisma.proposal.findUnique({
      where: { id },
      select: { id: true, number: true, createdById: true, archivedAt: true },
    });
    if (!proposal) throw new NotFoundError('Proposal not found');
    if (proposal.archivedAt) return { ok: true, archivedAt: proposal.archivedAt };
    if (!MANAGES_ANY_PROPOSAL.includes(req.user!.role) && proposal.createdById !== req.user!.sub)
      throw new ValidationError(
        'You can only archive proposals you created. Ask a sales manager to archive this one.',
      );

    const live = await prisma.qboTransaction.findMany({
      where: { proposalId: id, status: 'CREATED' },
      select: { type: true, qboDocNumber: true, amountMinor: true },
    });
    if (live.length && (body.confirm ?? '').trim().toUpperCase() !== 'CONFIRM') {
      return {
        ok: false,
        needsConfirm: true,
        qboDocuments: live.map((t) => ({
          type: t.type,
          docNumber: t.qboDocNumber ?? '—',
          amountMinor: Number(t.amountMinor),
        })),
      };
    }

    const reason = (body.reason ?? '').trim().slice(0, 500) || null;
    const updated = await prisma.proposal.update({
      where: { id },
      data: { archivedAt: new Date(), archivedById: req.user!.sub, archiveReason: reason },
      select: { archivedAt: true, archiveReason: true },
    });
    // A dead proposal must not leave a freight quote sitting in the desk’s queue.
    await releaseFreightRequest(id, req.user!.sub, 'proposal archived');
    await recordAudit({
      actorId: req.user!.sub,
      action: 'proposal.archive',
      entity: 'Proposal',
      entityId: id,
      details: { number: proposal.number, reason, qboDocuments: live.length },
    });
    return { ok: true, ...updated };
  });

  /** Restore an archived proposal. Same ownership rule as archiving. */
  app.post('/proposals/:id/unarchive', archive, async (req) => {
    const { id } = req.params as { id: string };
    const proposal = await prisma.proposal.findUnique({
      where: { id },
      select: { id: true, number: true, createdById: true, archivedAt: true },
    });
    if (!proposal) throw new NotFoundError('Proposal not found');
    if (!proposal.archivedAt) return { ok: true, archivedAt: null };
    if (!MANAGES_ANY_PROPOSAL.includes(req.user!.role) && proposal.createdById !== req.user!.sub)
      throw new ValidationError('You can only restore proposals you created.');
    await prisma.proposal.update({
      where: { id },
      data: { archivedAt: null, archivedById: null, archiveReason: null },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'proposal.unarchive',
      entity: 'Proposal',
      entityId: id,
      details: { number: proposal.number },
    });
    return { ok: true, archivedAt: null };
  });
}
