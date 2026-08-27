import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { mondayQuery, setColumnValues } from './client.js';
import { fetchItemById, fetchAllItems, type MondayItem } from './discovery.js';

/**
 * The customer portal invite, fired from the Manufacturing Process board.
 *
 * The board carries two status columns. A staff member sets the first one
 * (`color_mm547f1s`) to **Send Invite**; the portal's own send is driven off the
 * second (`color_mm5427cr`). This closes the gap between them: when the trigger
 * says Send Invite, the invite column is set to Send Invite.
 *
 * monday can do that natively — "when status changes to X, change status to Y" —
 * and if that is all you need, use the native recipe and delete this file. What a
 * native recipe cannot do is tell you afterwards that it did not run. A recipe
 * suppressed as an automation-triggered-by-automation, a label renamed on the
 * target column, a monday incident: all three fail by doing nothing, and the first
 * report of any of them is a customer who never got an invite. So this path exists
 * for the same reason portalDelivery.ts does — every attempt lands in
 * IntegrationSyncLog, and a missed one is repaired by the nightly sweep.
 *
 * Four things shape the code below.
 *
 * **A create event carries no status.** The row is created and the status is set
 * afterwards, so `create_item` alone would never see Send Invite. Both events are
 * subscribed (see webhookRegistration.ts) and every event re-reads the row, which
 * is the same lesson the delivery board taught.
 *
 * **The board is the idempotency key, not the log.** An event is not deduplicated
 * on its id; the invite column's own value is checked first, and an item that
 * already says Send Invite is left alone. That makes a redelivered webhook free,
 * and it also means a deliberate re-invite (staff clear the column and set the
 * trigger again) still fires, which a stored-event guard would have swallowed.
 *
 * **The label must already exist on the target column.** Writing with
 * `create_labels_if_missing` would happily invent a second "Send Invite" that the
 * portal is not watching, which looks like success and sends nothing. The labels
 * are read first, and a missing one is reported in words rather than written.
 *
 * **A column change on this board is cheap to ignore.** Every column on the
 * Manufacturing board posts here. When the event names a column that is not the
 * trigger, this returns without calling monday at all.
 */

const ENTITY = 'monday-portal-invite';

/** Manufacturing Process. Env-overridable so a rebuilt board is a config change. */
export function manufacturingBoardId(): string {
  return env.MONDAY_MANUFACTURING_BOARD_ID ?? '6533700776';
}

/**
 * The two status columns, both env-overridable for the same reason the board id is.
 * `trigger` is what a person sets; `invite` is what the portal watches.
 */
export const MFG_COL = {
  trigger: env.MONDAY_MFG_TRIGGER_COLUMN ?? 'color_mm547f1s',
  invite: env.MONDAY_MFG_INVITE_COLUMN ?? 'color_mm5427cr',
} as const;

/** The label that means "go", and the label written when it does. */
export const TRIGGER_LABEL = env.MONDAY_INVITE_TRIGGER_LABEL ?? 'Send Invite';
export const INVITE_LABEL = env.MONDAY_INVITE_LABEL ?? 'Send Invite';

const eq = (a: string | null | undefined, b: string): boolean =>
  String(a ?? '')
    .trim()
    .toLowerCase() === b.trim().toLowerCase();

/** A token to read and write with, a board to do it on, and two distinct columns. */
export function isPortalInviteConfigured(): boolean {
  return Boolean(
    env.MONDAY_API_TOKEN && manufacturingBoardId() && MFG_COL.trigger !== MFG_COL.invite,
  );
}

export type InviteResult =
  /** The invite column was changed. */
  | 'set'
  /** It already said Send Invite. Nothing written; this is the redelivery case. */
  | 'already-set'
  /** The trigger column does not say Send Invite. The ordinary answer. */
  | 'not-triggered'
  /** The event named a column that is not the trigger. No monday call was made. */
  | 'ignored'
  | 'notfound'
  | 'unconfigured'
  /** The label is not defined on the invite column, so writing it would be a lie. */
  | 'label-missing'
  | 'failed';

export interface InviteOutcome {
  itemId: string;
  result: InviteResult;
  /** In words, for the integrations screen. Null when there is nothing to say. */
  detail: string | null;
}

/**
 * Record an attempt. Only outcomes that mean something are stored — an untriggered
 * or ignored event is the overwhelming majority of the traffic on this board, and
 * logging those would bury the ones worth reading.
 *
 * `eventId` is unique in the schema, so it carries monday's own trigger uuid when
 * there is one (a redelivery then collides and is dropped, which is correct) and a
 * timestamped key otherwise. Never throws: losing the audit row must not fail an
 * invite that actually went out.
 */
async function record(
  itemId: string,
  status: InviteResult,
  detail: string | null,
  eventId?: string,
): Promise<void> {
  try {
    await prisma.integrationSyncLog.create({
      data: {
        provider: 'monday',
        direction: 'OUTBOUND',
        entity: ENTITY,
        entityId: itemId,
        externalId: itemId,
        eventId: eventId ?? `${ENTITY}:${itemId}:${Date.now()}`,
        status,
        error: detail,
      },
    });
  } catch (err) {
    logger.warn({ err, itemId, status }, 'portal invite: could not record attempt');
  }
}

/**
 * The labels defined on the invite column right now.
 *
 * Cached for ten minutes: it is board configuration, it changes about never, and a
 * board-wide status change would otherwise read the column settings once per event.
 * Returns null when monday could not be asked — the caller then proceeds and lets
 * the write itself fail, because refusing to send on a failed *precondition check*
 * would turn a transient read error into a missed invite.
 */
let labelCache: { at: number; labels: Set<string> } | null = null;
const LABEL_TTL_MS = 10 * 60_000;

async function inviteColumnLabels(): Promise<Set<string> | null> {
  if (labelCache && Date.now() - labelCache.at < LABEL_TTL_MS) return labelCache.labels;
  try {
    const data = await mondayQuery<{
      boards: Array<{
        columns: Array<{ id: string; title: string; type: string; settings_str: string | null }>;
      }>;
    }>(
      `query ($board: [ID!]) {
         boards (ids: $board) { columns { id title type settings_str } }
       }`,
      { board: [manufacturingBoardId()] },
    );
    const col = (data.boards[0]?.columns ?? []).find((c) => c.id === MFG_COL.invite);
    if (!col) {
      logger.error(
        { column: MFG_COL.invite, board: manufacturingBoardId() },
        'portal invite: the invite column does not exist on this board',
      );
      labelCache = { at: Date.now(), labels: new Set() };
      return labelCache.labels;
    }
    const settings = JSON.parse(col.settings_str ?? '{}') as {
      labels?: Record<string, string | { name?: string }>;
    };
    const labels = new Set<string>();
    for (const v of Object.values(settings.labels ?? {})) {
      const text = typeof v === 'string' ? v : (v?.name ?? '');
      if (text.trim()) labels.add(text.trim().toLowerCase());
    }
    labelCache = { at: Date.now(), labels };
    return labels;
  } catch (err) {
    logger.warn({ err }, 'portal invite: could not read the invite column labels');
    return null;
  }
}

/** Drop the cache — for after somebody edits the labels in monday. */
export function forgetInviteLabels(): void {
  labelCache = null;
}

/**
 * Bring one Manufacturing row's invite column in line with its trigger column.
 *
 * `columnId` is the column the event named, when there was one: an event about any
 * other column returns `ignored` without touching monday. `force` skips the trigger
 * check, which is how a person re-sends from the integrations screen for a row whose
 * trigger has already moved on.
 */
export async function applyPortalInvite(
  itemId: string,
  opts: { columnId?: string | undefined; eventId?: string | undefined; force?: boolean } = {},
): Promise<InviteOutcome> {
  if (!isPortalInviteConfigured()) {
    const detail =
      MFG_COL.trigger === MFG_COL.invite
        ? 'The trigger and invite columns are the same column — that would be a loop. Check MONDAY_MFG_TRIGGER_COLUMN / MONDAY_MFG_INVITE_COLUMN.'
        : 'MONDAY_API_TOKEN is not set.';
    return { itemId, result: 'unconfigured', detail };
  }
  if (opts.columnId && opts.columnId !== MFG_COL.trigger && !opts.force)
    return { itemId, result: 'ignored', detail: null };

  const item = await fetchItemById(itemId).catch((err: unknown) => {
    logger.error({ err, itemId }, 'portal invite: could not read the item');
    return null;
  });
  if (!item) {
    await record(itemId, 'notfound', 'monday returned no item with this id.', opts.eventId);
    return { itemId, result: 'notfound', detail: 'monday returned no item with this id.' };
  }

  const trigger = item.text[MFG_COL.trigger] ?? '';
  const current = item.text[MFG_COL.invite] ?? '';

  if (!opts.force && !eq(trigger, TRIGGER_LABEL))
    return { itemId, result: 'not-triggered', detail: null };

  // The board's own value is the idempotency check. A redelivered webhook, the
  // create event and the change event for the same click all land here and only the
  // first one writes.
  if (eq(current, INVITE_LABEL)) return { itemId, result: 'already-set', detail: null };

  const labels = await inviteColumnLabels();
  if (labels && !labels.has(INVITE_LABEL.trim().toLowerCase())) {
    const detail =
      `“${INVITE_LABEL}” is not a label on column ${MFG_COL.invite}. Add it in monday ` +
      `(column settings → Edit Labels) — writing a label that does not exist would ` +
      `create a second one the portal is not watching.`;
    logger.error({ itemId, column: MFG_COL.invite }, 'portal invite: label missing on column');
    await record(itemId, 'label-missing', detail, opts.eventId);
    return { itemId, result: 'label-missing', detail };
  }

  try {
    await setColumnValues(manufacturingBoardId(), itemId, {
      [MFG_COL.invite]: { label: INVITE_LABEL },
    });
  } catch (err) {
    const detail = String(err);
    logger.error({ err, itemId }, 'portal invite: write failed');
    await record(itemId, 'failed', detail, opts.eventId);
    return { itemId, result: 'failed', detail };
  }

  const detail = `${item.name}: ${MFG_COL.invite} set to “${INVITE_LABEL}”${
    current ? ` (was “${current}”)` : ''
  }.`;
  await record(itemId, 'set', detail, opts.eventId);
  logger.info({ itemId, name: item.name }, 'portal invite: invite column set');
  return { itemId, result: 'set', detail };
}

export interface InviteSweepResult {
  scanned: number;
  set: number;
  alreadySet: number;
  failed: number;
  /** Hit the per-run write cap; run it again to continue. */
  truncated: boolean;
  outcomes: InviteOutcome[];
  error?: string;
}

/**
 * Read the board and fix every row whose trigger says Send Invite but whose invite
 * column does not.
 *
 * This is the backstop for the failure the whole file exists for: a webhook that
 * never arrived, an automation monday suppressed, an outage during the click. Safe
 * on a schedule and safe to double-fire — a row already carrying the label is not
 * rewritten, so a quiet day costs one board read and no writes.
 *
 * `maxWrites` bounds the writes rather than the scan, because a first run against a
 * board with a backlog would otherwise spend the whole function budget on monday
 * mutations and time out halfway with no record of where it stopped.
 */
export async function sweepPendingInvites(
  maxItems = 500,
  maxWrites = 25,
): Promise<InviteSweepResult> {
  const out: InviteSweepResult = {
    scanned: 0,
    set: 0,
    alreadySet: 0,
    failed: 0,
    truncated: false,
    outcomes: [],
  };
  if (!isPortalInviteConfigured()) {
    out.error = 'Portal invite is not configured on this deployment.';
    return out;
  }

  let items: MondayItem[];
  try {
    items = await fetchAllItems(manufacturingBoardId(), 250, maxItems);
  } catch (err) {
    logger.error({ err }, 'portal invite sweep: board read failed');
    out.error = String(err);
    return out;
  }
  out.scanned = items.length;

  for (const item of items) {
    if (!eq(item.text[MFG_COL.trigger], TRIGGER_LABEL)) continue;
    if (eq(item.text[MFG_COL.invite], INVITE_LABEL)) {
      out.alreadySet++;
      continue;
    }
    if (out.set + out.failed >= maxWrites) {
      out.truncated = true;
      break;
    }
    const outcome = await applyPortalInvite(item.id, {
      eventId: `${ENTITY}:sweep:${item.id}:${Date.now()}`,
    });
    out.outcomes.push(outcome);
    if (outcome.result === 'set') out.set++;
    else if (outcome.result === 'already-set') out.alreadySet++;
    else out.failed++;
  }

  logger.info(out, 'portal invite sweep');
  return out;
}

export interface InviteStatus {
  configured: boolean;
  boardId: string;
  triggerColumn: string;
  inviteColumn: string;
  triggerLabel: string;
  inviteLabel: string;
  /** Whether the label this writes actually exists on the target column. */
  labelOnColumn: boolean | null;
  recent: Array<{
    itemId: string | null;
    status: string;
    detail: string | null;
    at: string;
  }>;
}

/**
 * What this integration is pointed at, whether the target label exists, and the
 * last few attempts. The point of the whole exercise: "did the invite fire" is a
 * question with an answer on a screen.
 */
export async function portalInviteStatus(limit = 50): Promise<InviteStatus> {
  const labels = isPortalInviteConfigured() ? await inviteColumnLabels() : null;
  const rows = await prisma.integrationSyncLog
    .findMany({
      where: { entity: ENTITY },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: { entityId: true, status: true, error: true, createdAt: true },
    })
    .catch(() => []);
  return {
    configured: isPortalInviteConfigured(),
    boardId: manufacturingBoardId(),
    triggerColumn: MFG_COL.trigger,
    inviteColumn: MFG_COL.invite,
    triggerLabel: TRIGGER_LABEL,
    inviteLabel: INVITE_LABEL,
    labelOnColumn: labels ? labels.has(INVITE_LABEL.trim().toLowerCase()) : null,
    recent: rows.map((r) => ({
      itemId: r.entityId,
      status: r.status,
      detail: r.error,
      at: r.createdAt.toISOString(),
    })),
  };
}
