import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { importDealById, importDealItems, type ImportResult } from './crmImport.js';
import { fetchItemsCreatedSince } from './discovery.js';
import { DEALS_BOARD_ID } from './crmMapping.js';

/**
 * New Deal Tracking rows appear in the CRM by themselves.
 *
 * Before this, a customer added to the Deal Tracking board existed in the CRM only
 * after somebody searched monday for it and pressed Import. Two mechanisms now do it
 * instead, both through the ONE importer in crmImport.ts — there is no second
 * mapping of the board to drift from the first:
 *
 *  1. A `create_item` webhook on the Deal Tracking board (declared in
 *     webhookRegistration.ts, so the nightly cron registers and repairs it) imports
 *     the new row as soon as it is added.
 *  2. A sweep in the nightly cron reads every row created since the last successful
 *     sweep, newest first, and imports those too. A webhook that never arrived — the
 *     deployment was down, the subscription was deleted in monday — costs at most a
 *     day, not a customer who silently never appears. It also picks up the columns a
 *     rep filled in after creating the row, which the create event cannot carry.
 *
 * Inbound only, like every CRM import: nothing here writes to monday, and nothing
 * here touches QuickBooks — a customer arriving from monday must not become a
 * QuickBooks customer; that happens only when a document is issued.
 *
 * Idempotent: the importer keys opportunities on `Opportunity.mondayItemId` (unique)
 * and adopts an existing organization by normalized name. The one thing that could
 * still duplicate is two imports of the SAME new row running at once — the create
 * webhook, a column-change retry and the sweep can overlap — each finding no
 * organization yet and creating one. `withDealLock` serializes imports per monday
 * item with a Postgres advisory lock, so the second waits and then adopts what the
 * first created.
 */

const SWEEP_ENTITY = 'monday-deal-sweep';
const IMPORT_ENTITY = 'monday-deal-import';
/** First sweep ever (no previous one recorded): look back this far. */
const FIRST_SWEEP_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
/** Re-read a little before the last sweep, so a row created mid-sweep is not lost. */
const SWEEP_OVERLAP_MS = 2 * 60 * 60 * 1000;

/** On unless MONDAY_DEAL_AUTO_IMPORT=false, and only with a monday token to read with. */
export function isDealAutoImportEnabled(): boolean {
  return Boolean(env.MONDAY_DEAL_AUTO_IMPORT && env.MONDAY_API_TOKEN);
}

/**
 * Run `fn` holding a per-item Postgres advisory lock.
 *
 * The lock is transaction-scoped (released at commit, including if the function
 * dies), so it is safe behind a pooled connection. `fn` itself does not run inside
 * the transaction — the transaction exists only to hold the lock while the
 * importer does its ordinary writes.
 */
export async function withDealLock<T>(itemId: string, fn: () => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`monday-deal:${itemId}`}))`;
      return fn();
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

export interface DealImportOutcome {
  itemId: string;
  result: 'created' | 'updated' | 'notfound' | 'skipped';
  organizationId: string | null;
  opportunityId: string | null;
  warnings: string[];
}

function outcomeOf(r: ImportResult): DealImportOutcome['result'] {
  if (r.deals.created > 0) return 'created';
  if (r.deals.updated > 0) return 'updated';
  if (r.warnings.some((w) => w.includes('not found'))) return 'notfound';
  return 'skipped';
}

async function linkedOpportunity(itemId: string) {
  return prisma.opportunity.findUnique({
    where: { mondayItemId: itemId },
    select: { id: true, organizationId: true },
  });
}

/**
 * Import one Deal Tracking row by monday item id, under the per-item lock.
 * Used by the create webhook and by the New proposal customer picker.
 */
export async function importDealNow(
  itemId: string,
  source: 'webhook' | 'picker',
): Promise<DealImportOutcome> {
  const r = await withDealLock(itemId, () => importDealById(itemId, false));
  const opp = await linkedOpportunity(itemId);
  const out: DealImportOutcome = {
    itemId,
    result: outcomeOf(r),
    organizationId: opp?.organizationId ?? null,
    opportunityId: opp?.id ?? null,
    warnings: r.warnings,
  };
  if (out.result === 'created') {
    await prisma.integrationSyncLog
      .create({
        data: {
          provider: 'monday',
          direction: 'INBOUND',
          entity: IMPORT_ENTITY,
          entityId: out.opportunityId,
          externalId: itemId,
          status: 'ok',
          error: source,
        },
      })
      .catch((err: unknown) => logger.warn({ err, itemId }, 'could not log monday deal import'));
  }
  logger.info({ itemId, source, result: out.result }, 'monday deal imported');
  return out;
}

export interface DealSweepResult {
  ranAt: string;
  skipped?: string;
  since?: string;
  seen: number;
  created: number;
  updated: number;
  failed: Array<{ itemId: string; error: string }>;
  complete: boolean;
  error?: string;
}

/**
 * Import every Deal Tracking row created since the last successful sweep.
 *
 * Never throws: monday unreachable is reported in the result and recorded as a
 * failed sweep, and because the window starts at the last SUCCESSFUL sweep the next
 * run covers the gap by itself.
 */
export async function sweepNewDeals(
  opts: { max?: number; budgetMs?: number; now?: Date } = {},
): Promise<DealSweepResult> {
  const now = opts.now ?? new Date();
  const max = opts.max ?? 100;
  const deadline = Date.now() + (opts.budgetMs ?? 120_000);
  const out: DealSweepResult = {
    ranAt: now.toISOString(),
    seen: 0,
    created: 0,
    updated: 0,
    failed: [],
    complete: false,
  };
  if (!isDealAutoImportEnabled()) {
    out.skipped = env.MONDAY_API_TOKEN
      ? 'MONDAY_DEAL_AUTO_IMPORT is false'
      : 'MONDAY_API_TOKEN is not set';
    return out;
  }

  const last = await prisma.integrationSyncLog.findFirst({
    where: { entity: SWEEP_ENTITY, status: 'ok' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const since = last
    ? new Date(last.createdAt.getTime() - SWEEP_OVERLAP_MS)
    : new Date(now.getTime() - FIRST_SWEEP_LOOKBACK_MS);
  out.since = since.toISOString();

  try {
    const items = await fetchItemsCreatedSince(DEALS_BOARD_ID, since, max);
    out.seen = items.length;
    let stoppedEarly = items.length >= max;
    for (const item of items) {
      if (Date.now() > deadline) {
        stoppedEarly = true;
        break;
      }
      try {
        const r = await withDealLock(item.id, () => importDealItems([item], false));
        out.created += r.deals.created;
        out.updated += r.deals.updated;
      } catch (err) {
        out.failed.push({ itemId: item.id, error: String(err) });
        logger.warn({ err, itemId: item.id }, 'monday deal sweep: import failed');
      }
    }
    // A sweep that stopped early or lost a row is not a new high-water mark: the next
    // one starts from the last complete sweep and reads those rows again.
    out.complete = !stoppedEarly && out.failed.length === 0;
  } catch (err) {
    out.error = String(err);
    logger.error({ err }, 'monday deal sweep: could not read the Deal Tracking board');
  }

  await prisma.integrationSyncLog
    .create({
      data: {
        provider: 'monday',
        direction: 'INBOUND',
        entity: SWEEP_ENTITY,
        status: out.error ? 'error' : out.complete ? 'ok' : 'partial',
        error:
          out.error ?? (out.failed.length ? `${out.failed.length} row(s) failed to import` : null),
        eventId: `${SWEEP_ENTITY}:${now.toISOString()}`,
        createdAt: now,
      },
    })
    .catch((err: unknown) => logger.warn({ err }, 'could not record monday deal sweep'));

  logger.info({ ...out, failed: out.failed.length }, 'monday deal sweep finished');
  return out;
}
