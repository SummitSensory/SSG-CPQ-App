import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { qboEnvironment } from '../../config/env.js';
import { query, create } from './client.js';
import { toQboCustomer, toQboCustomerUpdate, type CustomerSource } from './mapping.js';
import { findLink, upsertLink, markLinkState } from './links.js';
import { findQboCustomerByName, describeNameMatch } from './customerLookup.js';
import type { QboEnvironment } from '@prisma/client';

const ENTITY = 'Customer';

interface QboCustomer {
  Id: string;
  SyncToken: string;
  DisplayName: string;
  CompanyName?: string;
  Active?: boolean;
}

export interface CustomerSyncResult {
  qboId: string;
  created: boolean;
  /** Best contact email for the organisation, for BillEmail on documents. */
  email: string | null;
}

/** Escape a QuickBooks query string literal. */
function esc(s: string): string {
  return s.replace(/'/g, "\\'");
}

/**
 * Assemble everything CPQ knows about an organisation into the QuickBooks
 * customer shape. Prefers the decision-maker contact, falling back to any
 * contact that has an email — a customer profile with no email is close to
 * useless in QuickBooks.
 *
 * Exported so the profile comparison in `customerProfile.ts` builds the CPQ
 * side from this exact reader. A second copy of the same logic would drift, and
 * a comparison screen that disagrees with what the push actually sends is worse
 * than no comparison screen.
 */
export async function loadCustomerSource(
  organizationId: string,
): Promise<{ src: CustomerSource; email: string | null; billingFromShipping: boolean }> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      addresses: true,
      contacts: { orderBy: [{ isDecisionMaker: 'desc' }, { createdAt: 'asc' }] },
    },
  });
  if (!org) throw new Error(`Organization ${organizationId} not found`);

  const contact = org.contacts.find((c) => c.email) ?? org.contacts[0] ?? null;
  const billingRow = org.addresses.find((a) => a.type === 'BILLING') ?? null;
  const shipping = org.addresses.find((a) => a.type === 'SHIPPING') ?? null;

  // Most customers are billed where they are shipped, and the proposal already
  // works that way ("bill to same as ship to"). So a customer with one address on
  // record bills to it rather than pushing an invoice with an empty bill-to. A
  // BILLING row always wins — this is a fallback, never an override.
  const billing = billingRow ?? shipping;
  const billingFromShipping = !billingRow && !!shipping;

  const addr = (a: typeof billingRow) =>
    a
      ? {
          line1: a.line1,
          line2: a.line2,
          city: a.city,
          region: a.region,
          postalCode: a.postalCode,
          country: a.country,
        }
      : null;

  const src: CustomerSource = {
    displayName: org.name,
    companyName: org.name,
    email: contact?.email ?? null,
    phone: contact?.phone ?? null,
    contactFirstName: contact?.firstName ?? null,
    contactLastName: contact?.lastName ?? null,
    contactTitle: contact?.title ?? null,
    notes: org.notes ?? null,
    taxExempt: org.taxExempt,
    taxExemptId: org.taxExemptId,
    billing: addr(billing),
    shipping: addr(shipping),
  };
  return { src, email: contact?.email ?? null, billingFromShipping };
}

/**
 * Find or create the QuickBooks customer for a CPQ organization. Duplicate-safe:
 * (1) an existing QboEntityLink short-circuits; (2) otherwise we look the
 * customer up by DisplayName and adopt it if present; (3) only if neither exists
 * do we create one. The unique link constraint prevents a second customer even
 * under concurrent calls.
 *
 * `refresh: true` additionally pushes the current CRM profile onto an
 * already-linked customer (sparse update) — that is how the manual
 * "sync customer" action fills in fields that were missing when the customer was
 * first created. Document creation leaves it false so executing a transaction
 * stays a single fast path.
 */
export async function findOrCreateCustomer(
  organizationId: string,
  realmId: string,
  userId: string,
  fetchImpl: typeof fetch = fetch,
  opts: { refresh?: boolean } = {},
): Promise<CustomerSyncResult> {
  const ref = { entity: ENTITY, entityId: organizationId };
  const existing = await findLink(ref);

  if (existing && !opts.refresh) {
    const { email } = await loadCustomerSource(organizationId).catch(() => ({ email: null }));
    return { qboId: existing.qboId, created: false, email };
  }

  const { src, email } = await loadCustomerSource(organizationId);

  try {
    if (existing) {
      // Read the live SyncToken: QuickBooks rejects an update carrying a stale
      // one, and our cached copy can lag if the customer was edited in QBO.
      const current = await query<{ Customer?: QboCustomer[] }>(
        realmId,
        `select * from Customer where Id = '${esc(existing.qboId)}'`,
        fetchImpl,
      );
      const live = current.Customer?.[0];
      if (!live) throw new Error(`QuickBooks customer ${existing.qboId} no longer exists`);

      const res = await create<{ Customer: QboCustomer }>(
        realmId,
        'customer',
        toQboCustomerUpdate(src, live.Id, live.SyncToken),
        // SyncToken changes on every write, so this key is unique per revision
        // while still being stable for a retry of the SAME update.
        `cust:upd:${organizationId}:${live.SyncToken}`,
        fetchImpl,
      );
      await upsertLink(ref, res.Customer.Id, { syncToken: res.Customer.SyncToken });
      await log(
        'OUTBOUND',
        ENTITY,
        organizationId,
        res.Customer.Id,
        'ok',
        userId,
        'updated customer',
      );
      return { qboId: res.Customer.Id, created: false, email };
    }

    // (2) adopt an existing QuickBooks customer with the same name, then bring its
    // profile up to date with what CPQ knows. The match is not exact-only: a CRM name
    // imported from monday carries the deal code ("The Therapy Spot LLC (R-4MBL1Z)")
    // that the accountant's customer does not, and matching on equality alone missed it
    // and created a duplicate customer alongside the real one.
    //
    // Only an UNAMBIGUOUS EQUALITY match is adopted (see customerLookup.ts). A name that
    // merely starts the same way — "Soar Autism Center" against "Soar Autism Center -
    // Glendale" — is a different site with its own invoices, and adopting it would write
    // this customer's address and contact over theirs in the real books with no undo.
    // When the match is not safe to take automatically, fall through and create: a
    // duplicate customer is a tidy-up, overwriting the wrong customer is not.
    const nameMatch = await findQboCustomerByName<QboCustomer>(realmId, src.displayName, fetchImpl);
    if (nameMatch && !nameMatch.autoAdoptable) {
      logger.warn(
        {
          organizationId,
          candidateQboId: nameMatch.customer.Id,
          matchedOn: nameMatch.matchedOn,
          ambiguousCount: nameMatch.ambiguousCount ?? 1,
        },
        'quickbooks: a similarly-named customer exists but was not adopted automatically',
      );
      await log(
        'OUTBOUND',
        ENTITY,
        organizationId,
        nameMatch.customer.Id,
        'skipped',
        userId,
        `not adopted automatically — ${describeNameMatch(nameMatch)}`,
      );
    }
    const match = nameMatch?.autoAdoptable ? nameMatch.customer : null;
    if (match && nameMatch) {
      const res = await create<{ Customer: QboCustomer }>(
        realmId,
        'customer',
        toQboCustomerUpdate(src, match.Id, match.SyncToken),
        `cust:upd:${organizationId}:${match.SyncToken}`,
        fetchImpl,
      );
      await upsertLink(ref, res.Customer.Id, { syncToken: res.Customer.SyncToken });
      await log(
        'OUTBOUND',
        ENTITY,
        organizationId,
        res.Customer.Id,
        'ok',
        userId,
        `adopted existing customer: ${describeNameMatch(nameMatch)}`,
      );
      return { qboId: res.Customer.Id, created: false, email };
    }

    // (3) create.
    const res = await create<{ Customer: QboCustomer }>(
      realmId,
      'customer',
      toQboCustomer(src),
      `cust:${organizationId}`,
      fetchImpl,
    );
    await upsertLink(ref, res.Customer.Id, { syncToken: res.Customer.SyncToken });
    await log(
      'OUTBOUND',
      ENTITY,
      organizationId,
      res.Customer.Id,
      'ok',
      userId,
      'created customer',
    );
    return { qboId: res.Customer.Id, created: true, email };
  } catch (err) {
    logger.error({ err, organizationId }, 'QuickBooks customer sync failed');
    await markLinkState(ref, 'ERROR');
    await log('OUTBOUND', ENTITY, organizationId, null, 'error', userId, String(err));
    throw err;
  }
}

/**
 * Re-push the CRM profile onto an ALREADY-LINKED QuickBooks customer — used
 * after a contact edit so a corrected invoice email reaches QuickBooks without
 * anyone visiting Integrations to run the sync by hand.
 *
 * Deliberately does nothing for an organization that isn't a QuickBooks
 * customer yet: `findOrCreateCustomer` would happily create one, but a
 * customer record should come from issuing them a document, not from someone
 * fixing a typo on a contact card.
 */
export async function refreshCustomerIfLinked(
  organizationId: string,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const link = await findLink({ entity: ENTITY, entityId: organizationId });
  if (!link) return;
  const environment = qboEnvironment() as QboEnvironment;
  const conn = await prisma.qboConnection.findFirst({ where: { environment, isActive: true } });
  if (!conn) return;
  await findOrCreateCustomer(organizationId, conn.realmId, userId, fetchImpl, { refresh: true });
}

async function log(
  direction: 'OUTBOUND' | 'INBOUND',
  entity: string,
  entityId: string | null,
  externalId: string | null,
  status: string,
  _userId: string,
  note: string,
) {
  await prisma.integrationSyncLog.create({
    data: {
      provider: 'quickbooks',
      direction,
      entity,
      entityId,
      externalId,
      status,
      error: status === 'ok' ? null : note,
    },
  });
}
