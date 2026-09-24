import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import { ValidationError } from '../../lib/errors.js';
import { env, isMondayPushConfigured } from '../../config/env.js';
import { mondayQuery } from './client.js';
import { DEAL_COL } from './crmMapping.js';
import { parseBoardMoney } from './boardMoney.js';
import { subitemFreightForProposal, FREIGHT_AFTER_MARKUP_COL } from './subitemFreight.js';
import { freightLines, apportion, MATS_TAX } from '../../proposals/freightTrueUp.js';
import { versionTotals } from '../../proposals/analytics.js';
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
 * The mats freight TAX column — the Mat Freight Tax Pass-Through.
 *
 * Staged as a MATS_TAX entry (see syncMatsTax), never written to a freight bucket. A
 * person applies it with the freight, which puts it on the proposal's Tax field, and
 * the invoice push bills the difference to the R-TAX item.
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

export { parseBoardMoney };

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
  /** What happened to the mats freight tax on this read. See syncMatsTax. */
  matsTax?: MatsTaxSync | null;
  /** Set when the board could not be read. The panel still opens. */
  error: string | null;
  readAt: string | null;
  /**
   * Third-party freight from the freight-request subitems. Null when the proposal
   * never sent a freight request, or the version is not frozen yet (a draft reads
   * the same figures straight into the builder instead).
   */
  thirdParty?: ThirdPartySync | null;
}

/** The Mat Freight Tax Pass-Through, board against proposal. */
export interface MatsTaxSync {
  /** The board's figure (formula_mkzde17n), or null when the column is blank. */
  boardMinor: number | null;
  /** What the proposal's Tax field carries now. */
  onProposalMinor: number;
  /**
   *   'none'       — the board has no figure; nothing to do.
   *   'onProposal' — the proposal already carries the board's figure.
   *   'staged'     — staged (or re-staged) as a MATS_TAX entry, waiting to be applied.
   *   'conflict'   — the board changed after the tax was applied or billed. Reported
   *                  only: a billed tax is corrected with a credit, not a rewrite.
   */
  state: 'none' | 'onProposal' | 'staged' | 'conflict';
  /** Why nothing was staged although the board has a figure. */
  skipped?: 'cross-border';
  entryId: string | null;
  /** For a conflict: the figure already applied, and whether it is on an invoice. */
  recordedMinor?: number;
  recordedStatus?: string;
  changed: boolean;
}

/** What the freight-request subitems said, and what was done about it. */
export interface ThirdPartySync {
  error: string | null;
  readAt: string | null;
  /** SKUs whose quote was staged (or re-staged) as a THERAPEUTIC entry. */
  staged: Array<{
    sku: string;
    entryId: string;
    amountMinor: number;
    lines: number;
    changed: boolean;
  }>;
  /** Already on the proposal at the board's figure — nothing to do. */
  onProposal: string[];
  /** Requested and not answered yet. */
  pending: string[];
  /** Answered with no separate freight. */
  zero: string[];
  /** Marked "No Longer Interested". */
  dropped: string[];
  /** On a freight request but no longer on this version's lines. */
  notOnProposal: string[];
  /** Staged earlier, withdrawn because the board no longer quotes a figure. */
  withdrawn: string[];
  /**
   * The line already carries a different freight figure — typed in the builder, or
   * a catalog default. Never overwritten: which figure is right is a person's call.
   */
  differs: Array<{ sku: string; boardMinor: number; onProposalMinor: number }>;
  /** The board changed after the figure was applied or invoiced. Reported only. */
  conflicts: Array<{ sku: string; boardMinor: number; recordedMinor: number; status: string }>;
}

/** The SKU a board-read THERAPEUTIC entry is for — every allocation carries it. */
function entrySku(allocations: unknown): string {
  const first = Array.isArray(allocations) ? (allocations[0] as { sku?: unknown }) : null;
  return String(first?.sku ?? '')
    .trim()
    .toUpperCase();
}

/**
 * Stage third-party freight from the freight-request subitems.
 *
 * One THERAPEUTIC entry per quoted SKU, split across that SKU's lines. Deliberately
 * cautious about what it will touch, because this is money on a document a customer
 * may already have signed:
 *
 *   - Only lines carrying NO freight get a figure. A line entry adds to what the line
 *     holds, so staging onto a line the rep already priced freight for would double
 *     it; that case is reported in `differs` for a person to settle.
 *   - An applied or invoiced figure is never moved. A board that disagrees later is a
 *     `conflict`, the same rule steel and mats follow.
 *   - A staged figure the board no longer supports (the cost was cleared, the item
 *     was dropped) is withdrawn, so a stale number cannot be applied by accident.
 */
async function syncThirdParty(
  versionId: string,
  itemId: string | null,
  actorId: string,
  trueUpId: () => Promise<string>,
  fetchImpl?: typeof fetch,
): Promise<ThirdPartySync | null> {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: { proposalId: true, items: true, frozen: true },
  });
  if (!version?.frozen) return null;

  const board = await subitemFreightForProposal(version.proposalId, itemId, fetchImpl);
  if (!board.requested) return null;

  const out: ThirdPartySync = {
    error: board.error,
    readAt: board.readAt,
    staged: [],
    onProposal: [],
    pending: [],
    zero: [],
    dropped: [],
    notOnProposal: [],
    withdrawn: [],
    differs: [],
    conflicts: [],
  };
  if (board.error) return out;

  const lines = freightLines(version.items);
  const existing = await prisma.freightEntry.findMany({
    where: { versionId, bucket: 'THERAPEUTIC', source: 'MONDAY', status: { not: 'VOID' } },
    orderBy: { createdAt: 'desc' },
  });
  const now = new Date(board.readAt ?? Date.now());

  const withdraw = async (id: string, sku: string) => {
    await prisma.freightEntry.delete({ where: { id } });
    out.withdrawn.push(sku);
  };

  for (const q of board.skus) {
    const mine = existing.filter((e) => entrySku(e.allocations) === q.sku);
    const settled = mine.find((e) => e.status === 'APPLIED' || e.status === 'PUSHED');
    const staged = mine.find((e) => e.status === 'STAGED');
    const matching = lines.filter((l) => l.sku.trim().toUpperCase() === q.sku);

    if (settled) {
      if (q.state === 'QUOTED' && q.amountMinor !== settled.amountMinor) {
        out.conflicts.push({
          sku: q.sku,
          boardMinor: q.amountMinor!,
          recordedMinor: settled.amountMinor,
          status: settled.status,
        });
      }
      continue;
    }

    if (q.state !== 'QUOTED' || !matching.length) {
      if (staged) await withdraw(staged.id, q.sku);
      if (!matching.length) out.notOnProposal.push(q.sku);
      else if (q.state === 'PENDING') out.pending.push(q.sku);
      else if (q.state === 'ZERO') out.zero.push(q.sku);
      else if (q.state === 'DROPPED') out.dropped.push(q.sku);
      continue;
    }

    const amountMinor = q.amountMinor!;
    const current = matching.reduce((a, l) => a + l.currentMinor, 0);
    if (current > 0) {
      if (staged) await withdraw(staged.id, q.sku);
      if (current === amountMinor) out.onProposal.push(q.sku);
      else out.differs.push({ sku: q.sku, boardMinor: amountMinor, onProposalMinor: current });
      continue;
    }

    const allocations = apportion(amountMinor, matching).map((a) => {
      const line = matching.find((l) => l.ref === a.ref)!;
      return { ref: a.ref, sku: q.sku, name: line.name, amountMinor: a.amountMinor };
    });
    const data = {
      amountMinor,
      allocations,
      absolute: true,
      vendorName: q.vendor || null,
      vendorQuoteRef: q.quoteRef || q.rfqRef || null,
      note: `Freight quote for ${q.sku} (${q.rfqRef || 'freight request'}), monday subitem ${q.subitemId}`,
      mondayItemId: itemId,
      mondayColumnId: FREIGHT_AFTER_MARKUP_COL,
      mondayRawValue: (amountMinor / 100).toFixed(2),
      mondayReadAt: now,
    };

    if (staged) {
      const changed =
        staged.amountMinor !== amountMinor ||
        JSON.stringify(staged.allocations) !== JSON.stringify(allocations);
      if (changed) await prisma.freightEntry.update({ where: { id: staged.id }, data });
      out.staged.push({
        sku: q.sku,
        entryId: staged.id,
        amountMinor,
        lines: matching.length,
        changed,
      });
      continue;
    }

    const created = await prisma.freightEntry.create({
      data: {
        ...data,
        trueUpId: await trueUpId(),
        proposalId: version.proposalId,
        versionId,
        bucket: 'THERAPEUTIC',
        scope: 'LINES',
        source: 'MONDAY',
        status: 'STAGED',
        createdById: actorId,
      },
    });
    out.staged.push({
      sku: q.sku,
      entryId: created.id,
      amountMinor,
      lines: matching.length,
      changed: true,
    });
  }

  // A staged figure whose subitem is gone from the board altogether (deleted by hand)
  // has nothing behind it any more.
  const onBoard = new Set(board.skus.map((q) => q.sku));
  for (const e of existing) {
    const sku = entrySku(e.allocations);
    if (e.status === 'STAGED' && !onBoard.has(sku)) await withdraw(e.id, sku);
  }

  if (out.staged.some((s) => s.changed) || out.withdrawn.length || out.conflicts.length) {
    await recordAudit({
      actorId,
      action: 'freight.monday.thirdParty',
      entity: 'ProposalVersion',
      entityId: versionId,
      details: {
        itemId,
        staged: out.staged,
        withdrawn: out.withdrawn,
        differs: out.differs,
        conflicts: out.conflicts,
      },
    });
  }
  return out;
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
  const result = await syncBoardBuckets(versionId, actorId, opts);
  // Third-party freight comes off the freight-request subitems, which are found by
  // their own ids — so it is read even when the deal row itself could not be.
  let folder: string | undefined = opts.trueUpId;
  try {
    result.thirdParty = await syncThirdParty(
      versionId,
      result.itemId,
      actorId,
      async () => (folder ??= await liveTrueUpId(versionId, actorId)),
      opts.fetchImpl,
    );
  } catch (err) {
    logger.warn({ err, versionId }, 'freight pull: third-party subitem sync failed');
    result.thirdParty = {
      error: err instanceof Error ? err.message : String(err),
      readAt: null,
      staged: [],
      onProposal: [],
      pending: [],
      zero: [],
      dropped: [],
      notOnProposal: [],
      withdrawn: [],
      differs: [],
      conflicts: [],
    };
  }
  return result;
}

/** Steel and mats, off the deal row itself. */
async function syncBoardBuckets(
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

  result.matsTax = await syncMatsTax(versionId, itemId, board, trueUpId, actorId);

  if (
    result.updated.some((u) => u.changed) ||
    result.conflicts.length ||
    result.matsTax?.changed ||
    result.matsTax?.state === 'conflict'
  ) {
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
        matsTax: result.matsTax,
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

/**
 * Stage the Mat Freight Tax Pass-Through off the deal board.
 *
 * The board's figure is the proposal's WHOLE tax, so a staged entry replaces the Tax
 * field when applied. Same discipline as steel and mats:
 *
 *   - a figure already APPLIED or PUSHED is never moved; a board that disagrees later
 *     is a conflict for a person (a billed tax is corrected with a credit);
 *   - a figure the proposal already carries needs nothing, and a stale staged one is
 *     withdrawn so it cannot be applied by accident;
 *   - a blank board column changes nothing — blank is "not quoted yet", not zero.
 *
 * priorAmountMinor is the proposal's tax at staging, so the screens can say what the
 * invoice will be billed; applyEntries re-records it at the moment it applies.
 */
async function syncMatsTax(
  versionId: string,
  itemId: string,
  board: BoardFreight,
  trueUpId: string,
  actorId: string,
): Promise<MatsTaxSync> {
  const version = await prisma.proposalVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { proposalId: true, items: true, sections: true },
  });
  const onProposalMinor = versionTotals(version.items, version.sections).tax;
  const boardMinor = board.matsTaxMinor;
  const out: MatsTaxSync = {
    boardMinor,
    onProposalMinor,
    state: 'none',
    entryId: null,
    changed: false,
  };
  const existing = await prisma.freightEntry.findMany({
    where: { versionId, bucket: MATS_TAX, source: 'MONDAY', status: { not: 'VOID' } },
    orderBy: { createdAt: 'desc' },
  });
  const withdrawStaged = async () => {
    const stale = existing.find((e) => e.status === 'STAGED');
    if (stale) await prisma.freightEntry.delete({ where: { id: stale.id } });
    return !!stale;
  };

  // Blank — and 0. The board's formula is
  //   if({R-Tax} > 1, round({R-Tax} × 1.15, 2), 0)
  // so an R-Tax nobody has filled in reads as 0, not as blank. Taking that 0 at its
  // word would stage "cut the tax to $0" on every deal the carrier has not quoted
  // yet, so 0 is "not quoted", exactly like a blank column. A tax is never lowered
  // to zero from the board; a genuine zero is a person's change to the proposal.
  if (boardMinor == null || boardMinor === 0) {
    return { ...out, boardMinor: null, changed: await withdrawStaged() };
  }

  // A Canadian job's tax is the cross-border engine's, and a hand-keyed Tax figure
  // beside it taxes the customer twice — the release blocker
  // `tax:manual_amount_present` refuses exactly that. So the board's figure is never
  // staged onto a cross-border version.
  const crossBorder = await prisma.proposalCrossBorderSnapshot.count({ where: { versionId } });
  if (crossBorder > 0) {
    return { ...out, state: 'none', skipped: 'cross-border', changed: await withdrawStaged() };
  }
  const settled = existing.find((e) => e.status === 'APPLIED' || e.status === 'PUSHED');
  const staged = existing.find((e) => e.status === 'STAGED');

  if (settled) {
    if (settled.amountMinor !== boardMinor) {
      if (staged) await prisma.freightEntry.delete({ where: { id: staged.id } });
      return {
        ...out,
        state: 'conflict',
        entryId: settled.id,
        recordedMinor: settled.amountMinor,
        recordedStatus: settled.status,
      };
    }
    return { ...out, state: 'onProposal', entryId: settled.id };
  }

  if (boardMinor === onProposalMinor) {
    if (staged) {
      await prisma.freightEntry.delete({ where: { id: staged.id } });
      out.changed = true;
    }
    return { ...out, state: 'onProposal' };
  }

  const rawValue = board.raw[MATS_TAX_COLUMN] ?? null;
  const data = {
    amountMinor: boardMinor,
    priorAmountMinor: onProposalMinor,
    absolute: true,
    mondayItemId: itemId,
    mondayColumnId: MATS_TAX_COLUMN,
    mondayRawValue: rawValue,
    mondayReadAt: board.readAt,
  };
  if (staged) {
    const changed =
      staged.amountMinor !== boardMinor || staged.priorAmountMinor !== onProposalMinor;
    if (changed) await prisma.freightEntry.update({ where: { id: staged.id }, data });
    return { ...out, state: 'staged', entryId: staged.id, changed };
  }
  const created = await prisma.freightEntry.create({
    data: {
      ...data,
      trueUpId,
      proposalId: version.proposalId,
      versionId,
      bucket: MATS_TAX,
      scope: 'JOB',
      source: 'MONDAY',
      status: 'STAGED',
      createdById: actorId,
    },
  });
  return { ...out, state: 'staged', entryId: created.id, changed: true };
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
    select: { id: true, proposalId: true },
  });

  for (const v of candidates) {
    const settled = await prisma.freightEntry.count({
      where: {
        versionId: v.id,
        bucket: { in: ['STEEL', 'MATS'] },
        status: { in: ['APPLIED', 'PUSHED'] },
      },
    });
    // Both board buckets answered and on the proposal. Still read when the proposal
    // sent freight requests: those quotes arrive on the subitems, on their own clock.
    if (settled >= 2) {
      const requested = await prisma.freightRfq.count({
        where: { proposalId: v.proposalId, status: { not: 'DRAFT' } },
      });
      if (!requested) continue;
    }

    out.scanned += 1;
    try {
      const r = await syncVersion(v.id, actorId, { fetchImpl: opts.fetchImpl });
      if (r.error) out.failed.push({ versionId: v.id, error: r.error });
      if (r.thirdParty?.error) out.failed.push({ versionId: v.id, error: r.thirdParty.error });
      out.updated += r.updated.filter((u) => u.changed).length;
      out.updated += r.thirdParty?.staged.filter((s) => s.changed).length ?? 0;
      out.updated += r.matsTax?.changed ? 1 : 0;
      out.conflicts += r.conflicts.length + (r.thirdParty?.conflicts.length ?? 0);
      out.conflicts += r.matsTax?.state === 'conflict' ? 1 : 0;
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
      if (r.updated.some((u) => u.changed) || r.matsTax?.changed) updated += 1;
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
      thirdPartyAfterMarkup: FREIGHT_AFTER_MARKUP_COL,
    },
  };
}

export type { FreightEntry };
