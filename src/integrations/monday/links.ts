import { prisma } from '../../lib/prisma.js';
import type { SyncState } from '@prisma/client';

const PROVIDER = 'monday';

export interface LinkRef {
  entity: string;
  entityId: string;
}

/** Find the monday external id for a CPQ entity, if linked. */
export async function findLink(ref: LinkRef) {
  return prisma.externalLink.findUnique({
    where: { provider_entity_entityId: { provider: PROVIDER, entity: ref.entity, entityId: ref.entityId } },
  });
}

/** Find the CPQ entity for a monday external id, if linked. */
export async function findByExternalId(externalId: string) {
  return prisma.externalLink.findUnique({ where: { provider_externalId: { provider: PROVIDER, externalId } } });
}

/**
 * Upsert a link. Returns { created } so the caller can prevent duplicate
 * monday items — if a link already exists we never create a second item.
 */
export async function upsertLink(
  ref: LinkRef,
  externalId: string,
  opts: { boardId?: string; hash?: string; state?: SyncState } = {},
): Promise<{ created: boolean }> {
  const existing = await findLink(ref);
  if (existing) {
    await prisma.externalLink.update({
      where: { id: existing.id },
      data: {
        externalId,
        boardId: opts.boardId ?? existing.boardId,
        lastSyncedHash: opts.hash ?? existing.lastSyncedHash,
        lastSyncedAt: new Date(),
        state: opts.state ?? 'LINKED',
      },
    });
    return { created: false };
  }
  await prisma.externalLink.create({
    data: {
      provider: PROVIDER, entity: ref.entity, entityId: ref.entityId, externalId,
      boardId: opts.boardId ?? null, lastSyncedHash: opts.hash ?? null,
      lastSyncedAt: new Date(), state: opts.state ?? 'LINKED',
    },
  });
  return { created: true };
}

export async function markLinkState(ref: LinkRef, state: SyncState): Promise<void> {
  const existing = await findLink(ref);
  if (existing) await prisma.externalLink.update({ where: { id: existing.id }, data: { state } });
}
