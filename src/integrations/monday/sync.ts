import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { env, isMondayConfigured } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { createItem, updateItem } from './client.js';
import { toColumnValues, STATUS_TO_STAGE, type SyncableOpportunity } from './mapping.js';
import { findLink, findByExternalId, upsertLink, markLinkState } from './links.js';
import { decideInbound } from './conflict.js';

const ENTITY = 'Opportunity';

/** Stable hash of the synced fields — used to suppress echo loops. */
export function syncHash(opp: SyncableOpportunity): string {
  const payload = JSON.stringify({
    name: opp.name, stage: opp.stage, fundingStatus: opp.fundingStatus,
    budget: opp.budgetAmountMinor?.toString() ?? null, currency: opp.budgetCurrency,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/** Push a local opportunity to monday. Idempotent + duplicate-safe via ExternalLink. */
export async function pushOpportunity(opportunityId: string): Promise<void> {
  if (!isMondayConfigured()) return;
  const opp = await prisma.opportunity.findUnique({ where: { id: opportunityId } });
  if (!opp) return;
  const ref = { entity: ENTITY, entityId: opp.id };
  const link = await findLink(ref);
  const hash = syncHash(opp);
  if (link && hash === link.lastSyncedHash) return; // unchanged — no write (breaks echo loop)

  try {
    const cols = toColumnValues(opp);
    const boardId = env.MONDAY_DEALS_BOARD_ID!;
    let externalId = link?.externalId;
    if (externalId) await updateItem(boardId, externalId, opp.name, cols);
    else externalId = await createItem(boardId, opp.name, cols);

    await upsertLink(ref, externalId, { boardId, hash, state: 'LINKED' });
    await prisma.integrationSyncLog.create({
      data: { direction: 'OUTBOUND', entity: ENTITY, entityId: opp.id, externalId, status: 'ok' },
    });
  } catch (err) {
    logger.error({ err, opportunityId }, 'monday push failed');
    await markLinkState(ref, 'ERROR');
    await prisma.integrationSyncLog.create({
      data: { direction: 'OUTBOUND', entity: ENTITY, entityId: opp.id, status: 'error', error: String(err) },
    });
  }
}

export interface MondayChange {
  eventId: string;
  itemId: string;
  columnId?: string;
  field?: string;           // logical field name, e.g. 'opportunity.stage'
  newStatusLabel?: string;
}

/**
 * Apply an inbound monday change. Idempotent (unique eventId) and conflict-safe:
 * a change to a CPQ-authoritative field is refused and logged, never applied.
 */
export async function applyInboundChange(change: MondayChange): Promise<'applied' | 'duplicate' | 'ignored' | 'conflict'> {
  try {
    await prisma.integrationSyncLog.create({
      data: { direction: 'INBOUND', entity: ENTITY, externalId: change.itemId, eventId: change.eventId, status: 'received' },
    });
  } catch {
    return 'duplicate'; // eventId already processed
  }

  const link = await findByExternalId(change.itemId);
  if (!link || link.entity !== ENTITY) return 'ignored';

  const field = change.field ?? 'opportunity.stage';
  const decision = decideInbound(field);
  if (!decision.allowed) {
    await markLinkState({ entity: link.entity, entityId: link.entityId }, 'CONFLICT');
    await prisma.integrationSyncLog.create({
      data: { direction: 'INBOUND', entity: ENTITY, entityId: link.entityId, externalId: change.itemId, status: 'conflict', error: decision.reason },
    });
    logger.warn({ field, reason: decision.reason }, 'inbound monday change refused (conflict)');
    return 'conflict';
  }

  const data: Record<string, unknown> = {};
  if (field === 'opportunity.stage' && change.newStatusLabel && STATUS_TO_STAGE[change.newStatusLabel]) {
    data.stage = STATUS_TO_STAGE[change.newStatusLabel];
  }
  if (Object.keys(data).length === 0) return 'ignored';

  const updated = await prisma.opportunity.update({ where: { id: link.entityId }, data });
  await upsertLink({ entity: ENTITY, entityId: link.entityId }, change.itemId, { hash: syncHash(updated), state: 'LINKED' });
  await prisma.integrationSyncLog.create({
    data: { direction: 'INBOUND', entity: ENTITY, entityId: link.entityId, externalId: change.itemId, status: 'ok' },
  });
  return 'applied';
}

/** Manual retry of a failed OUTBOUND sync log entry. */
export async function retrySync(logId: string): Promise<'retried' | 'notfound' | 'skipped'> {
  const log = await prisma.integrationSyncLog.findUnique({ where: { id: logId } });
  if (!log || !log.entityId) return 'notfound';
  if (log.direction !== 'OUTBOUND' || log.entity !== ENTITY) return 'skipped';
  await pushOpportunity(log.entityId);
  return 'retried';
}
