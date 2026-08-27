import { createHash } from 'node:crypto';
import { mondayQuery } from './client.js';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { deliveryBoardId } from './portalDelivery.js';
import { isPortalInviteConfigured, manufacturingBoardId } from './portalInvite.js';

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
 * Identity, and why this file keeps its own record
 * ------------------------------------------------
 * monday's `webhooks` query returns id, board_id, event and config — and `config`
 * does NOT contain the target URL. The first version of this file matched on the
 * URL appearing inside `config`, which never matched anything: status showed
 * `registered: false` for subscriptions that existed, and sync read that as "not
 * subscribed yet" and created another one on every call.
 *
 * There is no way to ask monday "is this webhook pointing at me", so ownership is
 * recorded on our side instead. Every webhook this code creates is written to
 * IntegrationSyncLog under a key derived from (URL, board, event), and a
 * subscription counts as ours when that recorded id is still present in monday's
 * live list. Deleted on monday's side, the record stops matching and sync
 * recreates it; that is the whole idempotency story.
 *
 * Where a webhook exists for a board and event that we have no record of, sync
 * ADOPTS it rather than adding a second one — a duplicate posts every event twice,
 * which is worse than an unverified subscription, and the delivery handler is
 * keyed on the submission row so an adopted-but-foreign webhook is visible in the
 * status output rather than silently wrong. `force: true` overrides that and
 * creates ours anyway.
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
 * How we know a subscription is ours.
 *  - `confirmed`: monday's own config names our URL. Rare — monday usually omits it.
 *  - `recorded`:  we created it and the id we recorded is still live. The normal case.
 *  - `adopted`:   it existed for this board and event with no record of ours. Left
 *                 alone and recorded, so no duplicate is created; not proof it
 *                 posts here.
 */
export type Ownership = 'confirmed' | 'recorded' | 'adopted';

/** IntegrationSyncLog rows this module owns. */
const ENTITY = 'monday-webhook';

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
 * The key a claim is stored under. The URL is part of it so that a preview
 * deployment cannot claim production's subscription, or be told it already has one;
 * hashed only to keep the key short and stable.
 */
function claimKey(url: string, spec: Pick<WebhookSpec, 'boardId' | 'event'>): string {
  const target = createHash('sha256').update(url).digest('hex').slice(0, 12);
  return `${ENTITY}:${target}:${spec.boardId}:${spec.event}`;
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
  const specs: WebhookSpec[] = [
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

  /**
   * The Manufacturing Process board, for the customer portal invite. Same two
   * events and the same reasoning: a row is created and its status is set
   * afterwards, so `create_item` alone would never see "Send Invite".
   *
   * `change_column_value` rather than `change_status_column_value` on purpose. The
   * narrower event exists, but the handler already ignores an event naming any
   * column but the trigger without calling monday, and one subscription that covers
   * both boards' needs is one less thing to get wrong on a board rebuild.
   *
   * Omitted entirely when the invite is not configured — a subscription with no
   * handler behind it is traffic nobody reads.
   */
  if (isPortalInviteConfigured()) {
    const mfg = manufacturingBoardId();
    specs.push(
      {
        boardId: mfg,
        event: 'create_item',
        purpose: 'A new manufacturing row — it may already say Send Invite.',
      },
      {
        boardId: mfg,
        event: 'change_column_value',
        purpose: 'The invite trigger status changed — set the portal invite column.',
      },
    );
  }

  return specs;
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
  await prisma.integrationSyncLog
    .updateMany({
      where: { entity: ENTITY, externalId: id, status: 'registered' },
      data: { status: 'deleted' },
    })
    .catch((err: unknown) => logger.warn({ err, id }, 'could not clear webhook claim'));
}

/** Read back which webhook id we hold for each spec, keyed by `${boardId}:${event}`. */
async function loadClaims(
  url: string,
  specs: WebhookSpec[],
): Promise<Map<string, { id: string; adopted: boolean }>> {
  const keys = specs.map((sp) => claimKey(url, sp));
  const out = new Map<string, { id: string; adopted: boolean }>();
  if (!keys.length) return out;
  const rows: Array<{ eventId: string | null; externalId: string | null; error: string | null }> =
    await prisma.integrationSyncLog.findMany({
      where: { entity: ENTITY, eventId: { in: keys }, status: 'registered' },
      select: { eventId: true, externalId: true, error: true },
    });
  for (const sp of specs) {
    const key = claimKey(url, sp);
    const row = rows.find((r) => r.eventId === key);
    if (row?.externalId)
      out.set(`${sp.boardId}:${sp.event}`, {
        id: row.externalId,
        adopted: row.error === 'adopted',
      });
  }
  return out;
}

/**
 * Record that `webhookId` is the subscription for this spec at this URL.
 *
 * Upserted on the claim key, so re-registering after a delete on monday's side
 * replaces the id rather than accumulating rows. `error` carries how we came to
 * hold it — the column is free text on an append-only log, and this keeps the fix
 * to code with no migration behind it.
 */
async function recordClaim(
  url: string,
  spec: WebhookSpec,
  webhookId: string,
  how: 'created' | 'adopted',
): Promise<void> {
  const key = claimKey(url, spec);
  const data = {
    provider: 'monday',
    direction: 'INBOUND' as const,
    entity: ENTITY,
    entityId: `${spec.boardId}:${spec.event}`,
    externalId: webhookId,
    eventId: key,
    status: 'registered',
    error: how,
  };
  try {
    await prisma.integrationSyncLog.upsert({
      where: { eventId: key },
      create: data,
      update: { externalId: webhookId, status: 'registered', error: how },
    });
  } catch (err) {
    // A lost claim means the next sync adopts instead of recognising — noisy in the
    // status output, but it will not create a duplicate. Not worth failing the sync.
    logger.warn({ err, spec, webhookId }, 'could not record monday webhook claim');
  }
}

/** Does monday's own config name our URL? Usually it does not, so this is a bonus. */
function configNamesUrl(w: MondayWebhook, url: string): boolean {
  return (w.config ?? '').includes(url);
}

interface Resolved {
  webhook: MondayWebhook | null;
  ownership: Ownership | null;
  /** Same board and event, not the one we hold. Every event arrives twice per extra. */
  duplicates: MondayWebhook[];
}

/**
 * Decide which live webhook is ours for a spec, from three signals in order of
 * strength: monday confirms the URL, we recorded the id, or one simply exists.
 */
function resolve(
  spec: WebhookSpec,
  live: MondayWebhook[],
  claimed: { id: string; adopted: boolean } | undefined,
  url: string,
): Resolved {
  const candidates = live.filter((w) => w.event === spec.event);
  const confirmed = candidates.find((w) => configNamesUrl(w, url));
  const recorded = claimed ? candidates.find((w) => w.id === claimed.id) : undefined;
  const mine = confirmed ?? recorded ?? candidates[0] ?? null;
  const ownership: Ownership | null = !mine
    ? null
    : confirmed && mine.id === confirmed.id
      ? 'confirmed'
      : recorded && mine.id === recorded.id
        ? claimed?.adopted
          ? 'adopted'
          : 'recorded'
        : 'adopted';
  return { webhook: mine, ownership, duplicates: candidates.filter((w) => w.id !== mine?.id) };
}

export interface SyncWebhookResult {
  url: string | null;
  created: Array<{ boardId: string; event: string; id: string }>;
  existing: Array<{ boardId: string; event: string; id: string; ownership: Ownership }>;
  /** Existed with no record of ours: left in place, recorded, not duplicated. */
  adopted: Array<{ boardId: string; event: string; id: string }>;
  failed: Array<{ boardId: string; event: string; error: string }>;
  /**
   * Extra subscriptions on the same board and event beyond the one we hold — each
   * one makes monday post every event again. Reported with ids; removed only by an
   * explicit DELETE, because one of them may be somebody else's integration.
   */
  duplicates: Array<{ boardId: string; event: string; id: string; config: string | null }>;
  /** @deprecated kept for callers reading the old field; same rows as `duplicates`. */
  foreign: Array<{ boardId: string; event: string; id: string; config: string | null }>;
}

/**
 * Make monday's subscriptions match `desiredWebhooks()`.
 *
 * Idempotent, and idempotent for the right reason now: an existing subscription is
 * recognised by the id we recorded rather than by a URL monday does not report, so
 * running this on every deploy adds nothing after the first time.
 *
 * `dryRun` reports what it would do and writes nothing — neither to monday nor to
 * the claim log. `force` creates our own subscription even where one already exists
 * for that board and event, which is how you replace an adopted webhook you have
 * decided is not ours; expect to delete the old one afterwards.
 */
export async function syncWebhooks(
  dryRun = false,
  opts: { force?: boolean } = {},
): Promise<SyncWebhookResult> {
  const url = webhookUrl();
  const out: SyncWebhookResult = {
    url,
    created: [],
    existing: [],
    adopted: [],
    failed: [],
    duplicates: [],
    foreign: [],
  };
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
  const byBoard = new Map<string, MondayWebhook[]>();
  for (const b of [...new Set(specs.map((sp) => sp.boardId))]) {
    try {
      byBoard.set(b, await listWebhooks(b));
    } catch (err) {
      out.failed.push({ boardId: b, event: '-', error: `Could not list webhooks: ${String(err)}` });
    }
  }
  const claims = await loadClaims(url, specs).catch((err: unknown) => {
    logger.warn({ err }, 'could not read monday webhook claims');
    return new Map<string, { id: string; adopted: boolean }>();
  });

  for (const spec of specs) {
    const live = byBoard.get(spec.boardId);
    if (!live) continue;
    const { webhook, ownership, duplicates } = resolve(
      spec,
      live,
      claims.get(`${spec.boardId}:${spec.event}`),
      url,
    );
    for (const dup of duplicates) {
      const row = { boardId: spec.boardId, event: spec.event, id: dup.id, config: dup.config };
      out.duplicates.push(row);
      out.foreign.push(row);
    }

    if (webhook && !(opts.force && ownership === 'adopted')) {
      out.existing.push({
        boardId: spec.boardId,
        event: spec.event,
        id: webhook.id,
        ownership: ownership ?? 'adopted',
      });
      if (ownership === 'adopted') {
        out.adopted.push({ boardId: spec.boardId, event: spec.event, id: webhook.id });
        if (!dryRun) await recordClaim(url, spec, webhook.id, 'adopted');
        logger.warn(
          { boardId: spec.boardId, event: spec.event, id: webhook.id },
          'monday webhook adopted: exists for this board and event, ownership unverifiable',
        );
      }
      continue;
    }

    if (dryRun) continue;
    try {
      const id = await createWebhook(spec.boardId, url, spec.event);
      await recordClaim(url, spec, id, 'created');
      out.created.push({ boardId: spec.boardId, event: spec.event, id });
      logger.info({ boardId: spec.boardId, event: spec.event, id }, 'monday webhook registered');
    } catch (err) {
      out.failed.push({ boardId: spec.boardId, event: spec.event, error: String(err) });
      logger.error({ err, spec }, 'monday webhook registration failed');
    }
  }
  return out;
}

export interface WebhookStatus {
  url: string | null;
  /** Every subscription accounted for, and none of them duplicated. */
  ready: boolean;
  subscriptions: Array<{
    boardId: string;
    event: string;
    purpose: string;
    registered: boolean;
    id: string | null;
    /** How we know it is ours; `adopted` means we do not, strictly. */
    ownership: Ownership | null;
    /** Extra webhook ids on the same board and event. Each one doubles every event. */
    duplicateIds: string[];
  }>;
  error: string | null;
}

/**
 * What is subscribed right now, against what should be. The integrations screen
 * reads this, so "is monday actually going to tell us about a submission" is a
 * question with a visible answer rather than a trip into monday's settings.
 *
 * Read-only: it never records a claim, so a subscription showing `adopted` here
 * stays that way until a sync adopts it deliberately.
 */
export async function webhookStatus(): Promise<WebhookStatus> {
  const url = webhookUrl();
  const specs = desiredWebhooks();
  if (!env.MONDAY_API_TOKEN) {
    return {
      url,
      ready: false,
      subscriptions: specs.map((sp) => ({
        ...sp,
        registered: false,
        id: null,
        ownership: null,
        duplicateIds: [],
      })),
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
  const claims = url
    ? await loadClaims(url, specs).catch((err: unknown) => {
        error = error ?? `Could not read webhook claims: ${String(err)}`;
        return new Map<string, { id: string; adopted: boolean }>();
      })
    : new Map<string, { id: string; adopted: boolean }>();

  const subscriptions = specs.map((sp) => {
    if (!url)
      return { ...sp, registered: false, id: null, ownership: null, duplicateIds: [] as string[] };
    const { webhook, ownership, duplicates } = resolve(
      sp,
      byBoard.get(sp.boardId) ?? [],
      claims.get(`${sp.boardId}:${sp.event}`),
      url,
    );
    return {
      ...sp,
      registered: Boolean(webhook),
      id: webhook?.id ?? null,
      ownership,
      duplicateIds: duplicates.map((w) => w.id),
    };
  });

  return {
    url,
    ready:
      Boolean(url) &&
      !error &&
      subscriptions.every((x) => x.registered && x.duplicateIds.length === 0),
    subscriptions,
    error,
  };
}
