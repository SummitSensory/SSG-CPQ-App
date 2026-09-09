import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { isMondayPushConfigured } from '../../config/env.js';
import { setColumnValues } from './client.js';
import { DEALS_BOARD_ID, DEAL_COL } from './crmMapping.js';

export interface ContactPushResult {
  pushed: boolean;
  /** Why nothing was written, when `pushed` is false — not an error, just a no-op. */
  reason: string | null;
}

/**
 * Push the organization's current "the" contact — same resolution as
 * QuickBooks invoicing (`loadCustomerSource`: `isDecisionMaker` desc, then the
 * first with an email) — onto the monday deal row that feeds it.
 *
 * Takes only `organizationId`, not the contact just edited: the deal row has
 * ONE set of contact columns, so it must always reflect the org's actual
 * decision maker, never whichever contact record happened to be saved.
 * Editing a secondary contact's phone number used to push THAT contact's name
 * onto the deal row too, silently clobbering the real decision maker's name —
 * resolving fresh here is what makes an edit to any contact converge on the
 * same right answer instead of depending on which one was touched.
 *
 * A contact has no monday item of its own on the default "deals" import path —
 * `crmImport.ts` reads it off columns on the org's Deal row, not a separate
 * Contacts-board item — so that Deal row (the most recently touched one linked
 * to this organization) is what gets written back to.
 *
 * Every field is written explicitly, including when blank — the previous
 * version only ever set a column when the value was truthy, so clearing a
 * mistyped email or phone through the CRM left monday showing the old, wrong
 * value forever. An empty string is monday's own way of clearing these column
 * types.
 *
 * Best effort, like every other monday write in this codebase (see
 * `dealReferences.ts`, `sync.ts`): a contact edit must save locally even when
 * monday can't be reached or the org has no linked deal, so failures are
 * logged and returned rather than thrown.
 */
export async function pushContactToDeal(organizationId: string): Promise<ContactPushResult> {
  if (!isMondayPushConfigured()) return { pushed: false, reason: 'monday not configured' };

  const opp = await prisma.opportunity.findFirst({
    where: { organizationId, mondayItemId: { not: null } },
    orderBy: { updatedAt: 'desc' },
    select: { mondayItemId: true },
  });
  if (!opp?.mondayItemId) return { pushed: false, reason: 'not linked to a monday deal row' };
  const itemId = opp.mondayItemId;

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      contacts: {
        orderBy: [{ isDecisionMaker: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          title: true,
        },
      },
    },
  });
  const contact = org?.contacts.find((c) => c.email) ?? org?.contacts[0] ?? null;
  if (!contact) return { pushed: false, reason: 'organization has no contact' };

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  // monday's Email/Phone column types take a structured value, not a bare string;
  // an empty string in either shape is what clears the column.
  const cols: Record<string, unknown> = {
    [DEAL_COL.contactName]: name,
    [DEAL_COL.contactTitle]: contact.title ?? '',
    [DEAL_COL.contactEmail]: { email: contact.email ?? '', text: contact.email ?? '' },
    [DEAL_COL.contactPhone]: { phone: contact.phone ?? '', countryShortName: 'US' },
  };

  try {
    await setColumnValues(DEALS_BOARD_ID, itemId, cols);
    await prisma.integrationSyncLog.create({
      data: {
        provider: 'monday',
        direction: 'OUTBOUND',
        entity: 'Contact',
        entityId: contact.id,
        externalId: itemId,
        status: 'ok',
      },
    });
    return { pushed: true, reason: null };
  } catch (err) {
    logger.error({ err, organizationId, contactId: contact.id }, 'monday: contact push failed');
    await prisma.integrationSyncLog.create({
      data: {
        provider: 'monday',
        direction: 'OUTBOUND',
        entity: 'Contact',
        entityId: contact.id,
        externalId: itemId,
        status: 'error',
        error: String(err),
      },
    });
    return { pushed: false, reason: String(err) };
  }
}
