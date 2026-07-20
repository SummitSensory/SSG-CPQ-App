import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { env, isMondayConfigured } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { createItem, updateItem } from './client.js';
import { toColumnValues, STATUS_TO_STAGE, type SyncableOpportunity } from './mapping.js';

/** Stable hash of the synced fields — used to suppress echo loops in two-way sync. */
export function syncHash(opp: SyncableOpportunity): string {
  const payload = JSON.stringify({
    name: opp.name,
    stage: opp.stage,
    fundingStatus: opp.fundingStatus,
    budget: opp.budgetAmountMinor?.toString() ?? null,
    currency: opp.budgetCurrency,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/** Push a local opportunity to monday. No-op if the outgoing state is unchanged. */
export async function pushOpportunity(opportunityId: string): Promise<void> {
  if (!isMondayConfigured()) return;
  const opp = await prisma.opportunity.findUnique({ where: { id: opportunityId } });
  if (!opp) return;
  const hash = syncHash(opp);
  if (hash === opp.mondaySyncHash) return; // nothing changed since last sync (breaks echo loop)

  try {
    const cols = toColumnValues(opp);
    const boardId = env.MONDAY_DEALS_BOARD_ID!;
    let itemId = opp.mondayItemId;
    if (itemId) await updateItem(boardId, itemId, opp.name, cols);
    else itemId = await createItem(boardId, opp.name, cols);

    await prisma.opportunity.update({
      where: { id: opp.id },
      data: { mondayItemId: itemId, mondaySyncHash: hash, mondaySyncedAt: new Date() },
    });
    await prisma.integrationSyncLog.create({
      data: { direction: 'OUTBOUND', entity: 'Opportunity', entityId: opp.id, externalId: itemId, status: 'ok' },
    });
  } catch (err) {
    logger.error({ err, opportunityId }, 'monday push failed');
    await prisma.integrationSyncLog.create({
      data: { direction: 'OUTBOUND', entity: 'Opportunity', entityId: opp.id, status: 'error', error: String(err) },
    });
  }
}

export interface MondayChange {
  eventId: string;
  itemId: string;
  columnId?: string;
  newStatusLabel?: string;
}

/** Apply an inbound monday change to the local opportunity, idempotently. */
export async function applyInboundChange(change: MondayChange): Promise<'applied' | 'duplicate' | 'ignored'> {
  // Idempotency: unique eventId guards against redelivery.
  try {
    await prisma.integrationSyncLog.create({
      data: { direction: 'INBOUND', entity: 'Opportunity', externalId: change.itemId, eventId: change.eventId, status: 'received' },
    });
  } catch {
    return 'duplicate';
  }

  const opp = await prisma.opportunity.findUnique({ where: { mondayItemId: change.itemId } });
  if (!opp) return 'ignored';

  const data: Record<string, unknown> = {};
  if (change.newStatusLabel && STATUS_TO_STAGE[change.newStatusLabel]) {
    data.stage = STATUS_TO_STAGE[change.newStatusLabel];
  }
  if (Object.keys(data).length === 0) return 'ignored';

  const updated = await prisma.opportunity.update({ where: { id: opp.id }, data });
  // Record the post-inbound hash so our own push doesn't echo this change back.
  await prisma.opportunity.update({
    where: { id: opp.id },
    data: { mondaySyncHash: syncHash(updated), mondaySyncedAt: new Date() },
  });
  return 'applied';
}
