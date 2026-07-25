import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { normalizeOrgName } from '../../crm/duplicates.js';
import { fetchAllItems, type MondayItem } from './discovery.js';
import {
  ORGANIZATIONS_BOARD_ID,
  CONTACTS_BOARD_ID,
  ORG_COL,
  CONTACT_COL,
  toCustomerType,
  isDecisionMaker,
  buildAddress,
  parseEmail,
  parseLinkedIds,
  parseProjectId,
  splitName,
} from './crmMapping.js';

/**
 * Import organizations and contacts FROM monday INTO the CPQ.
 *
 * monday is the system of record for who the customer is; the CPQ is the
 * system of record for what was quoted. So this import is inbound-only and
 * never writes back.
 *
 * The columns pulled are the ones listed in "Monday Column Mapping.xlsx":
 * industry, primary-contact name/email/phone, the split address columns,
 * country, and Project ID — all read off the Organizations row. The primary
 * contact therefore does NOT depend on the Contacts board's account link,
 * which is empty on many rows.
 *
 * Idempotent: every imported record is linked by ExternalLink
 * (provider 'monday', entity 'Organization' | 'Contact', externalId = monday
 * item id), so a second run updates in place instead of duplicating. An
 * organization that already exists in the CPQ under the same normalized name
 * is adopted rather than duplicated.
 *
 * Dry-run mode reports exactly what would change and writes nothing.
 */

const PROVIDER = 'monday';

export interface ImportOptions {
  dryRun?: boolean;
  /** Cap items processed per board — for a first look at a large board. */
  limit?: number;
  /** Skip the Contacts board entirely. */
  organizationsOnly?: boolean;
}

export interface ImportCounts {
  organizations: { seen: number; created: number; updated: number; adopted: number; skipped: number };
  /** Primary contacts read off the Organizations row (mapping sheet columns). */
  primaryContacts: { created: number; updated: number; skipped: number };
  contacts: { seen: number; created: number; updated: number; skipped: number; unlinked: number };
  addresses: { created: number };
  projectIds: { present: number };
}

export interface ImportResult extends ImportCounts {
  dryRun: boolean;
  durationMs: number;
  warnings: string[];
}

function emptyCounts(): ImportCounts {
  return {
    organizations: { seen: 0, created: 0, updated: 0, adopted: 0, skipped: 0 },
    primaryContacts: { created: 0, updated: 0, skipped: 0 },
    contacts: { seen: 0, created: 0, updated: 0, skipped: 0, unlinked: 0 },
    addresses: { created: 0 },
    projectIds: { present: 0 },
  };
}

const trim = (v: string | undefined | null): string | null => {
  const t = (v ?? '').trim();
  return t && t !== '-' ? t : null;
};

async function linkFor(entity: string, externalId: string) {
  return prisma.externalLink.findFirst({ where: { provider: PROVIDER, entity, externalId } });
}

async function saveLink(entity: string, entityId: string, externalId: string, boardId: string) {
  await prisma.externalLink.upsert({
    where: { provider_entity_entityId: { provider: PROVIDER, entity, entityId } },
    update: { externalId, boardId, lastSyncedAt: new Date(), state: 'LINKED' },
    create: {
      provider: PROVIDER,
      entity,
      entityId,
      externalId,
      boardId,
      lastSyncedAt: new Date(),
      state: 'LINKED',
    },
  });
}

/** Project ID has no column on Organization, so it is carried in notes. */
function buildNotes(item: MondayItem, projectId: string | null): string | null {
  const website = trim(item.text[ORG_COL.website]);
  const description = trim(item.text[ORG_COL.description]);
  return (
    [
      description,
      website ? `Website: ${website}` : null,
      projectId ? `Project ID: ${projectId}` : null,
    ]
      .filter(Boolean)
      .join('\n') || null
  );
}

async function writeAddressIfMissing(
  item: MondayItem,
  organizationId: string,
  orgName: string,
  counts: ImportCounts,
  dryRun: boolean,
): Promise<void> {
  const addr = buildAddress(item.text, item.raw[ORG_COL.location]);
  if (!addr || !(addr.line1 || addr.city)) return;

  if (dryRun) {
    counts.addresses.created += 1;
    return;
  }
  const existing = await prisma.address.count({ where: { organizationId } });
  if (existing > 0) return;

  await prisma.address.create({
    data: {
      organizationId,
      type: 'SHIPPING',
      line1: addr.line1 ?? addr.city ?? orgName,
      line2: addr.line2 ?? null,
      city: addr.city ?? '',
      region: addr.region ?? '',
      postalCode: addr.postalCode ?? '',
      country: addr.country,
    },
  });
  counts.addresses.created += 1;
}

/**
 * The primary contact comes off the Organizations row (Full Name / Email /
 * Direct phone number), so it exists even when the Contacts board's account
 * link is empty. Matched on email first, then on name within the org.
 */
async function upsertPrimaryContact(
  item: MondayItem,
  organizationId: string,
  counts: ImportCounts,
  dryRun: boolean,
): Promise<void> {
  const fullName = trim(item.text[ORG_COL.primaryContactName]);
  const email = parseEmail(
    item.raw[ORG_COL.primaryContactEmail],
    item.text[ORG_COL.primaryContactEmail] ?? '',
  );
  const phone = trim(item.text[ORG_COL.primaryContactPhone]);

  if (!fullName && !email) {
    counts.primaryContacts.skipped += 1;
    return;
  }

  const { first, last } = splitName(fullName ?? email ?? '', '');
  const data = {
    firstName: first,
    lastName: last,
    email,
    phone,
    title: null as string | null,
    isDecisionMaker: true,
  };

  if (dryRun || organizationId.startsWith('dry-')) {
    counts.primaryContacts.created += 1;
    return;
  }

  const existing = await prisma.contact.findFirst({
    where: email
      ? { organizationId, email }
      : { organizationId, firstName: first, lastName: last },
    select: { id: true },
  });

  if (existing) {
    await prisma.contact.update({ where: { id: existing.id }, data });
    counts.primaryContacts.updated += 1;
    return;
  }

  await prisma.contact.create({ data: { ...data, organizationId } });
  counts.primaryContacts.created += 1;
}

async function importOrganizations(
  items: MondayItem[],
  counts: ImportCounts,
  warnings: string[],
  dryRun: boolean,
): Promise<Map<string, string>> {
  // monday item id -> CPQ organization id
  const idMap = new Map<string, string>();

  for (const item of items) {
    counts.organizations.seen += 1;
    const name = item.name.trim();
    if (!name) {
      counts.organizations.skipped += 1;
      warnings.push(`Organization ${item.id}: blank name — skipped`);
      continue;
    }

    const customerType = toCustomerType(item.text[ORG_COL.industry]);
    const projectId = parseProjectId(item.text[ORG_COL.projectId]);
    if (projectId) counts.projectIds.present += 1;
    const notes = buildNotes(item, projectId);

    const existingLink = await linkFor('Organization', item.id);
    if (existingLink) {
      if (!dryRun) {
        await prisma.organization.update({
          where: { id: existingLink.entityId },
          data: { name, customerType, notes },
        });
        await saveLink('Organization', existingLink.entityId, item.id, ORGANIZATIONS_BOARD_ID);
      }
      idMap.set(item.id, existingLink.entityId);
      counts.organizations.updated += 1;
      await writeAddressIfMissing(item, existingLink.entityId, name, counts, dryRun);
      await upsertPrimaryContact(item, existingLink.entityId, counts, dryRun);
      continue;
    }

    // Not linked yet — adopt a same-name organization rather than duplicate it.
    const normalizedName = normalizeOrgName(name);
    const twin = normalizedName
      ? await prisma.organization.findFirst({ where: { normalizedName }, select: { id: true } })
      : null;

    if (twin) {
      if (!dryRun) {
        await prisma.organization.update({
          where: { id: twin.id },
          data: { customerType, notes },
        });
        await saveLink('Organization', twin.id, item.id, ORGANIZATIONS_BOARD_ID);
      }
      idMap.set(item.id, twin.id);
      counts.organizations.adopted += 1;
      await writeAddressIfMissing(item, twin.id, name, counts, dryRun);
      await upsertPrimaryContact(item, twin.id, counts, dryRun);
      continue;
    }

    if (dryRun) {
      counts.organizations.created += 1;
      idMap.set(item.id, `dry-${item.id}`);
      await writeAddressIfMissing(item, `dry-${item.id}`, name, counts, dryRun);
      await upsertPrimaryContact(item, `dry-${item.id}`, counts, dryRun);
      continue;
    }

    const org = await prisma.organization.create({
      data: { name, normalizedName, customerType, notes },
      select: { id: true },
    });
    await saveLink('Organization', org.id, item.id, ORGANIZATIONS_BOARD_ID);
    idMap.set(item.id, org.id);
    counts.organizations.created += 1;

    await writeAddressIfMissing(item, org.id, name, counts, dryRun);
    await upsertPrimaryContact(item, org.id, counts, dryRun);
  }

  return idMap;
}

async function importContacts(
  items: MondayItem[],
  orgIdByMondayId: Map<string, string>,
  counts: ImportCounts,
  warnings: string[],
  dryRun: boolean,
): Promise<void> {
  for (const item of items) {
    counts.contacts.seen += 1;

    const accountIds = parseLinkedIds(item.raw[CONTACT_COL.account]);
    const mondayOrgId = accountIds[0];
    const organizationId = mondayOrgId ? orgIdByMondayId.get(mondayOrgId) : undefined;

    // A contact with no account has nowhere to live — Contact.organizationId is
    // required. Counted, not silently dropped.
    if (!organizationId || organizationId.startsWith('dry-')) {
      if (!organizationId) {
        counts.contacts.unlinked += 1;
        continue;
      }
      if (dryRun) {
        counts.contacts.created += 1;
        continue;
      }
    }

    const { first, last } = splitName(item.name, item.text[CONTACT_COL.firstName] ?? '');
    const email = parseEmail(item.raw[CONTACT_COL.email], item.text[CONTACT_COL.email] ?? '');
    const phone = item.text[CONTACT_COL.phone]?.trim() || null;
    const title = item.text[CONTACT_COL.title]?.trim() || null;
    const contactType = item.text[CONTACT_COL.contactType];
    const notes = item.text[CONTACT_COL.comments]?.trim() || null;

    const data = {
      firstName: first,
      lastName: last,
      email,
      phone,
      title,
      isDecisionMaker: isDecisionMaker(contactType),
      notes,
    };

    const existingLink = await linkFor('Contact', item.id);
    if (existingLink) {
      if (!dryRun) {
        await prisma.contact.update({ where: { id: existingLink.entityId }, data });
        await saveLink('Contact', existingLink.entityId, item.id, CONTACTS_BOARD_ID);
      }
      counts.contacts.updated += 1;
      continue;
    }

    if (dryRun) {
      counts.contacts.created += 1;
      continue;
    }

    const contact = await prisma.contact.create({
      data: { ...data, organizationId: organizationId! },
      select: { id: true },
    });
    await saveLink('Contact', contact.id, item.id, CONTACTS_BOARD_ID);
    counts.contacts.created += 1;
  }
}

export async function importCrmFromMonday(options: ImportOptions = {}): Promise<ImportResult> {
  const { dryRun = true, limit, organizationsOnly = false } = options;
  const started = Date.now();
  const counts = emptyCounts();
  const warnings: string[] = [];

  logger.info({ dryRun, limit, organizationsOnly }, 'monday CRM import starting');

  let orgItems = await fetchAllItems(ORGANIZATIONS_BOARD_ID);
  if (limit) orgItems = orgItems.slice(0, limit);
  const orgIdByMondayId = await importOrganizations(orgItems, counts, warnings, dryRun);

  if (!organizationsOnly) {
    let contactItems = await fetchAllItems(CONTACTS_BOARD_ID);
    if (limit) contactItems = contactItems.slice(0, limit);
    await importContacts(contactItems, orgIdByMondayId, counts, warnings, dryRun);
  }

  if (counts.contacts.unlinked > 0) {
    warnings.push(
      `${counts.contacts.unlinked} contact(s) on the Contacts board have no linked account and were ` +
        `skipped — a contact requires an organization in the CPQ. Their organization's primary ` +
        `contact still imported from the Organizations row.`,
    );
  }

  const result: ImportResult = {
    ...counts,
    dryRun,
    durationMs: Date.now() - started,
    warnings,
  };

  if (!dryRun) {
    await prisma.integrationSyncLog.create({
      data: {
        direction: 'INBOUND',
        entity: 'CrmImport',
        status: 'ok',
        error: null,
        eventId: `crm-import-${started}`,
      },
    });
  }

  logger.info({ result }, 'monday CRM import finished');
  return result;
}
