import { prisma } from '../../lib/prisma.js';
import { findLink } from './links.js';

/**
 * Which monday deal row belongs to a customer.
 *
 * A proposal is filed against an ORGANIZATION, not against a deal — there is no
 * `Proposal.opportunityId` — so the deal has to be reached through the organization's
 * opportunities. This is the one place that decides how, because three callers need the
 * same answer and were arriving at it differently:
 *
 *   - releasing a proposal, to write the amount and the document back to the board
 *   - accepting a proposal, to record the deal on the order
 *   - pulling freight and tax onto a Bill of Materials
 *
 * The rule: the most recently updated opportunity that monday knows about, whether it
 * knows through `Opportunity.mondayItemId` or through an ExternalLink row. When nothing
 * is linked, a NOTE comes back rather than a guess — the caller decides whether that is
 * a failure or just a thing not to do.
 */
export interface DealLink {
  itemId?: string;
  /** The opportunity the id came from, so a caller can record the link properly. */
  opportunityId?: string;
  /** Why there is no id, in words a rep can act on. */
  note?: string;
}

export async function dealItemIdFor(organizationId: string): Promise<DealLink> {
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
    if (o.mondayItemId) return { itemId: o.mondayItemId, opportunityId: o.id };
    const link = await findLink({ entity: 'Opportunity', entityId: o.id });
    if (link?.externalId) return { itemId: link.externalId, opportunityId: o.id };
  }
  return { note: 'none of this customer’s opportunities are linked to a monday deal row yet' };
}
