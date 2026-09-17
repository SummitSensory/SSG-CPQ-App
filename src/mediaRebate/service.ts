import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { metaOf } from '../proposals/analytics.js';
import { DEFAULT_MEDIA_PROGRAM_CONTENT, type MediaProgramContent } from './defaults.js';

/**
 * Reading, publishing and freezing the Customer Project Media Rebate program.
 *
 * Same discipline as `src/legal/service.ts`, applied to the rebate's terms: a price is
 * frozen onto the version as `priceSnapshotId`, the legal text as `legalSnapshotId`,
 * and now the rebate's terms as `ProposalVersion.mediaRebateSnapshotId`.
 *
 * Deliberately mirrors the legal-document render behavior too: a proposal being built
 * or previewed always shows the CURRENT program (`currentMediaProgram`), the same way
 * `public/contract-pages.js` always fetches `/legal-documents/effective` rather than a
 * pinned snapshot. The snapshot frozen at release exists as the audit-truth answer to
 * "what did this version actually offer" (`mediaRebateForVersion`), and the real
 * immutability guarantee for anything a customer has actually signed comes from the
 * existing e-sign flow, which bakes whatever HTML was on screen at send time into a
 * hashed, stored PDF (`EsignEnvelope.packageUrl`) that is never re-rendered.
 *
 * Snapshots are content-addressed by SHA-256, same as `LegalSnapshot` — releasing many
 * proposals under one wording writes one row and many references.
 */

export interface ResolvedMediaProgram {
  active: boolean;
  customerFacingName: string;
  internalName: string;
  rebateAmountMinor: number;
  content: MediaProgramContent;
  /** Which published version this is. 0 means the shipped default, never saved. */
  version: number;
}

const DEFAULT_PROGRAM: ResolvedMediaProgram = {
  active: false,
  customerFacingName: 'Customer Project Media Rebate',
  internalName: 'Media Partnership Program',
  rebateAmountMinor: 25000,
  content: DEFAULT_MEDIA_PROGRAM_CONTENT,
  version: 0,
};

/**
 * The Media Partnership Program as it stands right now.
 *
 * A missing row (fresh environment, or a database predating this feature) falls back
 * to the shipped defaults with `active: false` — never enabled by default, per spec.
 */
export async function currentMediaProgram(
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<ResolvedMediaProgram> {
  const row = await client.mediaPartnershipProgram.findUnique({ where: { key: 'default' } });
  if (!row) return DEFAULT_PROGRAM;
  return {
    active: row.active,
    customerFacingName: row.customerFacingName,
    internalName: row.internalName,
    rebateAmountMinor: row.rebateAmountMinor,
    content: row.content as unknown as MediaProgramContent,
    version: row.version,
  };
}

/**
 * Freeze the current program terms and return the snapshot id.
 *
 * Called inside the release transaction (`src/proposals/service.ts` `changeStatus`),
 * so a release that rolls back leaves no orphan snapshot, and only when the version
 * being released actually offered the program — most proposals never touch this
 * feature and should never gain a snapshot row.
 */
export async function snapshotMediaRebateProgram(
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<string> {
  const program = await currentMediaProgram(client);
  const payload = {
    customerFacingName: program.customerFacingName,
    internalName: program.internalName,
    rebateAmountMinor: program.rebateAmountMinor,
    content: program.content,
    version: program.version,
  };

  const json = JSON.stringify(payload);
  const hash = createHash('sha256').update(json).digest('hex');

  const existing = await client.mediaRebateSnapshot.findUnique({
    where: { hash },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await client.mediaRebateSnapshot.create({
    data: { hash, payload: payload as unknown as Prisma.InputJsonValue },
    select: { id: true },
  });
  return created.id;
}

export interface MediaRebateForVersion {
  /** Whether this version's Media Program answer is a frozen snapshot or live settings. */
  pinned: boolean;
  offered: boolean;
  participate: boolean;
  participationAt: string | null;
  program: ResolvedMediaProgram | null;
}

/**
 * What a given proposal version's Media Program says: offered/participate/timestamp
 * always come from that version's own stored meta (immutable once the version is
 * frozen, like every other field on a released version), and the program terms
 * themselves come from the pinned snapshot when there is one, or the live program when
 * there is not (an unreleased draft, or a version that never offered the program).
 */
export async function mediaRebateForVersion(versionId: string): Promise<MediaRebateForVersion> {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: { sections: true, mediaRebateSnapshotId: true },
  });
  if (!version) {
    return {
      pinned: false,
      offered: false,
      participate: false,
      participationAt: null,
      program: null,
    };
  }

  const meta = metaOf(version.sections);
  const offered = !!meta.mediaRebate?.offered;
  const participate = !!meta.mediaRebate?.participate;
  const participationAt = meta.mediaRebate?.participationAt ?? null;

  if (!offered) {
    return {
      pinned: false,
      offered: false,
      participate: false,
      participationAt: null,
      program: null,
    };
  }

  if (version.mediaRebateSnapshotId) {
    const snap = await prisma.mediaRebateSnapshot.findUnique({
      where: { id: version.mediaRebateSnapshotId },
      select: { payload: true },
    });
    if (snap) {
      const payload = snap.payload as unknown as Omit<ResolvedMediaProgram, 'active'>;
      return {
        pinned: true,
        offered,
        participate,
        participationAt,
        program: { ...payload, active: true },
      };
    }
  }

  return {
    pinned: false,
    offered,
    participate,
    participationAt,
    program: await currentMediaProgram(),
  };
}
