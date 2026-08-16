import { prisma } from '../../lib/prisma.js';
import { findLink } from './links.js';

/**
 * Which monday deal row belongs to a customer.
 *
 * A proposal can name its own deal (`Proposal.opportunityId`), but it does not have to —
 * proposals are often written before an opportunity exists, and every proposal created
 * before the picker names none. So there are two paths to an answer, and this is the one
 * place that decides both, because three callers need the same answer and were arriving
 * at it differently:
 *
 *   - releasing a proposal, to write the amount and the document back to the board
 *   - accepting a proposal, to record the deal on the order
 *   - pulling freight and tax onto a Bill of Materials
 *
 * The rule, in order:
 *
 *   1. If the caller names an opportunity, that is the answer. A named deal is a stated
 *      fact and outranks anything inferable — for a customer running two concurrent
 *      projects it is the only way to be right. The id is checked against the
 *      organization so a stale or cross-tenant reference cannot pull in another
 *      customer's board row.
 *   2. Otherwise, the most recently updated opportunity that monday knows about, whether
 *      it knows through `Opportunity.mondayItemId` or through an ExternalLink row.
 *
 * When nothing is linked, a NOTE comes back rather than a guess — the caller decides
 * whether that is a failure or just a thing not to do. A named opportunity with no board
 * row still returns its `opportunityId` alongside the note, so an order can record which
 * deal it is for even when there is nothing on monday to point at yet.
 */
export interface DealLink {
  itemId?: string;
  /** The opportunity the id came from, so a caller can record the link properly. */
  opportunityId?: string;
  /** Why there is no id, in words a rep can act on. */
  note?: string;
  /**
   * True when the answer came from the fallback rather than from a named opportunity —
   * i.e. it is this customer's most recent linked deal, not a deal anyone chose. Callers
   * that put figures on a document surface this so a rep knows to check the job.
   */
  inferred?: boolean;
}

/** Resolve one opportunity to its monday row, through either linking mechanism. */
async function itemIdForOpportunity(opportunityId: string, mondayItemId: string | null) {
  if (mondayItemId) return mondayItemId;
  const link = await findLink({ entity: 'Opportunity', entityId: opportunityId });
  return link?.externalId ?? undefined;
}

export async function dealItemIdFor(
  organizationId: string,
  preferredOpportunityId?: string | null,
): Promise<DealLink> {
  // 1. The deal the proposal names, if it names one.
  if (preferredOpportunityId) {
    const chosen = await prisma.opportunity.findFirst({
      // Scoped to the organization on purpose: an id that does not belong to this
      // customer is treated as absent rather than followed.
      where: { id: preferredOpportunityId, organizationId },
      select: { id: true, name: true, mondayItemId: true },
    });
    if (chosen) {
      const itemId = await itemIdForOpportunity(chosen.id, chosen.mondayItemId);
      if (itemId) return { itemId, opportunityId: chosen.id, inferred: false };
      return {
        opportunityId: chosen.id,
        inferred: false,
        note: `the deal “${chosen.name}” is not linked to a monday row yet, so there is nothing to update`,
      };
    }
  }

  // 2. The customer's most recently updated linked deal.
  const opps = await prisma.opportunity.findMany({
    where: { organizationId },
    select: { id: true, name: true, mondayItemId: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (!opps.length) {
    return {
      note: 'this customer has no opportunity in the CRM, so there is no monday deal row to update',
    };
  }

  for (const o of opps) {
    const itemId = await itemIdForOpportunity(o.id, o.mondayItemId);
    if (itemId) return { itemId, opportunityId: o.id, inferred: true };
  }
  return { note: 'none of this customer’s opportunities are linked to a monday deal row yet' };
}
