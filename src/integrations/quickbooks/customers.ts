import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { query, create } from './client.js';
import { toQboCustomer, type CustomerSource } from './mapping.js';
import { findLink, upsertLink, markLinkState } from './links.js';

const ENTITY = 'Customer';

interface QboCustomer { Id: string; SyncToken: string; DisplayName: string }

/** Escape a QuickBooks query string literal. */
function esc(s: string): string {
  return s.replace(/'/g, "\\'");
}

/**
 * Find or create the QuickBooks customer for a CPQ organization. Duplicate-safe:
 * (1) an existing QboEntityLink short-circuits; (2) otherwise we look the
 * customer up by DisplayName and adopt it if present; (3) only if neither exists
 * do we create one. The unique link constraint prevents a second customer even
 * under concurrent calls.
 */
export async function findOrCreateCustomer(
  organizationId: string,
  realmId: string,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ qboId: string; created: boolean }> {
  const ref = { entity: ENTITY, entityId: organizationId };
  const existing = await findLink(ref);
  if (existing) return { qboId: existing.qboId, created: false };

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: { addresses: true, contacts: { where: { isDecisionMaker: true }, take: 1 } },
  });
  if (!org) throw new Error(`Organization ${organizationId} not found`);

  const billing = org.addresses.find((a) => a.type === 'BILLING');
  const shipping = org.addresses.find((a) => a.type === 'SHIPPING');
  const src: CustomerSource = {
    displayName: org.name,
    email: org.contacts[0]?.email ?? null,
    billing: billing ? { line1: billing.line1, line2: billing.line2, city: billing.city, region: billing.region, postalCode: billing.postalCode, country: billing.country } : null,
    shipping: shipping ? { line1: shipping.line1, line2: shipping.line2, city: shipping.city, region: shipping.region, postalCode: shipping.postalCode, country: shipping.country } : null,
  };

  try {
    // (2) adopt an existing QuickBooks customer with the same DisplayName.
    const found = await query<{ Customer?: QboCustomer[] }>(
      realmId,
      `select Id, SyncToken, DisplayName from Customer where DisplayName = '${esc(org.name)}'`,
      fetchImpl,
    );
    const match = found.Customer?.[0];
    if (match) {
      await upsertLink(ref, match.Id, { syncToken: match.SyncToken });
      await log('OUTBOUND', ENTITY, organizationId, match.Id, 'ok', userId, 'adopted existing customer');
      return { qboId: match.Id, created: false };
    }

    // (3) create.
    const res = await create<{ Customer: QboCustomer }>(realmId, 'customer', toQboCustomer(src), `cust:${organizationId}`, fetchImpl);
    await upsertLink(ref, res.Customer.Id, { syncToken: res.Customer.SyncToken });
    await log('OUTBOUND', ENTITY, organizationId, res.Customer.Id, 'ok', userId, 'created customer');
    return { qboId: res.Customer.Id, created: true };
  } catch (err) {
    logger.error({ err, organizationId }, 'QuickBooks customer sync failed');
    await markLinkState(ref, 'ERROR');
    await log('OUTBOUND', ENTITY, organizationId, null, 'error', userId, String(err));
    throw err;
  }
}

async function log(direction: 'OUTBOUND' | 'INBOUND', entity: string, entityId: string | null, externalId: string | null, status: string, userId: string, note: string) {
  await prisma.integrationSyncLog.create({
    data: { provider: 'quickbooks', direction, entity, entityId, externalId, status, error: status === 'ok' ? null : note },
  });
}
