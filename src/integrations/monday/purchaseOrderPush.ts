import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { createSubitem, mondayQuery, setColumnValues } from './client.js';
import {
  linkOrderByDeal,
  manufacturingBoardId,
  MFG_DEAL_LINK_COL,
  ordersForProjectIds,
} from './portalDelivery.js';

/**
 * A sent purchase order onto the Manufacturing Process board.
 *
 * The order's Manufacturing Process row carries one SUBITEM per part (Vendor, SKU,
 * Order Status, Purchase Order ID, Payment Status …). When a PO goes to a vendor,
 * every part on it is marked there:
 *
 *   Order Status       → "PO Sent to Mfg"
 *   Purchase Order ID  → the PO number, e.g. "PO-12414494509-TFH"
 *   Payment Status     → "Not Paid"
 *
 * Parts are matched to subitems by SKU. A part with no subitem yet gets one, so every
 * part that was ordered is tracked on the board — named the way the board names them
 * and carrying its SKU.
 *
 * Never fatal, exactly like the freight-request push: the vendor has the PO by the
 * time this runs, so an unreachable board is reported back as data and logged, never
 * thrown.
 */

/** Subitem column ids on the Manufacturing Process subitem board (6533701061). */
export const MFG_SUBITEM_COL = {
  /** text — SKU */
  sku: 'text_mm587ez0',
  /** status — Order Status */
  orderStatus: 'color_mm58wahg',
  /** text — Purchase Order ID */
  purchaseOrderId: 'text_mm7na5v3',
  /** status — Payment Status */
  paymentStatus: 'color_mm7nc8d1',
} as const;

export const PO_SENT_LABEL = 'PO Sent to Mfg';
export const NOT_PAID_LABEL = 'Not Paid';

export interface PurchaseOrderPushResult {
  pushed: boolean;
  itemId?: string;
  updated?: string[];
  created?: string[];
  skipped?: string;
  error?: string;
}

const norm = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .toUpperCase();

/**
 * The order's Manufacturing Process row: the one recorded on the order, else the one
 * row on the board linked to the order's deal. Recorded on the order when found, so
 * the next PO skips the board read.
 */
async function manufacturingItemFor(orderId: string, projectId: string): Promise<string | null> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { portalOrderItemId: true },
  });
  if (order?.portalOrderItemId) return order.portalOrderItemId;
  if (!/^\d+$/.test(projectId)) return null;

  // Only an unambiguous match: exactly one live order on this Project ID.
  const orders = await ordersForProjectIds([projectId]);
  if (orders.length !== 1 || orders[0]!.id !== orderId) return null;

  type Page = {
    cursor: string | null;
    items: Array<{ id: string; column_values: Array<{ linked_item_ids?: string[] | null }> }>;
  };
  const rows: string[] = [];
  let cursor: string | null = null;
  do {
    const data: { boards?: Array<{ items_page: Page }>; next_items_page?: Page } = cursor
      ? await mondayQuery(
          `query ($cursor: String!) { next_items_page (limit: 250, cursor: $cursor) { cursor items { id column_values (ids: ["${MFG_DEAL_LINK_COL}"]) { ... on BoardRelationValue { linked_item_ids } } } } }`,
          { cursor },
        )
      : await mondayQuery(
          `query ($board: [ID!]) { boards (ids: $board) { items_page (limit: 250) { cursor items { id column_values (ids: ["${MFG_DEAL_LINK_COL}"]) { ... on BoardRelationValue { linked_item_ids } } } } } }`,
          { board: [manufacturingBoardId()] },
        );
    const page: Page | undefined = cursor ? data.next_items_page : data.boards?.[0]?.items_page;
    for (const item of page?.items ?? []) {
      const linked = (item.column_values?.[0]?.linked_item_ids ?? []).map(String);
      if (linked.includes(projectId)) rows.push(item.id);
    }
    cursor = page?.cursor ?? null;
  } while (cursor);

  if (rows.length !== 1) return null;
  const linked = await linkOrderByDeal(rows[0]!, [projectId]);
  return linked === orderId ? rows[0]! : null;
}

export async function pushPurchaseOrderToMonday(poId: string): Promise<PurchaseOrderPushResult> {
  if (!env.MONDAY_API_TOKEN) return { pushed: false, skipped: 'monday is not configured' };
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!po) return { pushed: false, skipped: 'purchase order not found' };
  if (po.status !== 'SENT') return { pushed: false, skipped: 'purchase order has not been sent' };

  const itemId = await manufacturingItemFor(po.orderId, po.projectId);
  if (!itemId) {
    return {
      pushed: false,
      skipped:
        'No Manufacturing Process row is linked to this order, so the PO could not be recorded on monday.',
    };
  }

  const data = await mondayQuery<{
    items: Array<{
      subitems: Array<{
        id: string;
        board: { id: string } | null;
        column_values: Array<{ id: string; text: string | null }>;
      }> | null;
    }>;
  }>(
    `query ($items: [ID!]) { items (ids: $items) { subitems { id board { id } column_values (ids: ["${MFG_SUBITEM_COL.sku}"]) { id text } } } }`,
    { items: [itemId] },
  );
  const subitems = data.items?.[0]?.subitems ?? [];
  // Every subitem per SKU: the board does carry the same part twice on one row, and
  // both are the part that was just ordered.
  const bySku = new Map<string, Array<{ id: string; boardId: string }>>();
  for (const sub of subitems) {
    const sku = norm(sub.column_values.find((c) => c.id === MFG_SUBITEM_COL.sku)?.text);
    if (sku && sub.board?.id)
      bySku.set(sku, [...(bySku.get(sku) ?? []), { id: sub.id, boardId: sub.board.id }]);
  }

  const values = {
    [MFG_SUBITEM_COL.orderStatus]: { label: PO_SENT_LABEL },
    [MFG_SUBITEM_COL.purchaseOrderId]: po.reference,
    [MFG_SUBITEM_COL.paymentStatus]: { label: NOT_PAID_LABEL },
  };

  const updated: string[] = [];
  const created: string[] = [];
  const done = new Set<string>();
  for (const line of po.lines) {
    const key = norm(line.sku);
    // The same SKU twice on one PO is one part on the board.
    if (done.has(key)) continue;
    done.add(key);
    const matches = bySku.get(key) ?? [];
    if (matches.length) {
      for (const m of matches) await setColumnValues(m.boardId, m.id, values);
      updated.push(line.sku);
    } else {
      // Named the way the board names its subitems: the product, with the SKU in its column.
      const name = (line.name || line.sku).slice(0, 250);
      await createSubitem(itemId, name, { ...values, [MFG_SUBITEM_COL.sku]: line.sku });
      created.push(line.sku);
    }
  }
  logger.info({ poId, itemId, updated, created }, 'purchase order: recorded on monday');
  return { pushed: true, itemId, updated, created };
}
