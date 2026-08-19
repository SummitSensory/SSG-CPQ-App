import { mondayQuery } from './client.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { deliveryBoardId } from './portalDelivery.js';

/**
 * Registering the CRM's own monday webhooks, from the CRM.
 *
 * The alternative is clicking through monday's Integrate → Webhooks panel on each
 * board, per environment, and remembering to redo it when a preview deployment
 * gets a new URL. That is a manual step that fails quietly: nothing errors, the
 * board simply stops telling the CRM anything, and the first sign of it is an
 * address that never arrived.
 *
 * So the subscriptions are declared here as data, and `syncWebhooks` makes monday
 * match the declaration — idempotently, so it is safe to run on every deploy or by
 * hand from the integrations screen.
 *
 * Note that monday will not register a webhook on a subitem board. That is why
 * accessory tracking is on a cron rather than an event, and it is not something a
 * retry can fix.
 */

/** One subscription the CRM wants to exist. */
export interface WebhookSpec {
  boardId: string;
  /** monday's event name. `create_item` and `change_column_value` are the two used here. */
  event: 'create_item' | 'change_column_value' | 'change_status_column_value';
  /** Why it exists, for the integrations screen. */
  purpose: string;
}

export interface MondayWebhook {
  id: string;
  boardId: string;
  event: string;
  config: string | null;
}

/**
 * Where monday should post. Explicit env var first, because a preview deployment's
 * own URL is not where you want production's webhooks pointing, then Vercel's
 * deployment URL as a convenience for previews.
 */
export function webhookUrl(): string | null {
  if (env.PUBLIC_BASE_URL)
    return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/integrations/monday/webhook`;
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}/integrations/monday/webhook`;
  return null;
}

/**
 * The subscriptions the CRM needs.
 *
 * Both events on the submissions board, and this is the part worth understanding:
 * the portal creates its submission row and then writes ~30 columns one at a time,
 * so the `create_item` event carries no address at all. Without
 * `change_column_value` the CRM would be told a submission exists and never told
 * what it said.
 */
export function desiredWebhooks(): WebhookSpec[] {
  const delivery = deliveryBoardId();
  return [
    {
      boardId: delivery,
      event: 'create_item',
      purpose: 'A customer submitted delivery & site details — open the record.',
    },
    {
      boardId: delivery,
      event: 'change_column_value',
      purpose: "The portal is writing that submission's columns — read the address.",
    },
  ];
}

export async function listWebhooks(boardId: string): Promise<MondayWebhook[]> {
  const data = await mondayQuery<{
    webhooks: Array<{ id: string; board_id: string; event: string; config: string | null }>;
  }>(`query ($board: ID!) { webhooks (board_id: $board) { id board_id event config } }`, {
    board: boardId,
  });
  return (data.webhooks ?? []).map((w) => ({
    id: String(w.id),
    boardId: String(w.board_id),
    event: w.event,
    config: w.config ?? null,
  }));
}

async function createWebhook(boardId: string, url: string, event: string): Promise<string> {
  const data = await mondayQuery<{ create_webhook: { id: string } }>(
    `mutation ($board: ID!, $url: String!, $event: WebhookEventType!) {
       create_webhook (board_id: $board, url: $url, event: $event) { id }
     }`,
    { board: boardId, url, event },
  );
  return String(data.create_webhook.id);
}

export async function deleteWebhook(id: string): Promise<void> {
  await mondayQuery(`mutation ($id: ID!) { delete_webhook (id: $id) { id } }`, { id });
}

export interface SyncWebhookResult {
  url: string | null;
  created: Array<{ boardId: string; event: string; id: string }>;
  existing: Array<{ boardId: string; event: string; id: string }>;
  failed: Array<{ boardId: string; event: string; error: string }>;
  /** Webhooks on these boards pointing somewhere ELSE. Reported, never deleted. */
  foreign: Array<{ boardId: string; event: string; id: string; config: string | null }>;
}

/**
 * Make monday's subscriptions match `desiredWebhooks()`.
 *
 * Idempotent: an existing webhook for the same board, event and URL is left alone,
 * so this can run on every deploy. Webhooks pointing at some other URL are
 * reported and never touched — a preview deployment must not delete production's
 * subscription, and somebody may have added one by hand for a reason.
 *
 * `dryRun` reports what it would do and writes nothing.
 */
export async function syncWebhooks(dryRun = false): Promise<SyncWebhookResult> {
  const url = webhookUrl();
  const out: SyncWebhookResult = { url, created: [], existing: [], failed: [], foreign: [] };
  if (!env.MONDAY_API_TOKEN) {
    out.failed.push({ boardId: '-', event: '-', error: 'MONDAY_API_TOKEN is not set' });
    return out;
  }
  if (!url) {
    out.failed.push({
      boardId: '-',
      event: '-',
      error:
        'No public URL to give monday. Set PUBLIC_BASE_URL (e.g. https://crm.summitsensory.com).',
    });
    return out;
  }

  const specs = desiredWebhooks();
  const boards = [...new Set(specs.map((sp) => sp.boardId))];
  const byBoard = new Map<string, MondayWebhook[]>();
  for (const b of boards) {
    try {
      byBoard.set(b, await listWebhooks(b));
    } catch (err) {
      out.failed.push({ boardId: b, event: '-', error: `Could not list webhooks: ${String(err)}` });
    }
  }

  for (const spec of specs) {
    const current = byBoard.get(spec.boardId);
    if (!current) continue;
    // monday reports the target inside `config` as JSON; a plain substring test is
    // enough to tell our URL from somebody else's and avoids depending on its shape.
    const mine = current.find((w) => w.event === spec.event && (w.config ?? '').includes(url));
    if (mine) {
      out.existing.push({ boardId: spec.boardId, event: spec.event, id: mine.id });
      continue;
    }
    for (const other of current.filter((w) => w.event === spec.event)) {
      out.foreign.push({
        boardId: spec.boardId,
        event: spec.event,
        id: other.id,
        config: other.config,
      });
    }
    if (dryRun) continue;
    try {
      const id = await createWebhook(spec.boardId, url, spec.event);
      out.created.push({ boardId: spec.boardId, event: spec.event, id });
      logger.info({ boardId: spec.boardId, event: spec.event, id }, 'monday webhook registered');
    } catch (err) {
      out.failed.push({ boardId: spec.boardId, event: spec.event, error: String(err) });
      logger.error({ err, spec }, 'monday webhook registration failed');
    }
  }
  return out;
}

/**
 * What is subscribed right now, against what should be. The integrations screen
 * reads this, so "is monday actually going to tell us about a submission" is a
 * question with a visible answer rather than a trip into monday's settings.
 */
export async function webhookStatus(): Promise<{
  url: string | null;
  ready: boolean;
  subscriptions: Array<{
    boardId: string;
    event: string;
    purpose: string;
    registered: boolean;
    id: string | null;
  }>;
  error: string | null;
}> {
  const url = webhookUrl();
  const specs = desiredWebhooks();
  if (!env.MONDAY_API_TOKEN) {
    return {
      url,
      ready: false,
      subscriptions: specs.map((sp) => ({ ...sp, registered: false, id: null })),
      error: 'MONDAY_API_TOKEN is not set',
    };
  }
  const byBoard = new Map<string, MondayWebhook[]>();
  let error: string | null = null;
  for (const b of [...new Set(specs.map((sp) => sp.boardId))]) {
    try {
      byBoard.set(b, await listWebhooks(b));
    } catch (err) {
      error = `Could not read webhooks from monday: ${String(err)}`;
    }
  }
  const subscriptions = specs.map((sp) => {
    const hit = url
      ? (byBoard.get(sp.boardId) ?? []).find(
          (w) => w.event === sp.event && (w.config ?? '').includes(url),
        )
      : undefined;
    return { ...sp, registered: Boolean(hit), id: hit?.id ?? null };
  });
  return {
    url,
    ready: Boolean(url) && subscriptions.every((x) => x.registered),
    subscriptions,
    error,
  };
}
