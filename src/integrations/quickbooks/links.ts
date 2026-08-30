import { prisma } from '../../lib/prisma.js';
import { qboEnvironment } from '../../config/env.js';
import type { SyncState, QboEnvironment } from '@prisma/client';

/**
 * QboEntityLink helpers — the duplicate-prevention backbone for Customers and
 * Items. The unique (environment, entity, entityId) constraint means a CPQ
 * record can only ever map to one QuickBooks object per environment, so
 * find-or-create never produces a second QuickBooks customer/item.
 *
 * There is a SECOND unique constraint, (environment, entity, qboId), enforcing
 * the reverse: one QuickBooks object is claimed by at most one CPQ record. That
 * is what stops two CPQ customers quietly sharing a QuickBooks customer. Bulk
 * SKU linking can collide with it legitimately (two CPQ parts carrying the same
 * part number resolve to the same QuickBooks item), so upsertLink reports the
 * collision rather than throwing — see the `conflict` result.
 */
export interface QboLinkRef {
  entity: string; // 'Customer' | 'Item'
  entityId: string; // CPQ id
}

function envValue(): QboEnvironment {
  return qboEnvironment() as QboEnvironment;
}

export async function findLink(ref: QboLinkRef) {
  return prisma.qboEntityLink.findUnique({
    where: {
      environment_entity_entityId: {
        environment: envValue(),
        entity: ref.entity,
        entityId: ref.entityId,
      },
    },
  });
}

/** Which CPQ record, if any, already claims this QuickBooks object. */
export async function findLinkByQboId(entity: string, qboId: string) {
  return prisma.qboEntityLink.findUnique({
    where: {
      environment_entity_qboId: { environment: envValue(), entity, qboId },
    },
  });
}

export async function upsertLink(
  ref: QboLinkRef,
  qboId: string,
  opts: { syncToken?: string | null; hash?: string; state?: SyncState } = {},
): Promise<{ created: boolean; conflict?: { claimedBy: string } }> {
  const existing = await findLink(ref);
  if (existing) {
    await prisma.qboEntityLink.update({
      where: { id: existing.id },
      data: {
        qboId,
        qboSyncToken: opts.syncToken ?? existing.qboSyncToken,
        lastSyncedHash: opts.hash ?? existing.lastSyncedHash,
        lastSyncedAt: new Date(),
        state: opts.state ?? 'LINKED',
      },
    });
    return { created: false };
  }
  try {
    await prisma.qboEntityLink.create({
      data: {
        environment: envValue(),
        entity: ref.entity,
        entityId: ref.entityId,
        qboId,
        qboSyncToken: opts.syncToken ?? null,
        lastSyncedHash: opts.hash ?? null,
        lastSyncedAt: new Date(),
        state: opts.state ?? 'LINKED',
      },
    });
    return { created: true };
  } catch (err) {
    // P2002 on (environment, entity, qboId): another CPQ record already claims
    // this QuickBooks object. Surface it to the caller instead of aborting a
    // bulk run — the collision is data to report, not a crash.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      const holder = await findLinkByQboId(ref.entity, qboId);
      return { created: false, conflict: { claimedBy: holder?.entityId ?? 'unknown' } };
    }
    throw err;
  }
}

export async function markLinkState(ref: QboLinkRef, state: SyncState): Promise<void> {
  const existing = await findLink(ref);
  if (existing) await prisma.qboEntityLink.update({ where: { id: existing.id }, data: { state } });
}
