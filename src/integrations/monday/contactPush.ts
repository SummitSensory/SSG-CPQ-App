import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { isMondayPushConfigured } from '../../config/env.js';
import { setColumnValues } from './client.js';
import { DEALS_BOARD_ID, DEAL_COL } from './crmMapping.js';

export interface ContactForPush {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
}

export interface ContactPushResult {
  pushed: boolean;
  /** Why nothing was written, when `pushed` is false — not an error, just a no-op. */
  reason: string | null;
}

/**
 * Push a contact's name/email/phone/title onto the monday deal row that feeds
 * it, so a correction made here (typo'd email, wrong decision-maker) doesn't
 * silently drift from what the deal board shows the rest of the company.
 *
 * A contact has no monday item of its own on the default "deals" import path —
 * `crmImport.ts` reads it off columns on the org's Deal row, not a separate
 * Contacts-board item — so that Deal row (the most recently touched one linked
 * to this organization) is what gets written back to.
 *
 * Best effort, like every other monday write in this codebase (see
 * `dealReferences.ts`, `sync.ts`): a contact edit must save locally even when
 * monday can't be reached or the org has no linked deal, so failures are
 * logged and returned rather than thrown.
 */
export async function pushContactToDeal(
  organizationId: string,
  contact: ContactForPush,
): Promise<ContactPushResult> {
  if (!isMondayPushConfigured()) return { pushed: false, reason: 'monday not configured' };

  const opp = await prisma.opportunity.findFirst({
    where: { organizationId, mondayItemId: { not: null } },
    orderBy: { updatedAt: 'desc' },
    select: { mondayItemId: true },
  });
  if (!opp?.mondayItemId) return { pushed: false, reason: 'not linked to a monday deal row' };
  const itemId = opp.mondayItemId;

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  const cols: Record<string, unknown> = {};
  if (name) cols[DEAL_COL.contactName] = name;
  if (contact.title) cols[DEAL_COL.contactTitle] = contact.title;
  // monday's Email/Phone column types take a structured value, not a bare string.
  if (contact.email) cols[DEAL_COL.contactEmail] = { email: contact.email, text: contact.email };
  if (contact.phone) cols[DEAL_COL.contactPhone] = { phone: contact.phone, countryShortName: 'US' };

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
