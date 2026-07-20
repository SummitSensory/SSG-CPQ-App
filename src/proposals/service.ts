import { prisma } from '../lib/prisma.js';
import { ConflictError, ValidationError, NotFoundError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { canTransition, becomesFrozen, isFrozenStatus, formatProposalNumber } from './status.js';
import { compareVersions, type VersionSnapshot } from './compare.js';
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
  input: { organizationId: string; title: string } & VersionContent,
  userId: string,
): Promise<{ id: string; number: string }> {
  const number = await nextNumber();
  const proposal = await prisma.$transaction(async (tx) => {
    const p = await tx.proposal.create({
      data: { number, organizationId: input.organizationId, title: input.title, currentVersion: 1, createdById: userId },
    });
    const v = await tx.proposalVersion.create({
      data: {
        proposalId: p.id, version: 1, status: 'DRAFT',
        sections: input.sections as object, items: input.items as object,
        priceSnapshotId: input.priceSnapshotId ?? null, ruleSnapshotId: input.ruleSnapshotId ?? null,
        expirationDate: input.expirationDate ?? null, createdById: userId,
      },
    });
    await tx.proposalStatusEvent.create({ data: { versionId: v.id, toStatus: 'DRAFT', changedById: userId, note: 'created' } });
    return p;
  });
  await recordAudit({ actorId: userId, action: 'proposal.create', entity: 'Proposal', entityId: proposal.id });
  return { id: proposal.id, number };
}

/** Edit a version's content. Refused if the version is frozen (released or later). */
export async function updateVersionContent(versionId: string, content: Partial<VersionContent>, userId: string): Promise<void> {
  const version = await prisma.proposalVersion.findUnique({ where: { id: versionId } });
  if (!version) throw new NotFoundError('Version not found');
  if (version.frozen || isFrozenStatus(version.status)) {
    throw new ConflictError('Released proposal versions are immutable. Create a new version to make changes.');
  }
  await prisma.proposalVersion.update({
    where: { id: versionId },
    data: {
      ...(content.sections ? { sections: content.sections as object } : {}),
      ...(content.items ? { items: content.items as object } : {}),
      ...(content.priceSnapshotId !== undefined ? { priceSnapshotId: content.priceSnapshotId } : {}),
      ...(content.ruleSnapshotId !== undefined ? { ruleSnapshotId: content.ruleSnapshotId } : {}),
      ...(content.expirationDate !== undefined ? { expirationDate: content.expirationDate } : {}),
    },
  });
  await recordAudit({ actorId: userId, action: 'proposal.version.update', entity: 'ProposalVersion', entityId: versionId });
}

/** Create a new editable DRAFT version by cloning the current one (the only way to change a released proposal). */
export async function createNewVersion(proposalId: string, userId: string): Promise<{ version: number; versionId: string }> {
  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({ where: { id: proposalId } });
    if (!proposal) throw new NotFoundError('Proposal not found');
    const current = await tx.proposalVersion.findUnique({ where: { proposalId_version: { proposalId, version: proposal.currentVersion } } });
    if (!current) throw new NotFoundError('Current version not found');

    const nextVersion = proposal.currentVersion + 1;
    const created = await tx.proposalVersion.create({
      data: {
        proposalId, version: nextVersion, status: 'DRAFT',
        sections: current.sections as object, items: current.items as object,
        priceSnapshotId: current.priceSnapshotId, ruleSnapshotId: current.ruleSnapshotId,
        expirationDate: current.expirationDate, createdById: userId,
      },
    });
    await tx.proposal.update({ where: { id: proposalId }, data: { currentVersion: nextVersion } });
    await tx.proposalStatusEvent.create({ data: { versionId: created.id, toStatus: 'DRAFT', changedById: userId, note: `cloned from v${current.version}` } });
    await recordAudit({ actorId: userId, action: 'proposal.version.create', entity: 'ProposalVersion', entityId: created.id, details: { version: nextVersion } });
    return { version: nextVersion, versionId: created.id };
  });
}

export async function changeStatus(versionId: string, to: ProposalStatus, userId: string, note?: string): Promise<void> {
  const version = await prisma.proposalVersion.findUnique({ where: { id: versionId } });
  if (!version) throw new NotFoundError('Version not found');
  if (!canTransition(version.status, to)) throw new ConflictError(`Illegal transition ${version.status} -> ${to}`);

  await prisma.$transaction(async (tx) => {
    await tx.proposalVersion.update({
      where: { id: versionId },
      data: {
        status: to,
        ...(becomesFrozen(to) ? { frozen: true, releasedAt: new Date(), releasedById: userId } : {}),
      },
    });
    await tx.proposalStatusEvent.create({ data: { versionId, fromStatus: version.status, toStatus: to, changedById: userId, note: note ?? null } });
  });
  await recordAudit({ actorId: userId, action: 'proposal.status', entity: 'ProposalVersion', entityId: versionId, details: { to } });
}

export async function compareProposalVersions(proposalId: string, va: number, vb: number) {
  const [a, b] = await Promise.all([
    prisma.proposalVersion.findUnique({ where: { proposalId_version: { proposalId, version: va } } }),
    prisma.proposalVersion.findUnique({ where: { proposalId_version: { proposalId, version: vb } } }),
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
  if (!Array.isArray(sections) || !Array.isArray(items)) throw new ValidationError('sections and items must be arrays');
}
