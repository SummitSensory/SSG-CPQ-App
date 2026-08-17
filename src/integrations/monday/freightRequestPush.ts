import { prisma } from '../../lib/prisma.js';
import { isMondayPushConfigured } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { createSubitem } from './client.js';
import { dealItemIdFor } from './dealLink.js';

/**
 * Freight requests onto the Deal Tracking board.
 *
 * When an RFQ is emailed to a vendor, every item on it lands as its own SUBITEM
 * under that customer's deal row — one row per SKU, because the board reports on
 * freight per item and a single summary row cannot answer "what did we pay to ship
 * the A-2245?".
 *
 * Three rules:
 *
 *   1. **Only vendors who quote freight for us.** The gate is the same flag the RFQ
 *      itself is gated on, `Manufacturer.rfqEnabled` ("Can receive freight quote
 *      requests"). A vendor without it — Goldberg Brothers — never reaches the
 *      board, even if someone raises an RFQ against them by hand.
 *   2. **One-time.** The push is recorded in IntegrationSyncLog and a second send of
 *      the same request (a resubmission, a mislaid email) does not duplicate the
 *      rows. A REVISION is a different FreightRfq row and does push, which is
 *      correct: its contents differ.
 *   3. **Never fatal.** A vendor has the request in their inbox by the time this
 *      runs. An unreachable board cannot un-send that email, so the outcome comes
 *      back as data and is logged, never thrown.
 *
 * Vendor Freight Cost and Vendor Quote # are deliberately left EMPTY. Neither
 * exists when the request goes out — they arrive with the vendor's reply, on the
 * freight true-up (FreightTrueUp.vendorQuoteRef and the staged amounts). Writing a
 * zero into a currency column would read as "quoted at nothing", which is a
 * different and much worse statement than "not answered yet".
 */

/**
 * Subitem column ids under the Deal Tracking board (6527740233).
 *
 * Ids are per-board and opaque, exactly as in crmMapping.ts. Renaming a column in
 * monday keeps its id; DELETING and re-adding one changes it and this map must be
 * updated.
 */
export const FREIGHT_REQUEST_COL = {
  /** date — the day the request went to the vendor */
  requestDate: 'date_mm6ax0e',
  /** status — Vendor */
  vendor: 'color_mm6as6fp',
  /** text — SKU */
  sku: 'text_mm6a1k7v',
  /** numbers — Vendor Freight Cost; blank until the vendor quotes */
  vendorFreightCost: 'numeric_mm6aqhvt',
  /** text — Vendor Quote #; blank until the vendor quotes */
  vendorQuoteNumber: 'text_mm6ayr3q',
  /** status — Included in Signed Proposal */
  includedInSignedProposal: 'color_mm6a1naf',
  /** numbers — SKU Quantity */
  skuQuantity: 'numeric_mm6a9615',
} as const;

const ENTITY = 'FreightRfqMondayPush';

/** monday's date column wants YYYY-MM-DD in the board's own terms, not an ISO instant. */
function dateValue(d: Date): { date: string } {
  return { date: d.toISOString().slice(0, 10) };
}

/** A subitem name has a hard limit; a long product name must not fail the whole push. */
function subitemName(sku: string, name: string): string {
  const label = [sku, name].filter((p) => (p ?? '').trim()).join(' — ');
  return (label || 'Freight item').slice(0, 250);
}

export interface FreightRequestPushResult {
  pushed: boolean;
  /** The deal row the subitems were created under. */
  itemId?: string;
  /** monday ids of the subitems created, in line order. */
  subitemIds?: string[];
  /** Why nothing was pushed, in words a rep can act on. */
  skipped?: string;
  error?: string;
}

/** Has this request already been pushed? Idempotency, per rule 2. */
async function alreadyPushed(rfqId: string): Promise<boolean> {
  const prev = await prisma.integrationSyncLog.findFirst({
    where: { entity: ENTITY, entityId: rfqId, status: 'ok' },
    select: { id: true },
  });
  return !!prev;
}

/**
 * Push one sent RFQ's items to the deal row as subitems.
 *
 * Called from sendRfq after a successful send. Safe to call again — the second call
 * reports `skipped`.
 */
export async function pushFreightRequestToMonday(rfqId: string): Promise<FreightRequestPushResult> {
  if (!isMondayPushConfigured()) {
    return {
      pushed: false,
      skipped:
        'monday.com is not configured on this deployment — set MONDAY_API_TOKEN and MONDAY_DEALS_BOARD_ID.',
    };
  }

  const rfq = await prisma.freightRfq.findUnique({
    where: { id: rfqId },
    select: {
      id: true,
      vendor: true,
      reference: true,
      organizationId: true,
      manufacturerId: true,
      sentAt: true,
      createdAt: true,
      proposal: { select: { id: true, opportunityId: true } },
      lines: {
        where: { included: true },
        orderBy: { sortOrder: 'asc' },
        select: { sku: true, name: true, quantity: true },
      },
    },
  });
  if (!rfq) return { pushed: false, skipped: 'RFQ not found' };
  if (!rfq.lines.length) return { pushed: false, skipped: 'the request has no included items' };

  // Rule 1 — the vendor must be flagged to receive freight quote requests. An RFQ
  // can exist against a vendor without the flag (the builder lists every vendor on
  // the proposal so items can be added from anywhere); the board push cannot.
  const mfr = rfq.manufacturerId
    ? await prisma.manufacturer.findUnique({
        where: { id: rfq.manufacturerId },
        select: { name: true, rfqEnabled: true },
      })
    : await prisma.manufacturer.findFirst({
        where: { name: rfq.vendor },
        select: { name: true, rfqEnabled: true },
      });
  if (!mfr?.rfqEnabled) {
    return {
      pushed: false,
      skipped: `${rfq.vendor} is not set to receive freight quote requests, so nothing was written to the deal board`,
    };
  }

  if (await alreadyPushed(rfqId)) {
    return { pushed: false, skipped: `${rfq.reference} has already been pushed to the deal board` };
  }

  const { itemId, note } = await dealItemIdFor(rfq.organizationId, rfq.proposal.opportunityId);
  if (!itemId) return { pushed: false, skipped: note };

  /*
   * "Included in Signed Proposal" answers a question about the PROPOSAL, not about
   * the line: a request usually goes out before the customer signs, so this reads No
   * on the way out. It reads Yes only in the true-up case — freight quoted after a
   * signature, which is the whole reason freightTrueUp exists.
   */
  const accepted = await prisma.proposalVersion.findFirst({
    where: { proposalId: rfq.proposal.id, status: 'ACCEPTED' },
    select: { id: true },
  });
  const signedLabel = accepted ? 'Yes' : 'No';
  const requestDate = dateValue(rfq.sentAt ?? rfq.createdAt);

  const subitemIds: string[] = [];
  try {
    for (const line of rfq.lines) {
      const id = await createSubitem(itemId, subitemName(line.sku, line.name), {
        [FREIGHT_REQUEST_COL.requestDate]: requestDate,
        // Labels are created on demand: a new vendor must not fail the push because
        // nobody added their label to the column first.
        [FREIGHT_REQUEST_COL.vendor]: { label: mfr.name || rfq.vendor },
        [FREIGHT_REQUEST_COL.sku]: line.sku,
        [FREIGHT_REQUEST_COL.skuQuantity]: String(line.quantity),
        [FREIGHT_REQUEST_COL.includedInSignedProposal]: { label: signedLabel },
        // vendorFreightCost and vendorQuoteNumber stay empty — see the header note.
      });
      subitemIds.push(id);
    }

    await prisma.integrationSyncLog.create({
      data: {
        direction: 'OUTBOUND',
        entity: ENTITY,
        entityId: rfq.id,
        externalId: subitemIds.join(','),
        status: 'ok',
      },
    });
    logger.info(
      { rfqId, itemId, vendor: rfq.vendor, rows: subitemIds.length },
      'monday freight request push: subitems created',
    );
    return { pushed: true, itemId, subitemIds };
  } catch (err) {
    logger.error({ err, rfqId, itemId }, 'monday freight request push failed');
    await prisma.integrationSyncLog.create({
      data: {
        direction: 'OUTBOUND',
        entity: ENTITY,
        entityId: rfq.id,
        externalId: itemId,
        status: 'error',
        error: String(err),
      },
    });
    /*
     * Partial writes are reported rather than rolled back. Deleting rows a human may
     * already be reading is worse than leaving them: the log records how far it got,
     * and because no 'ok' row was written a later resend will try again — which will
     * duplicate the rows that did land. That trade is deliberate; a duplicate row is
     * visible and fixable, a silently missing one is not.
     */
    return { pushed: false, itemId, subitemIds, error: String(err) };
  }
}
