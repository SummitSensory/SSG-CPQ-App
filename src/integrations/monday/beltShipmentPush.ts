import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { mondayQuery, setColumnValues } from './client.js';
import { searchItemsByName } from './discovery.js';
import { manufacturingBoardId } from './portalInvite.js';

/**
 * Belt packing slips onto the Manufacturing Process board.
 *
 * Every slip printed on the Belt Shipments tab lands as one SUBITEM, "UEU Belt(s)",
 * under the customer's Manufacturing row, so production can see a belt went out
 * without asking. Its fixed columns say what a belt shipment always is — shipped by
 * us, from our own stock, nothing to pay or quote:
 *
 *   Vendor "Internal" · SKU blank · Freight Cost "N/A" · Order Status "Obtained" ·
 *   Payment Status "N/A"
 *
 * Freight Carrier and Freight Tracking ID are filled in from the tab — usually after
 * the slip is printed, once the box is handed over — and written through to the same
 * subitem every time they change.
 *
 * Finding the row: the one recorded on the order (AcceptedOrder.portalOrderItemId)
 * when there is one. Otherwise by name — a Manufacturing row's name tracks its deal's
 * name (see manufacturingSnapshot.ts for how that was established), so the deal
 * item's name is searched first, then the customer's own name; the most recently
 * created match wins.
 *
 * Never fatal. The slip is already recorded and printed by the time this runs; an
 * unreachable board cannot un-print it. The outcome comes back as data, is kept on
 * the slip, and the next carrier/tracking save tries again.
 */

/** Subitem column ids under the Manufacturing Process board. Opaque and per-board. */
export const BELT_SUBITEM_COL = {
  /** status — Vendor */
  vendor: 'color_mm58zwvr',
  /** text — SKU (left blank: one slip can carry several belt sizes) */
  sku: 'text_mm587ez0',
  /** status — Freight Cost */
  freightCost: 'color_mm587bkw',
  /** status — Order Status */
  orderStatus: 'color_mm58wahg',
  /** status — Payment Status */
  paymentStatus: 'color_mm7nc8d1',
  /** status — Freight Carrier; its labels are the tab's dropdown options */
  carrier: 'color_mm51tf2w',
  /** text — Freight Tracking ID */
  tracking: 'text_mm5125q0',
} as const;

export const BELT_SUBITEM_NAME = 'UEU Belt(s)';

/**
 * The fixed values every belt subitem is created with. Labels are created on demand
 * (createSubitem sets create_labels_if_missing), so a label not yet on a column —
 * Order Status had no "Obtained" when this was written — is added rather than failing.
 */
const FIXED_VALUES = {
  [BELT_SUBITEM_COL.vendor]: { label: 'Internal' },
  [BELT_SUBITEM_COL.freightCost]: { label: 'N/A' },
  [BELT_SUBITEM_COL.orderStatus]: { label: 'Obtained' },
  [BELT_SUBITEM_COL.paymentStatus]: { label: 'N/A' },
} as const;

/**
 * Carrier options as of this writing — the fallback when monday cannot be read. The
 * live column is the source of truth (see carrierOptions).
 */
export const FALLBACK_CARRIERS = [
  'Not Shipped',
  'UPS',
  'FedEx',
  'FedEx Freight',
  'USPS',
  'T-Force Freight',
  'Estes Express Freight',
  'FitzMark',
  'ABF Freight',
  'Pitt Ohio Freight',
  'Amazon',
  'R_and_L_Freight',
];

const CARRIER_TTL_MS = 10 * 60 * 1000;
let carrierCache: { at: number; labels: string[] } | null = null;

/** The Manufacturing board's subitem board, which holds the subitem columns. */
async function subitemBoardId(): Promise<string | null> {
  const data = await mondayQuery<{
    boards: Array<{ columns: Array<{ settings_str: string }> }>;
  }>(
    `query ($board: [ID!]) { boards (ids: $board) { columns (types: [subtasks]) { settings_str } } }`,
    { board: [manufacturingBoardId()] },
  );
  const raw = data.boards[0]?.columns[0]?.settings_str;
  if (!raw) return null;
  const ids = (JSON.parse(raw) as { boardIds?: Array<string | number> }).boardIds ?? [];
  return ids[0] != null ? String(ids[0]) : null;
}

/**
 * The Freight Carrier dropdown's options: the live labels of the subitem column, in
 * the board's own order, so a carrier added on monday appears here with no deploy.
 */
export async function carrierOptions(): Promise<{ labels: string[]; live: boolean }> {
  if (carrierCache && Date.now() - carrierCache.at < CARRIER_TTL_MS) {
    return { labels: carrierCache.labels, live: true };
  }
  if (!env.MONDAY_API_TOKEN) return { labels: FALLBACK_CARRIERS, live: false };
  try {
    const board = await subitemBoardId();
    if (!board) return { labels: FALLBACK_CARRIERS, live: false };
    const data = await mondayQuery<{
      boards: Array<{ columns: Array<{ settings_str: string }> }>;
    }>(
      `query ($board: [ID!], $col: [String!]) {
         boards (ids: $board) { columns (ids: $col) { settings_str } }
       }`,
      { board: [board], col: [BELT_SUBITEM_COL.carrier] },
    );
    const raw = data.boards[0]?.columns[0]?.settings_str;
    if (!raw) return { labels: FALLBACK_CARRIERS, live: false };
    const settings = JSON.parse(raw) as {
      labels?: Array<{ label: string; index: number; is_deactivated?: boolean }>;
    };
    const labels = (settings.labels ?? [])
      .filter((l) => !l.is_deactivated && l.label.trim())
      .sort((a, b) => a.index - b.index)
      .map((l) => l.label);
    if (!labels.length) return { labels: FALLBACK_CARRIERS, live: false };
    carrierCache = { at: Date.now(), labels };
    return { labels, live: true };
  } catch (err) {
    logger.warn({ err }, 'belt shipment: could not read the Freight Carrier labels');
    return { labels: FALLBACK_CARRIERS, live: false };
  }
}

/** Test hook: forget the cached carrier labels. */
export function resetCarrierCache(): void {
  carrierCache = null;
}

/** The proposal meta frozen on an order — same reader as beltShipments.ts. */
function snapshotProjectId(snapshot: unknown): string {
  const snap = snapshot as { sections?: unknown } | null;
  const sections = Array.isArray(snap?.sections)
    ? (snap.sections as Array<Record<string, unknown>>)
    : [];
  const meta = sections.find((sec) => sec && sec.id === 'meta')?.data as
    Record<string, unknown> | undefined;
  return String(meta?.projectId ?? '').trim();
}

/**
 * What the slip's order already knows about monday: the Manufacturing row recorded on
 * it (AcceptedOrder.portalOrderItemId — exact, set once a portal submission or a PO
 * matched it), and the deal item — the order's Deal Tracking id, else the Project ID
 * on its accepted proposal, else the customer's most recently updated linked deal.
 */
async function orderLinksForSlip(
  lineIds: string[],
  orgId: string,
): Promise<{ mfgItemId: string | null; dealItemId: string | null }> {
  if (lineIds.length) {
    const line = await prisma.procurementLine.findFirst({
      where: { id: { in: lineIds } },
      select: {
        order: {
          select: { portalOrderItemId: true, mondayProjectId: true, contentSnapshot: true },
        },
      },
    });
    const mfgItemId = line?.order.portalOrderItemId || null;
    const own = String(line?.order.mondayProjectId ?? '').trim();
    if (/^d+$/.test(own)) return { mfgItemId, dealItemId: own };
    const fromProposal = snapshotProjectId(line?.order.contentSnapshot);
    if (/^d+$/.test(fromProposal)) return { mfgItemId, dealItemId: fromProposal };
    if (mfgItemId) return { mfgItemId, dealItemId: null };
  }
  if (orgId) {
    const opp = await prisma.opportunity.findFirst({
      where: { organizationId: orgId, mondayItemId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { mondayItemId: true },
    });
    if (opp?.mondayItemId) return { mfgItemId: null, dealItemId: opp.mondayItemId };
  }
  return { mfgItemId: null, dealItemId: null };
}

async function itemName(itemId: string): Promise<string | null> {
  const data = await mondayQuery<{ items: Array<{ name: string }> }>(
    `query ($items: [ID!]) { items (ids: $items) { name } }`,
    { items: [itemId] },
  );
  return data.items?.[0]?.name?.trim() || null;
}

/**
 * The customer's Manufacturing Process row: the one recorded on the order, else a
 * name search — the deal's name first, then the customer's.
 */
async function manufacturingRowFor(
  slip: SlipForPush,
): Promise<{ itemId: string | null; note: string }> {
  const terms: string[] = [];
  const links = await orderLinksForSlip(
    slip.lines.map((l) => l.lineId).filter(Boolean),
    slip.orgId,
  ).catch((err: unknown) => {
    logger.warn({ err, slip: slip.number }, 'belt shipment: order lookup failed');
    return { mfgItemId: null, dealItemId: null };
  });
  if (links.mfgItemId) return { itemId: links.mfgItemId, note: '' };
  const deal = links.dealItemId;
  if (deal) {
    const name = await itemName(deal).catch(() => null);
    if (name) terms.push(name);
  }
  if (slip.customer.trim()) terms.push(slip.customer.trim());

  for (const term of Array.from(new Set(terms))) {
    const matches = await searchItemsByName(manufacturingBoardId(), term, 25);
    if (!matches.length) continue;
    // Highest id = most recently created; monday ids increase account-wide.
    const item = matches.reduce((best, m) => (Number(m.id) > Number(best.id) ? m : best));
    return {
      itemId: item.id,
      note:
        matches.length > 1
          ? `Matched by name — ${matches.length} Manufacturing rows share “${term}”; the newest was used.`
          : '',
    };
  }
  return {
    itemId: null,
    note: `No Manufacturing Process row matches “${terms[0] ?? slip.customer}”, so no subitem was created.`,
  };
}

/** What this module needs from a slip. */
export interface SlipForPush {
  number: string;
  orgId: string;
  customer: string;
  carrier: string;
  trackingId: string;
  mondaySubitemId: string;
  mondaySubitemBoardId: string;
  lines: Array<{ lineId: string }>;
}

export interface BeltPushResult {
  /** The subitem, once it exists. */
  subitemId: string;
  subitemBoardId: string;
  /** Empty on a clean success; otherwise what happened, in words staff can act on. */
  note: string;
  ok: boolean;
}

/** Carrier and tracking as monday column values. An empty string clears a column. */
function freightValues(carrier: string, trackingId: string): Record<string, unknown> {
  return {
    [BELT_SUBITEM_COL.carrier]: carrier ? { label: carrier } : '',
    [BELT_SUBITEM_COL.tracking]: trackingId,
  };
}

/**
 * Make sure the slip has its subitem, and that the subitem's carrier and tracking
 * match the slip. Creates the subitem the first time; afterwards only the two
 * freight columns are written.
 */
export async function syncBeltSlipToMonday(slip: SlipForPush): Promise<BeltPushResult> {
  const keep = {
    subitemId: slip.mondaySubitemId,
    subitemBoardId: slip.mondaySubitemBoardId,
  };
  if (!env.MONDAY_API_TOKEN) {
    return { ...keep, ok: false, note: 'monday.com is not configured on this deployment.' };
  }

  try {
    if (slip.mondaySubitemId && slip.mondaySubitemBoardId) {
      await setColumnValues(
        slip.mondaySubitemBoardId,
        slip.mondaySubitemId,
        freightValues(slip.carrier, slip.trackingId),
      );
      return { ...keep, ok: true, note: '' };
    }

    const row = await manufacturingRowFor(slip);
    if (!row.itemId) return { ...keep, ok: false, note: row.note };

    const data = await mondayQuery<{ create_subitem: { id: string; board: { id: string } } }>(
      `mutation ($parent: ID!, $name: String!, $cols: JSON!) {
         create_subitem (
           parent_item_id: $parent,
           item_name: $name,
           column_values: $cols,
           create_labels_if_missing: true
         ) { id board { id } }
       }`,
      {
        parent: row.itemId,
        name: BELT_SUBITEM_NAME,
        cols: JSON.stringify({
          ...FIXED_VALUES,
          // SKU is deliberately written empty, not omitted, so a template default on
          // the board cannot fill it in.
          [BELT_SUBITEM_COL.sku]: '',
          ...(slip.carrier ? { [BELT_SUBITEM_COL.carrier]: { label: slip.carrier } } : {}),
          ...(slip.trackingId ? { [BELT_SUBITEM_COL.tracking]: slip.trackingId } : {}),
        }),
      },
    );
    logger.info(
      { slip: slip.number, parent: row.itemId, subitem: data.create_subitem.id },
      'belt shipment: Manufacturing subitem created',
    );
    return {
      subitemId: data.create_subitem.id,
      subitemBoardId: data.create_subitem.board.id,
      ok: true,
      note: row.note,
    };
  } catch (err) {
    logger.error({ err, slip: slip.number }, 'belt shipment: monday sync failed');
    return {
      ...keep,
      ok: false,
      note: 'Could not update monday.com just now. Save again to retry.',
    };
  }
}
