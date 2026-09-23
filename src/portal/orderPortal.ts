import { createHash } from 'node:crypto';
import { Prisma, type PortalItemKind, type PortalItemState } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../lib/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { mondayQuery } from '../integrations/monday/client.js';
import { fetchAllItems } from '../integrations/monday/discovery.js';
import {
  deliveryBoardId,
  ingestDeliverySubmission,
  isPortalDeliveryConfigured,
  latestDeliveryForOrder,
  linkOrderByDeal,
  ordersForProjectIds,
  processSubmission,
  manufacturingBoardId,
  markSubmissionReviewedOnBoard,
  MFG_DEAL_LINK_COL,
} from '../integrations/monday/portalDelivery.js';
import { applyColorPicksToOrder, type ColorApplyResult } from './colorAreas.js';

/**
 * Where each order's customer-portal steps stand — the columns on the Orders page.
 *
 * Two monday boards feed it:
 *
 *   - **Delivery & Site Details Submissions** — one row per delivery submission.
 *     Every row goes through the ordinary ingest (portalDelivery.ts), so a refresh,
 *     the webhook and a backfill all produce the same result.
 *   - **Manufacturing Process** — one row per job, with a "Portal: …" status column
 *     per step (✅ / 🚫 / N/A) and the customer's answers as JSON for delivery,
 *     billing and colours.
 *
 * A refresh reads each board ONCE, not once per order, links Manufacturing rows to
 * orders through their Deal connection (the Deal Tracking row id is the order's
 * Project ID), and upserts one OrderPortalItem per order per step.
 *
 * "Reviewed" is not stored as a state: an item is reviewed while `reviewedHash`
 * equals `contentHash`. New answers move the hash, so a customer who resubmits
 * after staff looked makes the item new again — with the new date — without any
 * code having to remember to un-review it.
 */

/** The step columns on the Manufacturing Process board, and each one's answers. */
export const MFG_PORTAL_COL: Record<PortalItemKind, { status: string; answers: string | null }> = {
  DELIVERY: { status: 'color_mm51j15w', answers: 'long_text_mm6a5z48' },
  COLOR: { status: 'color_mm51hjph', answers: 'long_text_mm6vj4d9' },
  BILLING: { status: 'color_mm51e5w9', answers: 'long_text_mm6ancsh' },
  CONTACT: { status: 'color_mm4ybgaa', answers: null },
  REQUIRED: { status: 'color_mm51yqbz', answers: null },
};

export const PORTAL_KINDS: PortalItemKind[] = [
  'DELIVERY',
  'COLOR',
  'BILLING',
  'CONTACT',
  'REQUIRED',
];

/** At most one board-wide refresh a minute, however many people have the page open. */
export const REFRESH_THROTTLE_MS = 60_000;
const REFRESH_LOG_ENTITY = 'portal-refresh';

/** monday's three labels. Blank (never set) reads as not given. */
export function stateFromLabel(label: string | null | undefined): PortalItemState {
  const t = String(label ?? '').trim();
  if (t === '✅') return 'PROVIDED';
  if (t.toUpperCase() === 'N/A') return 'NA';
  return 'NOT_PROVIDED';
}

/** A JSON answers cell, parsed. Anything unreadable is kept as text, never dropped. */
export function parseAnswers(text: string | null | undefined): unknown {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return { text: t };
  }
}

/** Key-order-independent JSON, so the hash only moves when an answer does. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function contentHashOf(state: PortalItemState, answers: unknown): string {
  return createHash('sha256')
    .update(`${state}|${stable(answers)}`)
    .digest('hex')
    .slice(0, 32);
}

/** What the Orders page shows for one step. */
export type PortalDisplay = 'NEW' | 'REVIEWED' | 'NONE' | 'NA';

export function displayOf(item: {
  state: PortalItemState;
  contentHash: string | null;
  reviewedHash: string | null;
}): PortalDisplay {
  if (item.state === 'NA') return 'NA';
  if (item.state !== 'PROVIDED') return 'NONE';
  return item.reviewedHash && item.reviewedHash === item.contentHash ? 'REVIEWED' : 'NEW';
}

/* ────────────────────────── reading the boards ────────────────────────── */

export interface MfgRow {
  id: string;
  name: string;
  dealIds: string[];
  labels: Record<PortalItemKind, string>;
  answers: Record<PortalItemKind, unknown>;
}

/** The Manufacturing Process board — only the columns this needs, 250 to a page. */
async function readManufacturingBoard(fetchImpl?: typeof fetch): Promise<MfgRow[]> {
  const ids = [
    MFG_DEAL_LINK_COL,
    ...PORTAL_KINDS.flatMap((k) =>
      [MFG_PORTAL_COL[k].status, MFG_PORTAL_COL[k].answers].filter(Boolean),
    ),
  ] as string[];
  const out: MfgRow[] = [];
  let cursor: string | null = null;
  do {
    const data: {
      boards: Array<{
        items_page: {
          cursor: string | null;
          items: Array<{
            id: string;
            name: string;
            column_values: Array<{
              id: string;
              text: string | null;
              linked_item_ids?: string[] | null;
            }>;
          }>;
        };
      }>;
    } = await mondayQuery(
      `query ($board: [ID!], $cursor: String) {
         boards (ids: $board) {
           items_page (limit: 250, cursor: $cursor) {
             cursor
             items {
               id
               name
               column_values (ids: [${ids.map((c) => `"${c}"`).join(', ')}]) {
                 id
                 text
                 ... on BoardRelationValue { linked_item_ids }
               }
             }
           }
         }
       }`,
      { board: [manufacturingBoardId()], cursor },
      fetchImpl,
    );
    const page = data.boards[0]?.items_page;
    if (!page) break;
    for (const item of page.items) {
      const byId = new Map(item.column_values.map((c) => [c.id, c]));
      const labels = {} as Record<PortalItemKind, string>;
      const answers = {} as Record<PortalItemKind, unknown>;
      for (const k of PORTAL_KINDS) {
        labels[k] = String(byId.get(MFG_PORTAL_COL[k].status)?.text ?? '').trim();
        const a = MFG_PORTAL_COL[k].answers;
        answers[k] = a ? parseAnswers(byId.get(a)?.text) : null;
      }
      out.push({
        id: String(item.id),
        name: item.name,
        dealIds: (byId.get(MFG_DEAL_LINK_COL)?.linked_item_ids ?? []).map(String),
        labels,
        answers,
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/* ────────────────────────── linking and recording ────────────────────────── */

/**
 * Manufacturing row → order. A recorded `portalOrderItemId` answers first; an
 * unlinked row is linked through its Deal only when that is unambiguous — one
 * Manufacturing row for the deal, and one live order carrying its Project ID.
 *
 * Two queries for the whole board, not one per row: most of the ~380 rows are
 * historic jobs that never link, and asking the database about each of them on
 * every refresh is how a refresh outlives a serverless time limit.
 */
async function linkRows(rows: MfgRow[]): Promise<Map<string, MfgRow>> {
  const byOrder = new Map<string, MfgRow>();
  const linked = await prisma.acceptedOrder.findMany({
    where: { portalOrderItemId: { in: rows.map((r) => r.id) } },
    select: { id: true, portalOrderItemId: true },
  });
  const orderOfItem = new Map(linked.map((o) => [o.portalOrderItemId!, o.id]));

  const rowsPerDeal = new Map<string, number>();
  for (const r of rows)
    for (const d of r.dealIds) rowsPerDeal.set(d, (rowsPerDeal.get(d) ?? 0) + 1);

  const unlinked = rows.filter((r) => !orderOfItem.has(r.id));
  const uniqueDeals = [
    ...new Set(unlinked.flatMap((r) => r.dealIds.filter((d) => rowsPerDeal.get(d) === 1))),
  ];
  // The order's Project ID, or the one on its accepted proposal when the order's own
  // copy was never recorded — see ordersForProjectIds.
  const candidates = await ordersForProjectIds(uniqueDeals);
  const ordersPerDeal = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const list = ordersPerDeal.get(c.projectId) ?? [];
    list.push(c);
    ordersPerDeal.set(c.projectId, list);
  }

  for (const r of rows) {
    let orderId = orderOfItem.get(r.id) ?? null;
    if (!orderId) {
      const matches = r.dealIds
        .filter((d) => rowsPerDeal.get(d) === 1)
        .flatMap((d) => ordersPerDeal.get(d) ?? []);
      // Exactly one order, not already claimed by a different Manufacturing row.
      if (matches.length === 1 && !matches[0]!.portalOrderItemId) {
        orderId = await linkOrderByDeal(r.id, [matches[0]!.projectId]);
      }
    }
    if (orderId && !byOrder.has(orderId)) byOrder.set(orderId, r);
  }
  return byOrder;
}

type Submission = NonNullable<Awaited<ReturnType<typeof latestDeliveryForOrder>>>;

/** The delivery step's answers, as the order page shows them. */
function deliveryAnswers(sub: Submission) {
  const d = (v: Date | null) => (v ? v.toISOString().slice(0, 10) : null);
  return {
    submittedDate: d(sub.submittedDate),
    addressConfirmed: sub.addressConfirmed,
    line1: sub.line1,
    line2: sub.line2,
    city: sub.city,
    region: sub.region,
    postalCode: sub.postalCode,
    country: sub.country,
    loadingDock: sub.loadingDock,
    deliveryTiming: sub.deliveryTiming,
    preferredDeliveryDate: d(sub.preferredDeliveryDate),
    specialInstructions: sub.specialInstructions,
    restrictedChanges: sub.restrictedChanges,
    pocName: sub.pocName,
    pocPhone: sub.pocPhone,
    pocEmail: sub.pocEmail,
    preferredComm: sub.preferredComm,
    textNumber: sub.textNumber,
    secondaryPocName: sub.secondaryPocName,
    secondaryPocPhone: sub.secondaryPocPhone,
    secondaryPocEmail: sub.secondaryPocEmail,
    secondaryPreferredComm: sub.secondaryPreferredComm,
    secondaryMobile: sub.secondaryMobile,
    freightAckBy: sub.freightAckBy,
    freightAckDate: d(sub.freightAckDate),
  };
}

/** Marks a step read from a submission row — the only kind that takes "Staff Reviewed". */
export const SUBMISSION_SOURCE = 'submission:';

interface Observation {
  state: PortalItemState;
  label: string | null;
  answers: unknown;
  sourceItemId: string | null;
  /** When the customer gave it, if the source says. */
  givenAt: Date | null;
}

/**
 * A monday date column is a calendar date, stored as UTC midnight. Shown in a US
 * time zone, midnight UTC is the previous evening, so the chip read a day early.
 * Noon UTC is the same calendar day everywhere from Hawaii to New Zealand.
 */
export function calendarDate(d: Date): Date {
  return new Date(d.toISOString().slice(0, 10) + 'T12:00:00.000Z');
}

/** What each step looks like for one order right now. */
function observe(row: MfgRow | null, sub: Submission | null): Map<PortalItemKind, Observation> {
  const out = new Map<PortalItemKind, Observation>();
  for (const k of PORTAL_KINDS) {
    if (!row) continue;
    const state = stateFromLabel(row.labels[k]);
    out.set(k, {
      state,
      label: row.labels[k] || null,
      answers: state === 'PROVIDED' ? row.answers[k] : null,
      sourceItemId: row.id,
      givenAt: null,
    });
  }
  // Delivery: a matched submission is the authority — it is what the BOM prints —
  // whatever the Manufacturing status says. Without one, the status decides.
  if (sub) {
    out.set('DELIVERY', {
      state: 'PROVIDED',
      label: row?.labels.DELIVERY || '✅',
      answers: deliveryAnswers(sub),
      sourceItemId: SUBMISSION_SOURCE + sub.mondayItemId,
      givenAt: sub.submittedDate ? calendarDate(sub.submittedDate) : sub.receivedAt,
    });
  }
  return out;
}

/**
 * When this version of a step's answers was obtained. The first time a step is
 * seen, that is when the customer gave it (the portal's Submitted Date) if the
 * source says. After that, a change is dated when the CRM saw it, unless the
 * source gives a newer date: an edit to the same submission keeps its Submitted
 * Date, and "New" beside an old date reads as though nothing happened. A step that
 * is not PROVIDED has no date.
 */
export function obtainedAtFor(
  state: PortalItemState,
  givenAt: Date | null,
  prior: { contentHash: string | null; obtainedAt: Date | null } | null,
  now: Date,
): Date | null {
  if (state !== 'PROVIDED') return null;
  if (!prior?.contentHash) return givenAt ?? now;
  if (givenAt && prior.obtainedAt && givenAt > prior.obtainedAt) return givenAt;
  return now;
}

type ItemRow = Awaited<ReturnType<typeof prisma.orderPortalItem.findMany>>[number];

/**
 * Upsert one order's steps against what is already stored. Returns how many
 * changed; unchanged items go into `touched` for one batched `lastSyncedAt`
 * update rather than an update each.
 */
async function record(
  orderId: string,
  obs: Map<PortalItemKind, Observation>,
  existing: ItemRow[],
  touched: string[],
): Promise<number> {
  const byKind = new Map(existing.map((e) => [e.kind, e]));
  const now = new Date();
  let changed = 0;
  for (const [kind, o] of obs) {
    const hash = contentHashOf(o.state, o.answers);
    const prior = byKind.get(kind) ?? null;
    if (prior && prior.contentHash === hash && prior.mondayStatus === o.label) {
      touched.push(prior.id);
      continue;
    }
    changed += 1;
    const moved = !prior || prior.contentHash !== hash;
    const obtainedAt = obtainedAtFor(o.state, o.givenAt, prior, now);
    const data = {
      state: o.state,
      mondayStatus: o.label,
      // Cleared, not left behind, when a step goes back to 🚫 or N/A.
      answers: o.answers == null ? Prisma.JsonNull : (o.answers as Prisma.InputJsonValue),
      contentHash: hash,
      sourceItemId: o.sourceItemId,
      lastSyncedAt: now,
      ...(moved ? { obtainedAt } : {}),
    };
    // Upsert, not find-then-create: two refreshes overlapping on one order must not
    // abort each other on the (orderId, kind) unique key.
    await prisma.orderPortalItem.upsert({
      where: { orderId_kind: { orderId, kind } },
      create: { orderId, kind, ...data, obtainedAt },
      update: data,
    });
  }
  return changed;
}

/* ────────────────────────── the refresh ────────────────────────── */

export interface PortalRefreshResult {
  refreshed: boolean;
  /** Set when a refresh ran recently and this one was skipped. */
  throttled: boolean;
  at: string | null;
  ordersLinked: number;
  itemsChanged: number;
  submissions: Record<string, number>;
  error: string | null;
}

/** A forced refresh still waits this long after the last one started. */
export const FORCED_MIN_INTERVAL_MS = 10_000;

/** The last refresh that finished. */
async function lastRefreshAt(): Promise<Date | null> {
  const row = await prisma.integrationSyncLog.findFirst({
    where: { entity: REFRESH_LOG_ENTITY, status: 'ok' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

/**
 * Claim this time window. `IntegrationSyncLog.eventId` is unique, so of two
 * refreshes starting in the same window exactly one insert succeeds — an atomic
 * claim across every server instance, which a read-then-write check is not. A
 * forced refresh claims a 10-second window, an automatic one a one-minute window.
 */
async function claimWindow(force: boolean): Promise<string | null> {
  const size = force ? FORCED_MIN_INTERVAL_MS : REFRESH_THROTTLE_MS;
  const eventId = `${REFRESH_LOG_ENTITY}:${force ? 'force' : 'auto'}:${Math.floor(Date.now() / size)}`;
  try {
    const row = await prisma.integrationSyncLog.create({
      data: { direction: 'INBOUND', entity: REFRESH_LOG_ENTITY, status: 'running', eventId },
      select: { id: true },
    });
    return row.id;
  } catch {
    return null; // another refresh holds this window
  }
}

/**
 * Refresh every order's portal steps from monday.
 *
 * Throttled across every user and every server instance: an automatic refresh
 * runs only when the last successful one finished over a minute ago, and at most
 * one starts per minute; a forced one (the Refresh / Sync buttons) at most one per
 * ten seconds. A run that fails is recorded as failed and does not hold the
 * throttle, so the next page open tries again.
 */
export async function refreshPortal(
  opts: { force?: boolean; actorId?: string; fetchImpl?: typeof fetch } = {},
): Promise<PortalRefreshResult> {
  const blank: PortalRefreshResult = {
    refreshed: false,
    throttled: false,
    at: null,
    ordersLinked: 0,
    itemsChanged: 0,
    submissions: {},
    error: null,
  };
  if (!isPortalDeliveryConfigured()) {
    return { ...blank, error: 'monday.com is not configured on this deployment.' };
  }
  const force = opts.force === true;
  const last = await lastRefreshAt();
  if (!force && last && Date.now() - last.getTime() < REFRESH_THROTTLE_MS) {
    return { ...blank, throttled: true, at: last.toISOString() };
  }
  const claim = await claimWindow(force);
  if (!claim) return { ...blank, throttled: true, at: last ? last.toISOString() : null };

  try {
    // 1. Delivery submissions, through the ordinary ingest. Same filter as the
    // backfill: a row with no street and nothing to read one out of is an invite
    // nobody has filled in, and storing it would leave a permanent INCOMPLETE row
    // for the retry sweep to re-read from monday forever. Rows already waiting on
    // something, and unchanged, are left to the retry sweep.
    const submissions: Record<string, number> = {};
    const rows = await fetchAllItems(deliveryBoardId(), 250, 500);
    for (const item of rows) {
      if (!item.text['text_mm57sf21'] && !item.text['long_text_mm57vhh3']) continue;
      const r = await ingestDeliverySubmission(
        item.id,
        { name: item.name, text: item.text },
        { skipUnchangedPending: true },
      );
      submissions[r] = (submissions[r] ?? 0) + 1;
    }

    // 2. Manufacturing rows → orders → steps, with every read batched.
    const mfg = await readManufacturingBoard(opts.fetchImpl);
    const byOrder = await linkRows(mfg);

    // A submission parked because its order could not be found is matchable the
    // moment its Manufacturing row is linked — which the step above may just have
    // done. Finish those now (database only, no monday reads) rather than leaving
    // the delivery details off the order until tomorrow's retry sweep.
    const linkedItemIds = [...byOrder.values()].map((r) => r.id);
    if (linkedItemIds.length) {
      const waiting = await prisma.portalDeliverySubmission.findMany({
        where: { status: 'PARKED', mondayOrderItemId: { in: linkedItemIds } },
        select: { id: true },
      });
      for (const w of waiting) {
        const r = await processSubmission(w.id);
        submissions[`retried:${r}`] = (submissions[`retried:${r}`] ?? 0) + 1;
      }
    }
    const subs = await prisma.portalDeliverySubmission.findMany({
      where: { orderId: { not: null }, status: { in: ['APPLIED', 'CONFLICT'] } },
      orderBy: [{ submittedDate: { sort: 'desc', nulls: 'last' } }, { receivedAt: 'desc' }],
    });
    const latestSub = new Map<string, Submission>();
    for (const s of subs) if (!latestSub.has(s.orderId!)) latestSub.set(s.orderId!, s);

    const orderIds = [...new Set<string>([...byOrder.keys(), ...latestSub.keys()])];
    const stored = orderIds.length
      ? await prisma.orderPortalItem.findMany({ where: { orderId: { in: orderIds } } })
      : [];
    const storedByOrder = new Map<string, ItemRow[]>();
    for (const s of stored) {
      const list = storedByOrder.get(s.orderId) ?? [];
      list.push(s);
      storedByOrder.set(s.orderId, list);
    }

    let itemsChanged = 0;
    const touched: string[] = [];
    for (const orderId of orderIds) {
      itemsChanged += await record(
        orderId,
        observe(byOrder.get(orderId) ?? null, latestSub.get(orderId) ?? null),
        storedByOrder.get(orderId) ?? [],
        touched,
      );
    }
    if (touched.length) {
      await prisma.orderPortalItem.updateMany({
        where: { id: { in: touched } },
        data: { lastSyncedAt: new Date() },
      });
    }

    await prisma.integrationSyncLog.update({ where: { id: claim }, data: { status: 'ok' } });
    logger.info(
      { orders: orderIds.length, itemsChanged, submissions, actorId: opts.actorId },
      'portal refresh: complete',
    );
    return {
      refreshed: true,
      throttled: false,
      at: new Date().toISOString(),
      ordersLinked: byOrder.size,
      itemsChanged,
      submissions,
      error: null,
    };
  } catch (err) {
    logger.error({ err }, 'portal refresh failed');
    const message = err instanceof Error ? err.message : String(err);
    await prisma.integrationSyncLog
      .update({ where: { id: claim }, data: { status: 'error', error: message } })
      .catch(() => undefined);
    return { ...blank, error: message };
  }
}

/* ────────────────────────── one order ────────────────────────── */

export interface PortalItemView {
  kind: PortalItemKind;
  display: PortalDisplay;
  mondayStatus: string | null;
  answers: unknown;
  obtainedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  lastSyncedAt: string | null;
  /** The version on screen. Sent back with "Mark reviewed" so only that version is marked. */
  contentHash: string | null;
}

/** Every step for one order, in column order, including steps never seen ("-"). */
export async function portalItemsForOrder(orderId: string): Promise<PortalItemView[]> {
  const rows = await prisma.orderPortalItem.findMany({ where: { orderId } });
  const reviewerIds = [...new Set(rows.map((r) => r.reviewedById).filter(Boolean))] as string[];
  const reviewers = reviewerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: reviewerIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = new Map(reviewers.map((u) => [u.id, u.name]));
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return PORTAL_KINDS.map((kind) => {
    const r = byKind.get(kind);
    return {
      kind,
      display: r ? displayOf(r) : 'NONE',
      mondayStatus: r?.mondayStatus ?? null,
      answers: r?.answers ?? null,
      obtainedAt: r?.obtainedAt ? r.obtainedAt.toISOString() : null,
      reviewedAt: r?.reviewedAt ? r.reviewedAt.toISOString() : null,
      reviewedBy: r?.reviewedById ? (nameOf.get(r.reviewedById) ?? null) : null,
      lastSyncedAt: r?.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
      contentHash: r?.contentHash ?? null,
    };
  });
}

/** The compact form the Orders list carries per row. */
export async function portalSummaryForOrders(
  orderIds: string[],
): Promise<
  Map<string, Record<PortalItemKind, { display: PortalDisplay; obtainedAt: string | null }>>
> {
  const rows = orderIds.length
    ? await prisma.orderPortalItem.findMany({
        where: { orderId: { in: orderIds } },
        select: {
          orderId: true,
          kind: true,
          state: true,
          contentHash: true,
          reviewedHash: true,
          obtainedAt: true,
        },
      })
    : [];
  const out = new Map<
    string,
    Record<PortalItemKind, { display: PortalDisplay; obtainedAt: string | null }>
  >();
  for (const id of orderIds) {
    const blank = {} as Record<
      PortalItemKind,
      { display: PortalDisplay; obtainedAt: string | null }
    >;
    for (const k of PORTAL_KINDS) blank[k] = { display: 'NONE', obtainedAt: null };
    out.set(id, blank);
  }
  for (const r of rows) {
    const entry = out.get(r.orderId);
    if (entry) {
      entry[r.kind] = {
        display: displayOf(r),
        obtainedAt: r.obtainedAt ? r.obtainedAt.toISOString() : null,
      };
    }
  }
  return out;
}

export interface ReviewResult {
  item: PortalItemView;
  /** Delivery: why "Staff Reviewed" could not be ticked on monday, if it could not. */
  mondayNote: string | null;
  /** Colour: what the picks did to the Bill of Materials. */
  colors: ColorApplyResult | null;
}

/**
 * Mark one step reviewed. Records WHICH version was reviewed (the hash), so new
 * answers make it new again. Delivery also ticks Staff Reviewed on monday; colour
 * also applies the picks to the Bill of Materials through the area mapping.
 *
 * `seenHash` is the version the person was looking at. A refresh in another tab
 * can replace the answers after the page loaded; without this, clicking Mark
 * reviewed would approve — and for colour, apply to the BOM — answers nobody saw.
 */
export async function reviewPortalItem(
  orderId: string,
  kind: PortalItemKind,
  actorId: string,
  seenHash: string,
): Promise<ReviewResult> {
  if (!PORTAL_KINDS.includes(kind)) throw new ValidationError(`"${kind}" is not a portal step`);
  const item = await prisma.orderPortalItem.findUnique({
    where: { orderId_kind: { orderId, kind } },
  });
  if (!item) throw new NotFoundError('Nothing has been received from the customer for this yet.');
  if (item.state !== 'PROVIDED') {
    throw new ConflictError('Only information the customer has provided can be marked reviewed.');
  }

  const stale = new ConflictError(
    'The customer changed this since the page loaded. Reload and review the new version.',
  );
  if (!seenHash || item.contentHash !== seenHash) throw stale;
  if (item.reviewedHash === item.contentHash) {
    // Already reviewed — by someone else, or in another tab. Reviewing again would
    // re-apply colours over corrections made since the first review.
    throw new ConflictError('This version has already been marked reviewed. Reload to see it.');
  }

  // Claim FIRST, on the version that was seen and while it is still unreviewed, so
  // two clicks cannot both win and nothing is applied for a version that lost.
  const prior = {
    reviewedAt: item.reviewedAt,
    reviewedById: item.reviewedById,
    reviewedHash: item.reviewedHash,
  };
  const claim = await prisma.orderPortalItem.updateMany({
    where: { id: item.id, contentHash: seenHash, reviewedHash: item.reviewedHash },
    data: { reviewedAt: new Date(), reviewedById: actorId, reviewedHash: seenHash },
  });
  if (!claim.count) throw stale;

  let colors: ColorApplyResult | null = null;
  if (kind === 'COLOR') {
    try {
      colors = await applyColorPicksToOrder(orderId, item.answers, actorId);
    } catch (err) {
      // The picks did not reach the BOM, so the review does not stand either.
      await prisma.orderPortalItem.update({ where: { id: item.id }, data: prior });
      throw err;
    }
  }

  // Only a delivery SUBMISSION row takes "Staff Reviewed"; a delivery step read from
  // the Manufacturing status has no submission to tick.
  let mondayNote: string | null = null;
  if (kind === 'DELIVERY' && item.sourceItemId?.startsWith(SUBMISSION_SOURCE)) {
    mondayNote = await markSubmissionReviewedOnBoard(
      item.sourceItemId.slice(SUBMISSION_SOURCE.length),
    );
  }

  await prisma.orderEvent.create({
    data: {
      orderId,
      action: 'portal.review',
      actorId,
      detail: { kind, contentHash: item.contentHash, mondayNote, colors } as object,
    },
  });
  await recordAudit({
    actorId,
    action: 'portal.review',
    entity: 'AcceptedOrder',
    entityId: orderId,
    details: { kind },
  });

  const view = (await portalItemsForOrder(orderId)).find((v) => v.kind === kind)!;
  return { item: view, mondayNote, colors };
}
