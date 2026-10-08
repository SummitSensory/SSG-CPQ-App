import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { env, isMondayPushConfigured } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { createItem, updateItem } from './client.js';
import type { OpportunityStage } from '@prisma/client';
import { toColumnValues, STATUS_TO_STAGE, COLUMN, type SyncableOpportunity } from './mapping.js';
import { toStage } from './crmMapping.js';
import { findLink, findByExternalId, upsertLink, markLinkState } from './links.js';
import { decideInbound } from './conflict.js';

const ENTITY = 'Opportunity';

/** Stable hash of the synced fields — used to suppress echo loops. */
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

/** Push a local opportunity to monday. Idempotent + duplicate-safe via ExternalLink. */
export async function pushOpportunity(opportunityId: string): Promise<void> {
  if (!isMondayPushConfigured()) return;
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
      data: {
        direction: 'OUTBOUND',
        entity: ENTITY,
        entityId: opp.id,
        status: 'error',
        error: String(err),
      },
    });
  }
}

/**
 * The CRM stage a monday Deal Phase label means, for the live webhook.
 *
 * The exact label we write outbound (STAGE_TO_STATUS) wins. Anything else goes
 * through the same tolerant `toStage` the CRM importer uses, so a deal moved to
 * "Closed Won" on the board lands as CLOSED_WON whether it arrived by import or by
 * webhook. One exception: `toStage` answers PROSPECT for a label it does not
 * recognise at all, and a live event must never demote a real deal because
 * someone added an unfamiliar label — an unrecognised label is ignored.
 */
export function inboundStage(label: string | undefined): OpportunityStage | undefined {
  if (!label) return undefined;
  const exact = STATUS_TO_STAGE[label];
  if (exact) return exact;
  const fuzzy = toStage(label);
  if (fuzzy === 'PROSPECT' && !/prospect|lead/i.test(label)) return undefined;
  return fuzzy;
}

/**
 * The dedupe key for an inbound webhook event.
 *
 * monday's `triggerUuid` when it sends one. Without it the key used to be
 * `${pulseId}-${columnId}-${Date.now()}`, which is unique per DELIVERY — so a
 * redelivered event was never recognised as a duplicate. The fallback is now a hash
 * of the event's own content (item, column, old and new value, and monday's own
 * trigger/change time), identical on every redelivery of the same event.
 */
export function mondayEventId(ev: Record<string, unknown>): string {
  const uuid = ev.triggerUuid;
  if (typeof uuid === 'string' && uuid) return uuid;
  const material = JSON.stringify([
    ev.boardId ?? null,
    ev.pulseId ?? null,
    ev.columnId ?? null,
    ev.value ?? null,
    ev.previousValue ?? null,
    ev.triggerTime ?? null,
    ev.changedAt ?? null,
  ]);
  return `synth:${createHash('sha256').update(material).digest('hex').slice(0, 40)}`;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

export interface MondayChange {
  eventId: string;
  itemId: string;
  columnId?: string;
  field?: string; // logical field name, e.g. 'opportunity.stage'
  newStatusLabel?: string;
}

/**
 * Apply an inbound monday change. Idempotent (unique eventId) and conflict-safe:
 * a change to a CPQ-authoritative field is refused and logged, never applied.
 */
export async function applyInboundChange(
  change: MondayChange,
): Promise<'applied' | 'duplicate' | 'ignored' | 'conflict'> {
  try {
    await prisma.integrationSyncLog.create({
      data: {
        direction: 'INBOUND',
        entity: ENTITY,
        externalId: change.itemId,
        eventId: change.eventId,
        status: 'received',
      },
    });
  } catch (err) {
    // Only a unique violation on eventId means "already processed". Any other
    // failure (the database unreachable) must surface, so monday retries.
    if (isUniqueViolation(err)) return 'duplicate';
    throw err;
  }

  try {
    return await applyClaimed(change);
  } catch (err) {
    /*
     * Release the claim. The webhook answers 500, monday redelivers with the SAME
     * triggerUuid, and without this the retry was answered 'duplicate' — the stage
     * change was lost for good. Releasing makes the failed event retryable; if the
     * release itself fails the original error still propagates.
     */
    await prisma.integrationSyncLog
      .deleteMany({ where: { eventId: change.eventId, status: 'received' } })
      .catch((releaseErr: unknown) =>
        logger.error(
          { err: releaseErr, eventId: change.eventId },
          'monday inbound: could not release the claim on a failed event',
        ),
      );
    throw err;
  }
}

async function applyClaimed(change: MondayChange): Promise<'applied' | 'ignored' | 'conflict'> {
  const link = await findByExternalId(change.itemId);
  if (!link || link.entity !== ENTITY) return 'ignored';

  // `field` must be derived from which column the event actually names, not assumed —
  // this used to default to 'opportunity.stage' unconditionally whenever a caller
  // didn't pass `field` explicitly (the only caller, the webhook route, never does),
  // so ANY column change on a linked deal item — the amount, the owner, an unrelated
  // note — was evaluated as if it might be a stage change. A change to a genuinely
  // CPQ-authoritative column (amount, owner, close date) must be refused and logged
  // as a conflict per docs/MONDAY-INTEGRATION.md, not silently ignored because its
  // columnId happened not to match — but only the stage column's id is verified
  // here, so an unrecognized column is treated as not-synced (ignored) rather than
  // guessed at.
  const field =
    change.field ?? (change.columnId === COLUMN.stage ? 'opportunity.stage' : undefined);
  if (!field) return 'ignored';
  const decision = decideInbound(field);
  if (!decision.allowed) {
    await markLinkState({ entity: link.entity, entityId: link.entityId }, 'CONFLICT');
    await prisma.integrationSyncLog.create({
      data: {
        direction: 'INBOUND',
        entity: ENTITY,
        entityId: link.entityId,
        externalId: change.itemId,
        status: 'conflict',
        error: decision.reason,
      },
    });
    logger.warn({ field, reason: decision.reason }, 'inbound monday change refused (conflict)');
    return 'conflict';
  }

  const data: Record<string, unknown> = {};
  const stage = field === 'opportunity.stage' ? inboundStage(change.newStatusLabel) : undefined;
  if (stage) data.stage = stage;
  if (Object.keys(data).length === 0) return 'ignored';

  const updated = await prisma.opportunity.update({ where: { id: link.entityId }, data });
  await upsertLink({ entity: ENTITY, entityId: link.entityId }, change.itemId, {
    hash: syncHash(updated),
    state: 'LINKED',
  });
  await prisma.integrationSyncLog.create({
    data: {
      direction: 'INBOUND',
      entity: ENTITY,
      entityId: link.entityId,
      externalId: change.itemId,
      status: 'ok',
    },
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
