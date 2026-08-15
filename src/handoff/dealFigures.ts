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
}

const EMPTY: DealFigures = {
  itemId: null,
  structureFreight: null,
  matsFreight: null,
  estimatedTax: null,
  error: null,
};

export async function dealFigures(orderId: string): Promise<DealFigures> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { mondayProjectId: true },
  });
  if (!order) throw new NotFoundError('Order not found');
  if (!order.mondayProjectId) {
    return { ...EMPTY, error: 'This order is not linked to a monday deal yet.' };
  }

  try {
    const item = await fetchItemById(order.mondayProjectId);
    if (!item) {
      return {
        ...EMPTY,
        itemId: order.mondayProjectId,
        error: 'That deal could not be found on the Deal Tracking board.',
      };
    }
    return {
      itemId: item.id,
      structureFreight: clean(item.text[DEAL_COL.structureFreight]),
      matsFreight: clean(item.text[DEAL_COL.matsFreight]),
      estimatedTax: clean(item.text[DEAL_COL.estimatedTax]),
      error: null,
    };
  } catch (err) {
    // Reported rather than thrown: the page still works with the figures typed by
    // hand, and an outage should read as "could not reach monday", not as a failure
    // of the Bill of Materials.
    logger.error({ err, orderId }, 'deal figures: monday read failed');
    return {
      ...EMPTY,
      itemId: order.mondayProjectId,
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
