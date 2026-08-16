import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../lib/errors.js';
import { fetchItemById } from '../integrations/monday/discovery.js';
import { DEAL_COL, clean } from '../integrations/monday/crmMapping.js';
import { logger } from '../lib/logger.js';
import type { BomFreightSource } from '@prisma/client';

/**
 * The money figures that live on the deal rather than in this application.
 *
 * Freight is quoted as two figures on the Deal Tracking board because it ships as
 * two loads — the steel structure on one truck, the mats on another — and tax is a
 * third. All three are typed by whoever quoted them, on the board, and were being
 * re-typed onto the Bill of Materials by hand.
 *
 * This reads them; it never writes them. And it is deliberately NOT called while a
 * BOM page loads: monday being slow or unreachable must not stop an order from
 * opening, so the figures are pulled on demand and then stored on the section,
 * where they stay editable. A pulled figure is a starting point, not a contract.
 */

export interface DealFigures {
  /** The monday item the order is linked to, or null when it is not linked. */
  itemId: string | null;
  structureFreight: string | null;
  matsFreight: string | null;
  estimatedTax: string | null;
  /** Set when monday could not be reached, so the browser can say why. */
  error: string | null;
  /** A caveat worth showing even on success — e.g. the deal link had to be inferred. */
  note?: string | null;
}

const EMPTY: DealFigures = {
  itemId: null,
  structureFreight: null,
  matsFreight: null,
  estimatedTax: null,
  error: null,
  note: null,
};

/**
 * Which monday deal this order belongs to.
 *
 * `AcceptedOrder.mondayProjectId` is only ever set by an explicit call to
 * /orders/:id/integrations, and nothing in the accept flow calls it — so in practice
 * every order reported "not linked to a monday deal yet" and the freight pull could
 * never do anything. The link was always derivable: an order comes from a proposal,
 * which belongs to an opportunity, which is the deal.
 *
 * Resolved lazily and then STORED. Stored because the figures on a document must stay
 * traceable to one deal — the same reason FreightRfq keeps its projectId rather than
 * looking it up at render — and lazily because that fixes every order already in the
 * database without a backfill script.
 */
async function resolveDealId(orderId: string): Promise<{ id: string | null; note: string | null }> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { mondayProjectId: true, opportunityId: true, organizationId: true },
  });
  if (!order) throw new NotFoundError('Order not found');
  if (order.mondayProjectId) return { id: order.mondayProjectId, note: null };

  // The opportunity this order came from is the deal. Anything else is a guess.
  let found: string | null = null;
  if (order.opportunityId) {
    const opp = await prisma.opportunity.findUnique({
      where: { id: order.opportunityId },
      select: { mondayItemId: true },
    });
    found = opp?.mondayItemId ?? null;
  }

  // Failing that, the customer's most recent opportunity that IS linked. A customer
  // usually has one live deal, so this is right far more often than it is wrong — and
  // when it is wrong the figures are visibly from another job, which is noticeable in a
  // way that a silently empty pull is not.
  let guessed = false;
  if (!found) {
    const opp = await prisma.opportunity.findFirst({
      where: { organizationId: order.organizationId, mondayItemId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { mondayItemId: true },
    });
    found = opp?.mondayItemId ?? null;
    guessed = Boolean(found);
  }

  if (!found) return { id: null, note: null };

  await prisma.acceptedOrder.update({
    where: { id: orderId },
    data: { mondayProjectId: found },
  });
  logger.info({ orderId, mondayProjectId: found, guessed }, 'deal figures: linked order to deal');
  return {
    id: found,
    note: guessed
      ? 'Linked to this customer’s most recent monday deal. Check the figures are from the right job.'
      : null,
  };
}

export async function dealFigures(orderId: string): Promise<DealFigures> {
  const link = await resolveDealId(orderId);
  if (!link.id) {
    return {
      ...EMPTY,
      error:
        'This order is not linked to a monday deal, and no opportunity on this customer has a deal either. Link the opportunity to its Deal Tracking row under CRM, then pull again.',
    };
  }

  try {
    const item = await fetchItemById(link.id);
    if (!item) {
      return {
        ...EMPTY,
        itemId: link.id,
        error: 'That deal could not be found on the Deal Tracking board.',
      };
    }
    return {
      itemId: item.id,
      structureFreight: clean(item.text[DEAL_COL.structureFreight]),
      matsFreight: clean(item.text[DEAL_COL.matsFreight]),
      estimatedTax: clean(item.text[DEAL_COL.estimatedTax]),
      error: null,
      note: link.note,
    };
  } catch (err) {
    // Reported rather than thrown: the page still works with the figures typed by hand,
    // and an outage should read as "could not reach monday", not as a failure of the
    // Bill of Materials.
    logger.error({ err, orderId }, 'deal figures: monday read failed');
    return {
      ...EMPTY,
      itemId: link.id,
      error: err instanceof Error ? err.message : 'Could not reach monday.',
    };
  }
}

/** Which of the two freight figures belongs to a vendor quoting this way. */
export function freightFor(figures: DealFigures, source: BomFreightSource): string | null {
  if (source === 'MATS') return figures.matsFreight;
  if (source === 'NONE') return null;
  return figures.structureFreight;
}
