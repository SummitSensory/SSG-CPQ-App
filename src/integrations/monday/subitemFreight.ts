import { prisma } from '../../lib/prisma.js';
import { isMondayPushConfigured } from '../../config/env.js';
import { mondayQuery } from './client.js';
import { FREIGHT_REQUEST_COL } from './freightRequestPush.js';
import { parseBoardMoney } from './boardMoney.js';

/**
 * Third-party freight, read back off the freight-request subitems.
 *
 * Sending an RFQ puts one subitem per SKU under the customer's deal row
 * (freightRequestPush.ts). When the vendor replies, the freight desk types the quote
 * into Vendor Freight Cost, and the board's own "Freight After Markup" formula adds
 * Summit's markup. This module reads that formula back, so the figure the desk
 * entered reaches the proposal without being typed a second time.
 *
 * What the board's figures mean, as the desk uses them:
 *
 *   - Vendor Freight Cost is the freight for the WHOLE line, not per unit: 100 floor
 *     tiles carry one shipping figure. It lands on the line as-is.
 *   - A cost of 0 is an answer — "no separate freight for this item", usually because
 *     it rides in another line's shipment. A BLANK cost is "not answered yet".
 *     The formula reads 0 for both, which is why the cost column is read as well.
 *   - "No Longer Interested" zeroes the formula: the customer dropped the item.
 *   - The markup lives in the formula and nowhere else. It is never re-applied here.
 *
 * A SKU can have several subitems — a revised request (" R2") or a resend (" S2")
 * adds rows. The most recently created row with an answer wins; a SKU with no
 * answered row at all is pending.
 */

/** "Freight After Markup" — Vendor Freight Cost × the markup, 0 when dropped. */
export const FREIGHT_AFTER_MARKUP_COL = 'formula_mm73ym5c';

/** The "Included in Signed Proposal" label that means the customer dropped the item. */
const DROPPED_LABEL = 'no longer interested';

/** One subitem, as read. */
export interface SubitemFreightRow {
  subitemId: string;
  name: string;
  createdAt: string;
  sku: string;
  rfqRef: string;
  vendor: string;
  quoteRef: string;
  /** Vendor Freight Cost. Null when blank — the vendor has not answered. */
  vendorCostMinor: number | null;
  /** Freight After Markup. Null when the formula has no value. */
  afterMarkupMinor: number | null;
  included: string;
}

export type SkuFreightState =
  /** Answered with a figure to charge. */
  | 'QUOTED'
  /** Answered with no separate freight for this item. */
  | 'ZERO'
  /** Requested, no answer yet. */
  | 'PENDING'
  /** Marked "No Longer Interested" on the board. */
  | 'DROPPED';

/** One SKU's answer, resolved across however many subitems it has. */
export interface SkuFreight {
  sku: string;
  name: string;
  state: SkuFreightState;
  /** Freight After Markup, in minor units. Set only when QUOTED. */
  amountMinor: number | null;
  vendor: string;
  rfqRef: string;
  quoteRef: string;
  subitemId: string;
}

/** "RFQ-12414494509-PS R2 S3" → "RFQ-12414494509-PS". */
export function rfqStem(reference: string): string {
  return String(reference ?? '')
    .trim()
    .replace(/(\s+[RS]\d+)+$/i, '')
    .toUpperCase();
}

const skuKey = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .toUpperCase();

/**
 * One answer per SKU. Pure, so the precedence rules are tested without a board.
 *
 * `stems` limits the rows to this proposal's requests; a deal row can carry
 * subitems from an earlier proposal for the same customer.
 */
export function resolveSkuFreight(
  rows: SubitemFreightRow[],
  stems?: Set<string> | null,
): SkuFreight[] {
  const bySku = new Map<string, SubitemFreightRow[]>();
  for (const r of rows) {
    const key = skuKey(r.sku);
    if (!key) continue;
    if (stems && stems.size && !stems.has(rfqStem(r.rfqRef))) continue;
    const list = bySku.get(key) ?? [];
    list.push(r);
    bySku.set(key, list);
  }

  const out: SkuFreight[] = [];
  for (const [sku, list] of bySku) {
    // Newest first; ties (rows written in the same second) fall back to the subitem
    // id, which monday allocates in increasing order.
    const sorted = [...list].sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        (BigInt(b.subitemId || '0') > BigInt(a.subitemId || '0') ? 1 : -1),
    );
    const answered = sorted.find((r) => r.vendorCostMinor != null);
    const row = answered ?? sorted[0]!;
    const base = {
      sku,
      name: row.name,
      vendor: row.vendor,
      rfqRef: row.rfqRef,
      quoteRef: row.quoteRef,
      subitemId: row.subitemId,
    };
    if (row.included.trim().toLowerCase() === DROPPED_LABEL) {
      out.push({ ...base, state: 'DROPPED', amountMinor: null });
    } else if (!answered) {
      out.push({ ...base, state: 'PENDING', amountMinor: null });
    } else if (answered.vendorCostMinor === 0) {
      out.push({ ...base, state: 'ZERO', amountMinor: null });
    } else if (answered.afterMarkupMinor == null || answered.afterMarkupMinor === 0) {
      // A cost with no marked-up figure: the formula column is missing or failing.
      // Treated as unanswered rather than guessing at the markup here.
      out.push({ ...base, state: 'PENDING', amountMinor: null });
    } else {
      out.push({ ...base, state: 'QUOTED', amountMinor: answered.afterMarkupMinor });
    }
  }
  return out.sort((a, b) => a.sku.localeCompare(b.sku));
}

const COLUMN_IDS = [
  FREIGHT_REQUEST_COL.sku,
  FREIGHT_REQUEST_COL.reference,
  FREIGHT_REQUEST_COL.vendor,
  FREIGHT_REQUEST_COL.vendorQuoteNumber,
  FREIGHT_REQUEST_COL.vendorFreightCost,
  FREIGHT_REQUEST_COL.includedInSignedProposal,
  FREIGHT_AFTER_MARKUP_COL,
];

interface RawSubitem {
  id: string;
  name: string;
  created_at: string;
  column_values: Array<{ id: string; text: string | null; display_value?: string | null }>;
}

function toRow(item: RawSubitem): SubitemFreightRow {
  const v: Record<string, string> = {};
  for (const c of item.column_values ?? []) {
    v[c.id] = String(c.display_value ?? c.text ?? '').trim();
  }
  return {
    subitemId: String(item.id),
    name: item.name ?? '',
    createdAt: item.created_at ?? '',
    sku: v[FREIGHT_REQUEST_COL.sku] ?? '',
    rfqRef: v[FREIGHT_REQUEST_COL.reference] ?? '',
    vendor: v[FREIGHT_REQUEST_COL.vendor] ?? '',
    quoteRef: v[FREIGHT_REQUEST_COL.vendorQuoteNumber] ?? '',
    vendorCostMinor: parseBoardMoney(v[FREIGHT_REQUEST_COL.vendorFreightCost]),
    afterMarkupMinor: parseBoardMoney(v[FREIGHT_AFTER_MARKUP_COL]),
    included: v[FREIGHT_REQUEST_COL.includedInSignedProposal] ?? '',
  };
}

const columnsFragment = `column_values (ids: [${COLUMN_IDS.map((c) => `"${c}"`).join(', ')}]) {
  id
  text
  ... on FormulaValue { display_value }
}`;

/** Read subitems by their own ids, 100 to a query (monday's page size for `items`). */
async function readSubitemsById(ids: string[], fetchImpl?: typeof fetch): Promise<RawSubitem[]> {
  const out: RawSubitem[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const data = await mondayQuery<{ items: RawSubitem[] }>(
      `query ($items: [ID!]) { items (ids: $items) { id name created_at ${columnsFragment} } }`,
      { items: ids.slice(i, i + 100) },
      fetchImpl,
    );
    out.push(...(data.items ?? []));
  }
  return out;
}

/** Every subitem under one deal row. */
async function readSubitemsOfItem(itemId: string, fetchImpl?: typeof fetch): Promise<RawSubitem[]> {
  const data = await mondayQuery<{ items: Array<{ subitems: RawSubitem[] | null }> }>(
    `query ($items: [ID!]) { items (ids: $items) { subitems { id name created_at ${columnsFragment} } } }`,
    { items: [itemId] },
    fetchImpl,
  );
  return data.items?.[0]?.subitems ?? [];
}

export interface ProposalSubitemFreight {
  /** False when the proposal has never sent a freight request — nothing to read. */
  requested: boolean;
  skus: SkuFreight[];
  readAt: string | null;
  error: string | null;
}

/**
 * The third-party freight the board holds for one proposal.
 *
 * Found two ways. The push records the ids of the subitems it created, so those are
 * read directly — exact, and indifferent to which deal row they were filed under.
 * When no push was recorded (it failed part-way, or predates the log), the deal
 * row's subitems are read instead and kept only if their RFQ ID is one of this
 * proposal's requests.
 *
 * Never throws: every caller has a screen that must still open when monday is down.
 */
export async function subitemFreightForProposal(
  proposalId: string,
  dealItemId: string | null,
  fetchImpl?: typeof fetch,
): Promise<ProposalSubitemFreight> {
  const rfqs = await prisma.freightRfq.findMany({
    where: { proposalId, status: { not: 'DRAFT' } },
    select: { id: true, reference: true },
  });
  if (!rfqs.length) return { requested: false, skus: [], readAt: null, error: null };
  if (!isMondayPushConfigured()) {
    return {
      requested: true,
      skus: [],
      readAt: null,
      error: 'monday.com is not configured on this deployment, so freight quotes cannot be read.',
    };
  }

  const stems = new Set(rfqs.map((r) => rfqStem(r.reference)));
  try {
    const pushes = await prisma.integrationSyncLog.findMany({
      where: {
        entity: 'FreightRfqMondayPush',
        entityId: { in: rfqs.map((r) => r.id) },
        status: 'ok',
      },
      select: { externalId: true },
    });
    const ids = [
      ...new Set(
        pushes.flatMap((p) =>
          String(p.externalId ?? '')
            .split(',')
            .map((x) => x.trim())
            .filter((x) => /^\d+$/.test(x)),
        ),
      ),
    ];
    let raw: RawSubitem[] = [];
    if (ids.length) raw = await readSubitemsById(ids, fetchImpl);
    else if (dealItemId) raw = await readSubitemsOfItem(dealItemId, fetchImpl);
    return {
      requested: true,
      skus: resolveSkuFreight(raw.map(toRow), stems),
      readAt: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    return {
      requested: true,
      skus: [],
      readAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
