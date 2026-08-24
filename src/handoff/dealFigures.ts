import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../lib/errors.js';
import { fetchItemById, textByColumnTitle } from '../integrations/monday/discovery.js';
import { DEAL_COL, clean } from '../integrations/monday/crmMapping.js';
import { dealItemIdFor } from '../integrations/monday/dealLink.js';
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

/**
 * Titles to look for when a mapped column id comes back empty.
 *
 * The structure freight figure lives in a MIRROR column on the Deal Tracking board
 * ("GB Freight $", locked). A mirror is the fragile kind of column: it can be
 * replaced without the id surviving, and then the vendor's sheet prints nothing and
 * says nothing is wrong. Matching on the title as a second attempt means the figure
 * has to be missing from the board itself before it goes missing from the sheet.
 */
const TITLE_FALLBACK = {
  structureFreight: /^\s*gb[\s-]*freight|structure[\s-]*freight/i,
  matsFreight: /^\s*r[\s-]*freight|mats?[\s-]*freight/i,
  estimatedTax: /^\s*r[\s-]*tax|estimated[\s-]*tax/i,
} as const;

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
 * Normally already answered: the accept flow resolves the deal and stores it on the
 * order, which is where that belongs. This is the repair path for orders accepted before
 * it did — it resolves through the shared rule and then STORES the result, so an order
 * fixes itself the first time someone pulls figures onto its Bill of Materials and no
 * backfill script is needed.
 */
async function resolveDealId(orderId: string): Promise<{ id: string | null; note: string | null }> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { mondayProjectId: true, opportunityId: true, organizationId: true },
  });
  if (!order) throw new NotFoundError('Order not found');
  if (order.mondayProjectId) return { id: order.mondayProjectId, note: null };

  const link = await dealItemIdFor(order.organizationId);
  if (!link.itemId) return { id: null, note: link.note ?? null };

  // Stored on first resolution, for the same reason a freight RFQ stores its project id:
  // the deal reference on a document must not drift if the board changes later.
  await prisma.acceptedOrder.update({
    where: { id: orderId },
    data: {
      mondayProjectId: link.itemId,
      ...(order.opportunityId ? {} : { opportunityId: link.opportunityId ?? null }),
    },
  });
  logger.info(
    { orderId, mondayProjectId: link.itemId },
    'deal figures: linked an order accepted before the link was recorded',
  );
  return {
    id: link.itemId,
    note: 'This order predates the deal link, so it was matched to this customer’s most recent monday deal. Check the figures are from the right job.',
  };
}

export async function dealFigures(orderId: string): Promise<DealFigures> {
  const link = await resolveDealId(orderId);
  if (!link.id) {
    return {
      ...EMPTY,
      error: `This order is not linked to a monday deal — ${link.note ?? 'no opportunity on this customer has one'}. Link the opportunity to its Deal Tracking row under CRM, then pull again.`,
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
    // The mapped id first, always: it is the column somebody chose. The title is
    // only consulted when that comes back empty, and the substitution is logged, so a
    // board change shows up in the logs as a fact rather than as a silent blank.
    const repaired: string[] = [];
    const figure = (key: keyof typeof TITLE_FALLBACK): string | null => {
      const mapped = clean(item.text[DEAL_COL[key]]);
      if (mapped) return mapped;
      const found = textByColumnTitle(item, TITLE_FALLBACK[key]);
      if (!found) return null;
      logger.warn(
        { orderId, key, mappedColumn: DEAL_COL[key], foundColumn: found.id },
        'deal figures: mapped column was empty, matched the figure by column title instead',
      );
      repaired.push(`${key} came from the column titled on the board, not ${DEAL_COL[key]}`);
      return found.text;
    };

    return {
      itemId: item.id,
      structureFreight: figure('structureFreight'),
      matsFreight: figure('matsFreight'),
      estimatedTax: figure('estimatedTax'),
      error: null,
      note: [link.note, ...repaired].filter(Boolean).join(' · ') || null,
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
