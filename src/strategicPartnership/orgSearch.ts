import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

/**
 * "Which customer is this for?" on a new Strategic Partnership proposal.
 *
 * Anyone in the CRM can be the subject of a partnership proposal — a prospect as much
 * as a customer — and every person in the CRM belongs to an organization. The picker
 * used /crm/organizations, which matches the organization's NAME only, so searching
 * for the person a rep was actually talking to ("Jen Gordon", jen@firefly…) or for the
 * deal ("Lakewood clinic") found nothing and read as "not a customer yet".
 *
 * This matches the organization name, a contact's name or email, or an opportunity's
 * name, and says which one matched, so a hit on a contact is recognisable as that
 * person's organization.
 */

export interface OrgSearchHit {
  id: string;
  name: string;
  customerType: string;
  /** Why this organization matched, when it was not by its own name. */
  via: { kind: 'contact' | 'opportunity'; label: string } | null;
}

const LIMIT = 10;
const ci = (value: string) => ({ contains: value, mode: 'insensitive' as const });

/** Every word of the query in the first or last name: "jen gordon", "gordon". */
function contactWhere(q: string): Prisma.ContactWhereInput {
  const words = q.split(/\s+/).filter(Boolean);
  return {
    OR: [
      { email: ci(q) },
      { AND: words.map((w) => ({ OR: [{ firstName: ci(w) }, { lastName: ci(w) }] })) },
    ],
  };
}

export async function searchPartnershipOrganizations(raw: string): Promise<OrgSearchHit[]> {
  const q = raw.trim().slice(0, 100);
  if (!q) return [];
  const contact = contactWhere(q);
  const opportunity: Prisma.OpportunityWhereInput = { name: ci(q) };
  const rows = await prisma.organization.findMany({
    where: {
      OR: [
        { name: ci(q) },
        { contacts: { some: contact } },
        { opportunities: { some: opportunity } },
      ],
    },
    select: {
      id: true,
      name: true,
      customerType: true,
      contacts: {
        where: contact,
        select: { firstName: true, lastName: true, email: true },
        orderBy: { lastName: 'asc' },
        take: 1,
      },
      opportunities: {
        where: opportunity,
        select: { name: true },
        orderBy: { updatedAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { name: 'asc' },
    // Over-fetch so name matches can be put first without losing them to the limit.
    take: LIMIT * 3,
  });
  const lower = q.toLowerCase();
  return rows
    .map((o): OrgSearchHit & { byName: boolean } => {
      const byName = o.name.toLowerCase().includes(lower);
      const c = o.contacts[0];
      const opp = o.opportunities[0];
      const via = byName
        ? null
        : c
          ? {
              kind: 'contact' as const,
              label: [`${c.firstName} ${c.lastName}`.trim(), c.email].filter(Boolean).join(' · '),
            }
          : opp
            ? { kind: 'opportunity' as const, label: opp.name }
            : null;
      return { id: o.id, name: o.name, customerType: o.customerType, via, byName };
    })
    .sort((a, b) => Number(b.byName) - Number(a.byName))
    .slice(0, LIMIT)
    .map(({ byName: _byName, ...hit }) => hit);
}
