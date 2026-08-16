import { prisma } from '../lib/prisma.js';
import { ConflictError, ValidationError, NotFoundError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { canTransition, becomesFrozen, isFrozenStatus, formatProposalNumber } from './status.js';
import { compareVersions, type VersionSnapshot } from './compare.js';
import { auditPriceEntry, priceEntryMessage, type PriceEntryAudit } from './priceEntry.js';
import type { ProposalSection, ProposalItem } from './sections.js';
import type { ProposalStatus } from '@prisma/client';

interface VersionContent {
  sections: ProposalSection[];
  items: ProposalItem[];
  priceSnapshotId?: string | null;
  ruleSnapshotId?: string | null;
  expirationDate?: Date | null;
}

/** Allocate the next sequential proposal number for the current year. */
async function nextNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `P-${year}-`;
  const last = await prisma.proposal.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  const seq = last ? parseInt(last.number.slice(prefix.length), 10) + 1 : 1;
  return formatProposalNumber(year, seq);
}

export async function createProposal(
  input: { organizationId: string; opportunityId?: string | null; title: string } & VersionContent,
  userId: string,
): Promise<{ id: string; number: string }> {
  const number = await nextNumber();
  const proposal = await prisma.$transaction(async (tx) => {
    const p = await tx.proposal.create({
      data: {
        number,
        organizationId: input.organizationId,
        // Which of the customer's deals this is for. Optional, because a proposal is
        // often written before an opportunity exists — but when it is set, nothing
        // downstream has to infer the deal from the customer's other projects.
        opportunityId: input.opportunityId ?? null,
        title: input.title,
        currentVersion: 1,
        createdById: userId,
      },
    });
    const v = await tx.proposalVersion.create({
      data: {
        proposalId: p.id,
        version: 1,
        status: 'DRAFT',
        sections: input.sections as object,
        items: input.items as object,
        priceSnapshotId: input.priceSnapshotId ?? null,
        ruleSnapshotId: input.ruleSnapshotId ?? null,
        expirationDate: input.expirationDate ?? null,
        createdById: userId,
      },
    });
    await tx.proposalStatusEvent.create({
      data: { versionId: v.id, toStatus: 'DRAFT', changedById: userId, note: 'created' },
    });
    return p;
  });
  await recordAudit({
    actorId: userId,
    action: 'proposal.create',
    entity: 'Proposal',
    entityId: proposal.id,
  });
  return { id: proposal.id, number };
}

/** Edit a version's content. Refused if the version is frozen (released or later). */
export async function updateVersionContent(
  versionId: string,
  content: Partial<VersionContent>,
  userId: string,
): Promise<void> {
  const version = await prisma.proposalVersion.findUnique({ where: { id: versionId } });
  if (!version) throw new NotFoundError('Version not found');
  if (version.frozen || isFrozenStatus(version.status)) {
    throw new ConflictError(
      'Released proposal versions are immutable. Create a new version to make changes.',
    );
  }
  await prisma.proposalVersion.update({
    where: { id: versionId },
    data: {
      ...(content.sections ? { sections: content.sections as object } : {}),
      ...(content.items ? { items: content.items as object } : {}),
      ...(content.priceSnapshotId !== undefined
        ? { priceSnapshotId: content.priceSnapshotId }
        : {}),
      ...(content.ruleSnapshotId !== undefined ? { ruleSnapshotId: content.ruleSnapshotId } : {}),
      ...(content.expirationDate !== undefined ? { expirationDate: content.expirationDate } : {}),
    },
  });
  await recordAudit({
    actorId: userId,
    action: 'proposal.version.update',
    entity: 'ProposalVersion',
    entityId: versionId,
  });
}

/**
 * Rename the proposal that owns `versionId`.
 *
 * The builder edits the title in the same form as the version content, so it
 * arrives on the version PATCH. A frozen version refuses the rename for the same
 * reason it refuses a line edit: a released document must not change under a
 * customer who already has it.
 */
export async function renameProposalForVersion(
  versionId: string,
  title: string,
  userId: string,
): Promise<void> {
  const version = await prisma.proposalVersion.findUnique({ where: { id: versionId } });
  if (!version) throw new NotFoundError('Version not found');
  if (version.frozen || isFrozenStatus(version.status)) {
    throw new ConflictError(
      'Released proposal versions are immutable. Create a new version to make changes.',
    );
  }
  const proposal = await prisma.proposal.findUnique({ where: { id: version.proposalId } });
  if (!proposal || proposal.title === title) return;
  await prisma.proposal.update({ where: { id: version.proposalId }, data: { title } });
  await recordAudit({
    actorId: userId,
    action: 'proposal.rename',
    entity: 'Proposal',
    entityId: version.proposalId,
    details: { from: proposal.title, to: title },
  });
}

/** Create a new editable DRAFT version by cloning the current one (the only way to change a released proposal). */
export async function createNewVersion(
  proposalId: string,
  userId: string,
): Promise<{ version: number; versionId: string }> {
  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({ where: { id: proposalId } });
    if (!proposal) throw new NotFoundError('Proposal not found');
    const current = await tx.proposalVersion.findUnique({
      where: { proposalId_version: { proposalId, version: proposal.currentVersion } },
    });
    if (!current) throw new NotFoundError('Current version not found');

    const nextVersion = proposal.currentVersion + 1;
    const created = await tx.proposalVersion.create({
      data: {
        proposalId,
        version: nextVersion,
        status: 'DRAFT',
        sections: current.sections as object,
        items: current.items as object,
        priceSnapshotId: current.priceSnapshotId,
        ruleSnapshotId: current.ruleSnapshotId,
        expirationDate: current.expirationDate,
        createdById: userId,
      },
    });
    await tx.proposal.update({ where: { id: proposalId }, data: { currentVersion: nextVersion } });
    await tx.proposalStatusEvent.create({
      data: {
        versionId: created.id,
        toStatus: 'DRAFT',
        changedById: userId,
        note: `cloned from v${current.version}`,
      },
    });
    await recordAudit({
      actorId: userId,
      action: 'proposal.version.create',
      entity: 'ProposalVersion',
      entityId: created.id,
      details: { version: nextVersion },
    });
    return { version: nextVersion, versionId: created.id };
  });
}

/**
 * Throw away a draft version that was started and then thought better of.
 *
 * Raising a version to make a change and then deciding the change is not wanted
 * used to leave the draft sitting above the released one forever, so the proposal
 * read as Draft when the live document was v2. There is no soft-delete: a draft
 * that never left the building is not a record of anything, and keeping it would
 * only reintroduce the confusion it causes.
 *
 * Refused in four cases, each for its own reason:
 *   - not a DRAFT, or frozen — a released version is the record of what a customer
 *     was sent, and that is never deleted;
 *   - the only version — deleting it would leave a proposal with no content, which
 *     nothing downstream expects;
 *   - an accepted order is locked to it — the order's immutability anchor would
 *     point at nothing.
 *
 * Deleting the current version rolls `currentVersion` back to the highest one that
 * remains, so the proposal shows the status of the document that is actually live.
 */
export async function discardDraftVersion(
  versionId: string,
  userId: string,
): Promise<{ proposalId: string; currentVersion: number }> {
  return prisma.$transaction(async (tx) => {
    const version = await tx.proposalVersion.findUnique({
      where: { id: versionId },
      select: { id: true, proposalId: true, version: true, status: true, frozen: true },
    });
    if (!version) throw new NotFoundError('Version not found');
    if (version.frozen || version.status !== 'DRAFT') {
      throw new ConflictError(
        `Only a draft can be discarded — v${version.version} is ${version.status.toLowerCase().replace('_', ' ')}.`,
      );
    }

    const siblings = await tx.proposalVersion.findMany({
      where: { proposalId: version.proposalId, id: { not: versionId } },
      select: { id: true, version: true },
      orderBy: { version: 'desc' },
    });
    // The highest version that will remain once this one is gone. Read after the
    // guards above so it is only ever computed when the delete is going ahead.
    const highest = siblings[0];
    if (!highest) {
      throw new ConflictError('This is the only version — delete the proposal itself instead.');
    }

    const order = await tx.acceptedOrder.findUnique({
      where: { proposalVersionId: versionId },
      select: { number: true },
    });
    if (order) {
      throw new ConflictError(
        `Order ${order.number} is locked to this version — unlock the order first.`,
      );
    }

    // ProposalStatusEvent cascades on the version's own foreign key.
    await tx.proposalVersion.delete({ where: { id: versionId } });

    await tx.proposal.update({
      where: { id: version.proposalId },
      data: { currentVersion: highest.version },
    });

    await recordAudit({
      actorId: userId,
      action: 'proposal.version.discard',
      entity: 'ProposalVersion',
      entityId: versionId,
      details: { version: version.version, currentVersion: highest.version },
    });
    return { proposalId: version.proposalId, currentVersion: highest.version };
  });
}

/**
 * Which lines on a version still need a price. Read-only — the builder polls this
 * to badge the offending rows while the proposal is being written, so the block at
 * release is never the first anyone hears of it.
 */
export async function priceEntryStatus(versionId: string): Promise<PriceEntryAudit> {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: { items: true },
  });
  if (!version) throw new NotFoundError('Version not found');
  return auditPriceEntry(version.items);
}

/**
 * Statuses that put the proposal in front of someone. Sending an unpriced line to
 * a customer is the failure this gate exists to prevent; ACCEPTED and the terminal
 * statuses are recorded after the fact and are never blocked, or a proposal that
 * went out before this rule existed could not be marked won.
 */
const HARD_GATED: ProposalStatus[] = ['RELEASED'];
const WARN_GATED: ProposalStatus[] = ['INTERNAL_REVIEW'];

export interface StatusChangeResult {
  status: ProposalStatus;
  /** Advisory price-entry problems — populated on submit-for-review. */
  warnings: string[];
  priceEntry: PriceEntryAudit;
}

export async function changeStatus(
  versionId: string,
  to: ProposalStatus,
  userId: string,
  note?: string,
): Promise<StatusChangeResult> {
  const version = await prisma.proposalVersion.findUnique({ where: { id: versionId } });
  if (!version) throw new NotFoundError('Version not found');
  if (!canTransition(version.status, to))
    throw new ConflictError(`Illegal transition ${version.status} -> ${to}`);

  // Every priced line must carry an answer before the proposal goes out. Absent is
  // not zero: a line nobody has priced totals as free in versionTotals, so without
  // this the document ships understated and nothing says so.
  const priceEntry = auditPriceEntry(version.items);
  const warnings: string[] = [];
  if (!priceEntry.ok) {
    const message = priceEntryMessage(priceEntry) ?? 'Some lines need a price.';
    if (HARD_GATED.includes(to)) {
      throw new ValidationError(`This proposal cannot be released yet. ${message}`);
    }
    if (WARN_GATED.includes(to)) warnings.push(message);
  }

  await prisma.$transaction(async (tx) => {
    await tx.proposalVersion.update({
      where: { id: versionId },
      data: {
        status: to,
        ...(becomesFrozen(to)
          ? { frozen: true, releasedAt: new Date(), releasedById: userId }
          : {}),
      },
    });
    await tx.proposalStatusEvent.create({
      data: {
        versionId,
        fromStatus: version.status,
        toStatus: to,
        changedById: userId,
        // The warning travels with the status event, so the reviewer sees on the
        // timeline that the proposal arrived with lines still unpriced.
        note:
          [note, warnings.length ? `unpriced at submit: ${warnings.join(' ')}` : null]
            .filter(Boolean)
            .join(' — ')
            .trim() || null,
      },
    });
  });
  await recordAudit({
    actorId: userId,
    action: 'proposal.status',
    entity: 'ProposalVersion',
    entityId: versionId,
    details: { to, priceWarnings: warnings.length },
  });
  return { status: to, warnings, priceEntry };
}

export async function compareProposalVersions(proposalId: string, va: number, vb: number) {
  const [a, b] = await Promise.all([
    prisma.proposalVersion.findUnique({
      where: { proposalId_version: { proposalId, version: va } },
    }),
    prisma.proposalVersion.findUnique({
      where: { proposalId_version: { proposalId, version: vb } },
    }),
  ]);
  if (!a || !b) throw new NotFoundError('Version not found');
  const toSnap = (v: typeof a): VersionSnapshot => ({
    sections: v!.sections as unknown as ProposalSection[],
    items: v!.items as unknown as ProposalItem[],
    priceSnapshotId: v!.priceSnapshotId,
    expirationDate: v!.expirationDate ? v!.expirationDate.toISOString() : null,
  });
  return compareVersions(toSnap(a), toSnap(b));
}

export function validateContent(sections: unknown, items: unknown): void {
  if (!Array.isArray(sections) || !Array.isArray(items))
    throw new ValidationError('sections and items must be arrays');
}
