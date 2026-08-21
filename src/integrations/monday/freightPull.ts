import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import { ValidationError } from '../../lib/errors.js';
import { env, isMondayPushConfigured } from '../../config/env.js';
import { mondayQuery } from './client.js';
import { DEAL_COL } from './crmMapping.js';
import type { FreightEntry } from '@prisma/client';

/**
 * Steel and mats freight, read off the monday deal board.
 *
 * Both figures are quoted on the deal row by the people who arrange the trucks —
 * the steel structure ships on one, the padding on another — so the board is the
 * source and this application is the reader. Nobody at Summit should be retyping a
 * number that already exists in the system that produced it, and a retyped number
 * is a number that can disagree with the board.
 *
 * Read three ways, because a freight figure that arrives late is the whole problem
 * this feature exists to solve:
 *
 *   1. when the freight panel opens, plus a Refresh button (`syncVersion`);
 *   2. nightly, for every job still outstanding (`pullOutstanding`) — the case
 *      where the column was filled in on a Saturday and nobody opened the screen;
 *   3. on the board's own change webhook (`handleBoardChange`), which is the fast
 *      path and, being a webhook, the one that cannot be relied on alone.
 *
 * All three converge on the same upsert, so a figure that arrives twice does not
 * become two shipments. What none of them will do is move a figure that has already
 * been applied to the proposal or pushed to an invoice: past that point a changed
 * board value is a correction with money consequences, and it is raised for a person
 * to deal with rather than written silently.
 */

/**
 * The columns holding each figure.
 *
 * Two ids per bucket because the board holds each one twice: a formula column that
 * the freight desk reads and a lookup/text column that the BOM already uses. The
 * formula column is preferred — it is the one the desk maintains — and the other is
 * the fallback, so a board where only one is populated still works. Both are read
 * in a single query; there is no second round trip for the fallback.
 */
const COLUMNS = {
  STEEL: { primary: 'formula_mky8s42a', fallback: DEAL_COL.structureFreight },
  MATS: { primary: 'formula_mkzd3p9s', fallback: DEAL_COL.matsFreight },
} as const;

/**
 * The mats freight TAX column.
 *
 * Read and reported, never written to a bucket. It is tax the carrier charged, it
 * belongs to the signed document's tax line, and a freight true-up may not move tax
 * (see assertFreightOnlyChange). Surfacing it stops the figure from being invisible
 * — somebody has to decide what to do about it — without letting this path decide.
 */
const MATS_TAX_COLUMN = 'formula_mkzde17n';

export interface BoardFreight {
  itemId: string;
  itemName: string | null;
  steelMinor: number | null;
  matsMinor: number | null;
  /** Not a bucket. Reported so it is not silently dropped. */
  matsTaxMinor: number | null;
  raw: Record<string, string>;
  columnUsed: { STEEL: string | null; MATS: string | null };
  readAt: Date;
}

/**
 * Money out of a board cell.
 *
 * Board cells are typed by whoever built the column, so the same figure arrives as
 * "$4,250.00", "4250", "4,250.00 USD" or "". Anything that is not a number after the
 * currency furniture is stripped returns null — "not answered" — which is different
 * from 0, and the difference is the entire point of the queue.
 */
export function parseBoardMoney(value: string | null | undefined): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const cleaned = text.replace(/[$,\s]/g, '').replace(/[A-Za-z]+$/, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const amount = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

/**
 * Read the freight columns off one deal row.
 *
 * `display_value` is what a formula column exposes — `text` is null on formula
 * columns — so both are asked for and the first non-empty one wins. That fragment is
 * the same one `/proposals/:id/freight-amount` uses; getting it wrong reads every
 * figure as blank, which looks exactly like a board nobody has filled in.
 */
export async function readBoardFreight(
  itemId: string,
  fetchImpl?: typeof fetch,
): Promise<BoardFreight> {
  if (!isMondayPushConfigured()) {
    throw new ValidationError(
      'monday.com is not configured on this deployment, so steel and mats freight cannot be read. Set MONDAY_API_TOKEN and MONDAY_DEALS_BOARD_ID, or enter the figures by hand with a reason.',
    );
  }
  const ids = [
    COLUMNS.STEEL.primary,
    COLUMNS.STEEL.fallback,
    COLUMNS.MATS.primary,
    COLUMNS.MATS.fallback,
    MATS_TAX_COLUMN,
  ].filter(Boolean) as string[];

  const data = await mondayQuery<{
    items: Array<{
      id: string;
      name: string;
      column_values: Array<{ id: string; text: string | null; display_value?: string | null }>;
    }>;
  }>(
    `query ($items: [ID!]) {
       items (ids: $items) {
         id
         name
         column_values (ids: [${ids.map((c) => `"${c}"`).join(', ')}]) {
           id
           text
           ... on FormulaValue { display_value }
           ... on MirrorValue { display_value }
         }
       }
     }`,
    { items: [itemId] },
    fetchImpl,
  );

  const found = data.items?.[0];
  if (!found) {
    throw new ValidationError(
      `monday item ${itemId} is not on the Deal Tracking board, or the API token cannot see it.`,
    );
  }

  const raw: Record<string, string> = {};
  for (const c of found.column_values ?? []) {
    raw[c.id] = String(c.display_value ?? c.text ?? '').trim();
  }
  const pick = (bucket: 'STEEL' | 'MATS'): { minor: number | null; column: string | null } => {
    for (const column of [COLUMNS[bucket].primary, COLUMNS[bucket].fallback]) {
      if (!column) continue;
      const minor = parseBoardMoney(raw[column]);
      if (minor != null) return { minor, column };
    }
    return { minor: null, column: null };
  };

  const steel = pick('STEEL');
  const mats = pick('MATS');
  return {
    itemId,
    itemName: found.name ?? null,
    steelMinor: steel.minor,
    matsMinor: mats.minor,
    matsTaxMinor: parseBoardMoney(raw[MATS_TAX_COLUMN]),
    raw,
    columnUsed: { STEEL: steel.column, MATS: mats.column },
    readAt: new Date(),
  };
}

/**
 * The monday item id for a proposal version.
 *
 * The Project ID on the version's meta is an Item ID column by type, so its value IS
 * the deal's item id. It is preferred over anything looked up live because it is what
 * printed on the document the customer holds. The organization's linked opportunity
 * is the fallback for a proposal written before the field was populated.
 */
export async function mondayItemForVersion(versionId: string): Promise<string | null> {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: { sections: true, proposal: { select: { organizationId: true } } },
  });
  if (!version) return null;

  const meta = Array.isArray(version.sections)
    ? (version.sections as Array<{ id?: string; data?: Record<string, unknown> }>).find(
        (s) => s?.id === 'meta',
      )?.data
    : undefined;
  const fromMeta = String(meta?.projectId ?? '').trim();
  if (/^\d+$/.test(fromMeta)) return fromMeta;

  const opp = await prisma.opportunity.findFirst({
    where: { organizationId: version.proposal.organizationId, mondayItemId: { not: null } },
    orderBy: { updatedAt: 'desc' },
    select: { mondayItemId: true },
  });
  return opp?.mondayItemId ?? null;
}

export interface SyncResult {
  itemId: string | null;
  /** Entries created or updated by this read. */
  updated: Array<{
    bucket: 'STEEL' | 'MATS';
    entryId: string;
    amountMinor: number;
    changed: boolean;
  }>;
  /** Buckets the board still has no figure for. */
  outstanding: Array<'STEEL' | 'MATS'>;
  /**
   * A board figure that disagrees with money already applied or invoiced. Reported,
   * never written — see the module note.
   */
  conflicts: Array<{
    bucket: 'STEEL' | 'MATS';
    boardMinor: number;
    recordedMinor: number;
    entryId: string;
    status: string;
  }>;
  matsTaxMinor: number | null;
  /** Set when the board could not be read. The panel still opens. */
  error: string | null;
  readAt: string | null;
}

/**
 * Read the board and bring this version's STEEL and MATS entries up to date.
 *
 * Never throws for an unreachable board: the freight panel has to open when monday
 * is down, so a failure comes back in `error` and the manual override path — which
 * requires a reason — is what ops uses in the meantime.
 */
export async function syncVersion(
  versionId: string,
  actorId: string,
  opts: { trueUpId?: string; fetchImpl?: typeof fetch } = {},
): Promise<SyncResult> {
  const blank: SyncResult = {
    itemId: null,
    updated: [],
    outstanding: [],
    conflicts: [],
    matsTaxMinor: null,
    error: null,
    readAt: null,
  };

  const itemId = await mondayItemForVersion(versionId);
  if (!itemId) {
    return {
      ...blank,
      error:
        'This proposal has no Project ID, so there is no deal row to read steel and mats freight from. Add the Project ID, or enter the figures by hand with a reason.',
    };
  }

  let board: BoardFreight;
  try {
    board = await readBoardFreight(itemId, opts.fetchImpl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, versionId, itemId }, 'freight pull: monday read failed');
    return { ...blank, itemId, error: message };
  }

  const trueUpId = opts.trueUpId ?? (await liveTrueUpId(versionId, actorId));
  const existing = await prisma.freightEntry.findMany({
    where: { versionId, bucket: { in: ['STEEL', 'MATS'] }, source: 'MONDAY' },
    orderBy: { createdAt: 'desc' },
  });

  const result: SyncResult = {
    ...blank,
    itemId,
    matsTaxMinor: board.matsTaxMinor,
    readAt: board.readAt.toISOString(),
  };

  for (const bucket of ['STEEL', 'MATS'] as const) {
    const boardMinor = bucket === 'STEEL' ? board.steelMinor : board.matsMinor;
    if (boardMinor == null) {
      result.outstanding.push(bucket);
      continue;
    }

    const settled = existing.find(
      (e) => e.bucket === bucket && (e.status === 'APPLIED' || e.status === 'PUSHED'),
    );
    if (settled) {
      // The figure is already on the proposal — possibly on a customer's invoice.
      // A different board value now is a correction, and a correction after billing
      // is a credit and a rebill, so it is surfaced rather than applied.
      if (settled.amountMinor !== boardMinor) {
        result.conflicts.push({
          bucket,
          boardMinor,
          recordedMinor: settled.amountMinor,
          entryId: settled.id,
          status: settled.status,
        });
      }
      continue;
    }

    const staged = existing.find((e) => e.bucket === bucket && e.status === 'STAGED');
    const columnId = board.columnUsed[bucket];
    const rawValue = columnId ? (board.raw[columnId] ?? null) : null;

    if (staged) {
      const changed = staged.amountMinor !== boardMinor;
      const updated = await prisma.freightEntry.update({
        where: { id: staged.id },
        data: {
          amountMinor: boardMinor,
          mondayItemId: itemId,
          mondayColumnId: columnId,
          mondayRawValue: rawValue,
          mondayReadAt: board.readAt,
        },
      });
      result.updated.push({ bucket, entryId: updated.id, amountMinor: boardMinor, changed });
      continue;
    }

    const version = await prisma.proposalVersion.findUniqueOrThrow({
      where: { id: versionId },
      select: { proposalId: true },
    });
    const created = await prisma.freightEntry.create({
      data: {
        trueUpId,
        proposalId: version.proposalId,
        versionId,
        bucket,
        scope: 'JOB',
        source: 'MONDAY',
        status: 'STAGED',
        amountMinor: boardMinor,
        mondayItemId: itemId,
        mondayColumnId: columnId,
        mondayRawValue: rawValue,
        mondayReadAt: board.readAt,
        createdById: actorId,
      },
    });
    result.updated.push({ bucket, entryId: created.id, amountMinor: boardMinor, changed: true });
  }

  if (result.updated.some((u) => u.changed) || result.conflicts.length) {
    await recordAudit({
      actorId,
      action: 'freight.monday.pull',
      entity: 'ProposalVersion',
      entityId: versionId,
      details: {
        itemId,
        updated: result.updated,
        conflicts: result.conflicts,
        outstanding: result.outstanding,
        matsTaxMinor: result.matsTaxMinor,
      },
    });
  }
  if (result.conflicts.length) {
    logger.warn(
      { versionId, conflicts: result.conflicts },
      'freight pull: board disagrees with applied freight',
    );
  }
  return result;
}

/** The live true-up folder for a version, opened if there is not one yet. */
async function liveTrueUpId(versionId: string, actorId: string): Promise<string> {
  const open = await prisma.freightTrueUp.findFirst({
    where: { versionId, status: { in: ['OPEN', 'STAGED'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (open) return open.id;
  const version = await prisma.proposalVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { proposalId: true },
  });
  const row = await prisma.freightTrueUp.create({
    data: { proposalId: version.proposalId, versionId, status: 'OPEN', createdById: actorId },
  });
  return row.id;
}

export interface PullSweepResult {
  scanned: number;
  updated: number;
  conflicts: number;
  failed: Array<{ versionId: string; error: string }>;
}

/**
 * Nightly sweep: read the board for every job still waiting on steel or mats.
 *
 * The case this covers is mundane and expensive — the freight desk filled the column
 * in on a Friday afternoon, nobody opened the freight panel over the weekend, and the
 * invoice went out on Monday short by the freight. One read per outstanding job,
 * sequentially, because monday rate-limits by account and a burst of parallel reads
 * gets the whole integration throttled for everyone.
 *
 * `actorId` is the system user the cron runs as; every write it makes is audited
 * under that id, so a figure that appeared overnight is attributable.
 */
export async function pullOutstanding(
  actorId: string,
  opts: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<PullSweepResult> {
  const out: PullSweepResult = { scanned: 0, updated: 0, conflicts: 0, failed: [] };
  if (!isMondayPushConfigured()) return out;

  const candidates = await prisma.proposalVersion.findMany({
    where: { status: { in: ['RELEASED', 'ACCEPTED'] }, proposal: { archivedAt: null } },
    orderBy: { releasedAt: 'asc' },
    take: opts.limit ?? 200,
    select: { id: true },
  });

  for (const v of candidates) {
    const settled = await prisma.freightEntry.count({
      where: {
        versionId: v.id,
        bucket: { in: ['STEEL', 'MATS'] },
        status: { in: ['APPLIED', 'PUSHED'] },
      },
    });
    if (settled >= 2) continue; // both board buckets already answered and on the proposal

    out.scanned += 1;
    try {
      const r = await syncVersion(v.id, actorId, { fetchImpl: opts.fetchImpl });
      if (r.error) out.failed.push({ versionId: v.id, error: r.error });
      out.updated += r.updated.filter((u) => u.changed).length;
      out.conflicts += r.conflicts.length;
    } catch (err) {
      out.failed.push({ versionId: v.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  logger.info(out, 'freight pull: nightly sweep complete');
  return out;
}

/**
 * A board row changed — pull the jobs that read from it.
 *
 * Called from the monday webhook, which is signature-verified upstream. Deliberately
 * tolerant: an event for an item nothing points at is not an error, it is one of the
 * hundreds of edits a day on a board this application only partly cares about.
 */
export async function handleBoardChange(
  itemId: string,
  actorId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ versionsUpdated: number }> {
  const item = String(itemId ?? '').trim();
  if (!/^\d+$/.test(item)) return { versionsUpdated: 0 };

  // Which versions read from this row: the ones whose entries already name it, plus
  // the ones whose Project ID resolves to it. The first is an index lookup; the
  // second is the case where no figure has ever been read for this job.
  const known = await prisma.freightEntry.findMany({
    where: { mondayItemId: item, status: 'STAGED' },
    select: { versionId: true },
    distinct: ['versionId'],
  });
  const versionIds = new Set(known.map((k) => k.versionId));

  if (!versionIds.size) {
    const live = await prisma.proposalVersion.findMany({
      where: { status: { in: ['RELEASED', 'ACCEPTED'] }, proposal: { archivedAt: null } },
      orderBy: { releasedAt: 'desc' },
      take: 300,
      select: { id: true },
    });
    for (const v of live) {
      if ((await mondayItemForVersion(v.id)) === item) versionIds.add(v.id);
    }
  }

  let updated = 0;
  for (const versionId of versionIds) {
    try {
      const r = await syncVersion(versionId, actorId, { fetchImpl: opts.fetchImpl });
      if (r.updated.some((u) => u.changed)) updated += 1;
    } catch (err) {
      logger.warn({ err, versionId, item }, 'freight pull: webhook sync failed');
    }
  }
  return { versionsUpdated: updated };
}

/** For the admin screen: which columns this deployment reads, and whether it can. */
export function freightPullStatus(): {
  configured: boolean;
  boardId: string | null;
  columns: Record<string, string>;
} {
  return {
    configured: isMondayPushConfigured(),
    boardId: env.MONDAY_DEALS_BOARD_ID ?? null,
    columns: {
      steel: COLUMNS.STEEL.primary,
      steelFallback: COLUMNS.STEEL.fallback ?? '',
      mats: COLUMNS.MATS.primary,
      matsFallback: COLUMNS.MATS.fallback ?? '',
      matsTax: MATS_TAX_COLUMN,
    },
  };
}

export type { FreightEntry };
