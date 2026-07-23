import { prisma } from '../../lib/prisma.js';
import { qboEnvironment } from '../../config/env.js';
import type { SyncState, QboEnvironment } from '@prisma/client';

/**
 * QboEntityLink helpers — the duplicate-prevention backbone for Customers and
 * Items. The unique (environment, entity, entityId) constraint means a CPQ
 * record can only ever map to one QuickBooks object per environment, so
 * find-or-create never produces a second QuickBooks customer/item.
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
    where: { environment_entity_entityId: { environment: envValue(), entity: ref.entity, entityId: ref.entityId } },
  });
}

export async function upsertLink(
  ref: QboLinkRef,
  qboId: string,
  opts: { syncToken?: string | null; hash?: string; state?: SyncState } = {},
): Promise<{ created: boolean }> {
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
  await prisma.qboEntityLink.create({
    data: {
      environment: envValue(), entity: ref.entity, entityId: ref.entityId, qboId,
      qboSyncToken: opts.syncToken ?? null, lastSyncedHash: opts.hash ?? null,
      lastSyncedAt: new Date(), state: opts.state ?? 'LINKED',
    },
  });
  return { created: true };
}

export async function markLinkState(ref: QboLinkRef, state: SyncState): Promise<void> {
  const existing = await findLink(ref);
  if (existing) await prisma.qboEntityLink.update({ where: { id: existing.id }, data: { state } });
}
