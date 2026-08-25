import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { versionTotals } from './analytics.js';
import { snapshotAcceptedContent } from '../handoff/service.js';
import {
  buildContentSnapshot,
  computeIntegrityHash,
  depositFromSnapshot,
} from '../handoff/lock.js';

/**
 * Re-freezing the accepted price of a version whose frozen total no longer matches
 * its own lines.
 *
 * A PriceSnapshot is the total of a particular set of lines at a particular moment,
 * and everything downstream — the accepted order, the deposit, the QuickBooks push —
 * is asserted against it. When the two disagree the push refuses, which is correct:
 * an app that quietly re-freezes a price so an invoice balances is worse than one
 * that stops.
 *
 * What was missing was a way to say "the lines are right, the frozen figure is the
 * stale one" and have the system agree. Without it a drifted version was terminal —
 * the advice was to make a new version, and until now a new version inherited the
 * same stale snapshot, so it drifted identically.
 *
 * This is that decision, made explicitly by someone who can release a proposal, with
 * both figures recorded. It does not touch the lines. It restates the frozen price as
 * what the version actually says, and carries that through to the accepted order's
 * total, deposit, content snapshot and integrity hash, so nothing downstream is left
 * describing the old figure.
 */

export interface PriceDrift {
  versionId: string;
  /** The total frozen against this version, or null if it has never been frozen. */
  frozenMinor: number | null;
  /** What the version's own lines come to now. */
  liveMinor: number;
  /** frozen - live. Positive means the frozen price is the higher of the two. */
  driftMinor: number;
  drifted: boolean;
  status: string;
  /** Whether an accepted order exists, and therefore whether a push is in play. */
  hasOrder: boolean;
}

async function loadVersion(versionId: string) {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      version: true,
      proposalId: true,
      status: true,
      frozen: true,
      sections: true,
      items: true,
      priceSnapshotId: true,
    },
  });
  if (!version) throw new NotFoundError('Proposal version not found');
  return version;
}

/** Report the gap without changing anything. */
export async function priceDrift(versionId: string): Promise<PriceDrift> {
  const version = await loadVersion(versionId);
  const snap = version.priceSnapshotId
    ? await prisma.priceSnapshot.findUnique({
        where: { id: version.priceSnapshotId },
        select: { grandTotal: true },
      })
    : null;
  const live = Math.round(versionTotals(version.items, version.sections).total);
  const frozen = snap ? Number(snap.grandTotal) : null;
  const order = await prisma.acceptedOrder.findUnique({
    where: { proposalVersionId: versionId },
    select: { id: true },
  });
  return {
    versionId,
    frozenMinor: frozen,
    liveMinor: live,
    driftMinor: frozen == null ? 0 : frozen - live,
    drifted: frozen != null && frozen !== live,
    status: version.status,
    hasOrder: !!order,
  };
}

export interface RefreezeResult {
  versionId: string;
  fromMinor: number | null;
  toMinor: number;
  orderUpdated: boolean;
}

/**
 * Restate the frozen price as the version's own content.
 *
 * Refuses on a version that has not been accepted: before acceptance the release path
 * already freezes the right figure, and re-freezing a draft would be changing a price
 * nobody has agreed to yet.
 */
export async function refreezeAcceptedPrice(
  versionId: string,
  actorId: string,
): Promise<RefreezeResult> {
  const version = await loadVersion(versionId);
  if (version.status !== 'ACCEPTED') {
    throw new ValidationError(
      'Only an accepted version can have its price re-frozen. A draft or released version ' +
        'freezes its own total when it is released.',
    );
  }

  const drift = await priceDrift(versionId);
  if (!drift.drifted) {
    throw new ValidationError(
      'The frozen price already matches this version\u2019s lines, so there is nothing to re-freeze.',
    );
  }

  // The same function the acceptance and freight paths use, so the snapshot shape, the
  // deposit percentage and the balance are computed exactly one way.
  const snapshot = await snapshotAcceptedContent(
    version.id,
    version.sections,
    version.items,
    actorId,
  );
  const order = await prisma.acceptedOrder.findUnique({
    where: { proposalVersionId: version.id },
  });

  await prisma.$transaction(async (tx) => {
    await tx.proposalVersion.update({
      where: { id: version.id },
      data: { priceSnapshotId: snapshot.id },
    });

    if (order) {
      // The order carries its own copy of the totals and a hash over them. Leaving
      // those behind would move the disagreement rather than settle it.
      const content = buildContentSnapshot(
        {
          id: version.id,
          version: version.version,
          proposalId: version.proposalId,
          sections: version.sections,
          items: version.items,
          priceSnapshotId: snapshot.id,
          status: version.status,
          frozen: version.frozen,
        },
        snapshot,
      );
      const deposit = depositFromSnapshot(snapshot);
      await tx.acceptedOrder.update({
        where: { id: order.id },
        data: {
          priceSnapshotId: snapshot.id,
          grandTotalMinor: snapshot.grandTotal,
          depositDueMinor: deposit,
          depositRequired: deposit > 0n,
          contentSnapshot: content as unknown as Prisma.InputJsonValue,
          integrityHash: computeIntegrityHash(content),
        },
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          action: 'price.refrozen',
          actorId,
          detail: {
            fromMinor: drift.frozenMinor,
            toMinor: drift.liveMinor,
            reason: 'The frozen accepted total did not match the version\u2019s own lines',
          },
        },
      });
    }
  });

  await recordAudit({
    actorId,
    action: 'proposal.price.refrozen',
    entity: 'ProposalVersion',
    entityId: version.id,
    details: { fromMinor: drift.frozenMinor, toMinor: drift.liveMinor, orderUpdated: !!order },
  });

  return {
    versionId: version.id,
    fromMinor: drift.frozenMinor,
    toMinor: drift.liveMinor,
    orderUpdated: !!order,
  };
}
