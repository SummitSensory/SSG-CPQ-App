import { createHash } from 'node:crypto';
import type { PortalItemKind, PortalItemState, Prisma } from '@prisma/client';
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

  for (const r of rows) {
    let orderId = orderOfItem.get(r.id) ?? null;
    if (!orderId) {
      const unique = r.dealIds.filter((d) => rowsPerDeal.get(d) === 1);
      if (unique.length) orderId = await linkOrderByDeal(r.id, unique);
    }
    if (orderId && !byOrder.has(orderId)) byOrder.set(orderId, r);
  }
  return byOrder;
}

/** The delivery step's answers, as the order page shows them. */
function deliveryAnswers(sub: NonNullable<Awaited<ReturnType<typeof latestDeliveryForOrder>>>) {
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

interface Observation {
  state: PortalItemState;
  label: string | null;
  answers: unknown;
  sourceItemId: string | null;
  /** When the customer gave it, if the source says; otherwise "now". */
  givenAt: Date | null;
}

/** What each step looks like for one order right now. */
async function observe(
  orderId: string,
  row: MfgRow | null,
): Promise<Map<PortalItemKind, Observation>> {
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
  const sub = await latestDeliveryForOrder(orderId);
  if (sub) {
    out.set('DELIVERY', {
      state: 'PROVIDED',
      label: row?.labels.DELIVERY || '✅',
      answers: deliveryAnswers(sub),
      sourceItemId: sub.mondayItemId,
      givenAt: sub.submittedDate ?? sub.receivedAt,
    });
  }
  return out;
}

/** Upsert one order's steps. Returns how many changed. */
async function record(orderId: string, obs: Map<PortalItemKind, Observation>): Promise<number> {
  const existing = await prisma.orderPortalItem.findMany({ where: { orderId } });
  const byKind = new Map(existing.map((e) => [e.kind, e]));
  const now = new Date();
  let changed = 0;
  for (const [kind, o] of obs) {
    const hash = contentHashOf(o.state, o.answers);
    const prior = byKind.get(kind);
    if (prior && prior.contentHash === hash && prior.mondayStatus === o.label) {
      await prisma.orderPortalItem.update({
        where: { id: prior.id },
        data: { lastSyncedAt: now },
      });
      continue;
    }
    changed += 1;
    const moved = !prior || prior.contentHash !== hash;
    const data = {
      state: o.state,
      mondayStatus: o.label,
      answers: (o.answers ?? undefined) as Prisma.InputJsonValue | undefined,
      contentHash: hash,
      sourceItemId: o.sourceItemId,
      lastSyncedAt: now,
      // The date this version of the answers was obtained. Only a PROVIDED step
      // has one; a step going back to 🚫 keeps no date.
      ...(moved ? { obtainedAt: o.state === 'PROVIDED' ? (o.givenAt ?? now) : null } : {}),
    };
    if (prior) await prisma.orderPortalItem.update({ where: { id: prior.id }, data });
    else await prisma.orderPortalItem.create({ data: { orderId, kind, ...data } });
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

async function lastRefreshAt(): Promise<Date | null> {
  const row = await prisma.integrationSyncLog.findFirst({
    where: { entity: REFRESH_LOG_ENTITY, status: 'ok' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

/**
 * Refresh every order's portal steps from monday.
 *
 * Throttled to once a minute across every user and every server instance — the
 * throttle lives in the database, not in memory, because a serverless deployment
 * has many processes. `force` is the manual Refresh / Sync button.
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
  const last = await lastRefreshAt();
  if (!opts.force && last && Date.now() - last.getTime() < REFRESH_THROTTLE_MS) {
    return { ...blank, throttled: true, at: last.toISOString() };
  }
  // Claimed before the reads, so a second tab opening the page mid-refresh is
  // throttled rather than starting its own.
  await prisma.integrationSyncLog.create({
    data: { direction: 'INBOUND', entity: REFRESH_LOG_ENTITY, status: 'ok' },
  });

  try {
    // 1. Delivery submissions, through the ordinary ingest.
    const submissions: Record<string, number> = {};
    const rows = await fetchAllItems(deliveryBoardId(), 250, 500);
    for (const item of rows) {
      const hasAddress = item.text['text_mm57sf21'] || item.text['long_text_mm57vhh3'];
      const hasOrder = item.text['text_mm571ym4'];
      if (!hasAddress && !hasOrder) continue; // an invite row nobody has filled in
      const r = await ingestDeliverySubmission(item.id, { name: item.name, text: item.text });
      submissions[r] = (submissions[r] ?? 0) + 1;
    }

    // 2. Manufacturing rows → orders → steps.
    const mfg = await readManufacturingBoard(opts.fetchImpl);
    const byOrder = await linkRows(mfg);
    const withDelivery = await prisma.portalDeliverySubmission.findMany({
      where: { orderId: { not: null }, status: { in: ['APPLIED', 'CONFLICT'] } },
      select: { orderId: true },
      distinct: ['orderId'],
    });
    const orderIds = new Set<string>([
      ...byOrder.keys(),
      ...withDelivery.map((d) => d.orderId!).filter(Boolean),
    ]);
    let itemsChanged = 0;
    for (const orderId of orderIds) {
      itemsChanged += await record(orderId, await observe(orderId, byOrder.get(orderId) ?? null));
    }

    const at = new Date().toISOString();
    logger.info({ orders: orderIds.size, itemsChanged, submissions }, 'portal refresh: complete');
    return {
      refreshed: true,
      throttled: false,
      at,
      ordersLinked: byOrder.size,
      itemsChanged,
      submissions,
      error: null,
    };
  } catch (err) {
    logger.error({ err }, 'portal refresh failed');
    return { ...blank, error: err instanceof Error ? err.message : String(err) };
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
 */
export async function reviewPortalItem(
  orderId: string,
  kind: PortalItemKind,
  actorId: string,
): Promise<ReviewResult> {
  if (!PORTAL_KINDS.includes(kind)) throw new ValidationError(`"${kind}" is not a portal step`);
  const item = await prisma.orderPortalItem.findUnique({
    where: { orderId_kind: { orderId, kind } },
  });
  if (!item) throw new NotFoundError('Nothing has been received from the customer for this yet.');
  if (item.state !== 'PROVIDED') {
    throw new ConflictError('Only information the customer has provided can be marked reviewed.');
  }

  let colors: ColorApplyResult | null = null;
  if (kind === 'COLOR') colors = await applyColorPicksToOrder(orderId, item.answers, actorId);

  // Claimed on the hash that was read: answers that changed between the page
  // loading and this click are NOT marked reviewed.
  const claim = await prisma.orderPortalItem.updateMany({
    where: { id: item.id, contentHash: item.contentHash },
    data: { reviewedAt: new Date(), reviewedById: actorId, reviewedHash: item.contentHash },
  });
  if (!claim.count) {
    throw new ConflictError(
      'The customer changed this while you were reviewing it. Reload and review the new version.',
    );
  }

  let mondayNote: string | null = null;
  if (kind === 'DELIVERY' && item.sourceItemId) {
    mondayNote = await markSubmissionReviewedOnBoard(item.sourceItemId);
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
