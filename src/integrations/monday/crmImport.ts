import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { normalizeOrgName } from '../../crm/duplicates.js';
import { fetchAllItems, searchItemsByName, fetchItemById, type MondayItem } from './discovery.js';
import {
  DEALS_BOARD_ID,
  ORGANIZATIONS_BOARD_ID,
  CONTACTS_BOARD_ID,
  DEAL_COL,
  ORG_COL,
  CONTACT_COL,
  clean,
  firstLabel,
  toCustomerType,
  isUnmappedIndustry,
  toStage,
  isDecisionMaker,
  buildAddress,
  parseLocation,
  parseEmail,
  parseLinkedIds,
  parseMoneyMinor,
  parseProjectId,
  splitName,
} from './crmMapping.js';

/**
 * Import CRM data FROM monday INTO the CPQ.
 *
 * monday is the system of record for who the customer is; the CPQ is the
 * system of record for what was quoted. This import is inbound-only and never
 * writes back.
 *
 * Default source is the **Deal Tracking** board, which is what
 * "Monday Column Mapping.xlsx" describes: each deal row carries its own
 * customer, industry, address, primary contact and Project ID. One row becomes
 * an Organization (adopted if it already exists) + Address + primary Contact +
 * Opportunity. Nothing depends on the Contacts board's account links, which
 * are empty on most rows.
 *
 * `source: 'orgs'` runs the older Organizations + Contacts board path instead.
 *
 * Idempotent: opportunities are keyed on Opportunity.mondayItemId, orgs are
 * matched on normalized name, contacts on email (then name) within the org.
 * Dry-run mode reports exactly what would change and writes nothing.
 */

const PROVIDER = 'monday';

export type ImportSource = 'deals' | 'orgs';

export interface ImportOptions {
  dryRun?: boolean;
  /** Cap items processed per board — pushed down into the monday paging. */
  limit?: number;
  /** Skip this many items first, so a big board can be walked in chunks that
   *  each finish inside the serverless function timeout. */
  offset?: number;
  /** Stop after this many ms and report nextOffset instead of timing out. */
  budgetMs?: number;
  /** Skip the Contacts board entirely (orgs source only). */
  organizationsOnly?: boolean;
  source?: ImportSource;
}

export interface ImportCounts {
  deals: { seen: number; created: number; updated: number; skipped: number };
  organizations: { seen: number; created: number; updated: number; adopted: number; skipped: number };
  primaryContacts: { created: number; updated: number; skipped: number };
  contacts: { seen: number; created: number; updated: number; skipped: number; unlinked: number };
  addresses: { created: number };
  projectIds: { present: number };
}

export interface ImportResult extends ImportCounts {
  source: ImportSource;
  offset: number;
  /** Feed this back as ?offset= to continue where this run stopped. */
  nextOffset: number;
  /** False when the run stopped early on its time budget. */
  complete: boolean;
  dryRun: boolean;
  durationMs: number;
  warnings: string[];
  /** Distribution of the values the mapping produced, for eyeballing a dry run. */
  samples: {
    customerTypes: Record<string, number>;
    stages: Record<string, number>;
    /** Raw Deal Phase labels seen, so mis-bucketed ones are visible at a glance. */
    stageLabels: Record<string, number>;
    unmappedIndustryLabels: string[];
    firstRows: Array<Record<string, string | null>>;
  };
}

function emptyCounts(): ImportCounts {
  return {
    deals: { seen: 0, created: 0, updated: 0, skipped: 0 },
    organizations: { seen: 0, created: 0, updated: 0, adopted: 0, skipped: 0 },
    primaryContacts: { created: 0, updated: 0, skipped: 0 },
    contacts: { seen: 0, created: 0, updated: 0, skipped: 0, unlinked: 0 },
    addresses: { created: 0 },
    projectIds: { present: 0 },
  };
}

function tally(bag: Record<string, number>, key: string) {
  bag[key] = (bag[key] ?? 0) + 1;
}

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

async function writeAddressIfMissing(
  addr: ReturnType<typeof buildAddress>,
  organizationId: string,
  orgName: string,
  counts: ImportCounts,
  dryRun: boolean,
): Promise<void> {
  if (!addr || !(addr.line1 || addr.city)) return;
  if (dryRun || organizationId.startsWith('dry-')) {
    counts.addresses.created += 1;
    return;
  }
  if ((await prisma.address.count({ where: { organizationId } })) > 0) return;

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

/** Primary contact off the deal row: Full Name / Title / Email / Direct Phone. */
async function upsertPrimaryContact(
  item: MondayItem,
  organizationId: string,
  counts: ImportCounts,
  dryRun: boolean,
): Promise<void> {
  const fullName = clean(item.text[DEAL_COL.contactName]);
  const email = parseEmail(item.raw[DEAL_COL.contactEmail], item.text[DEAL_COL.contactEmail] ?? '');
  const phone = clean(item.text[DEAL_COL.contactPhone]);
  const title = clean(item.text[DEAL_COL.contactTitle]);

  if (!fullName && !email) {
    counts.primaryContacts.skipped += 1;
    return;
  }

  const { first, last } = splitName(fullName ?? email ?? '', '');
  const data = { firstName: first, lastName: last, email, phone, title, isDecisionMaker: true };

  if (dryRun || organizationId.startsWith('dry-')) {
    counts.primaryContacts.created += 1;
    return;
  }

  const existing = await prisma.contact.findFirst({
    where: email ? { organizationId, email } : { organizationId, firstName: first, lastName: last },
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

async function importDeals(
  items: MondayItem[],
  counts: ImportCounts,
  warnings: string[],
  samples: ImportResult['samples'],
  dryRun: boolean,
  deadline: number,
): Promise<number> {
  const unmapped = new Set<string>();
  let processed = 0;

  for (const item of items) {
    if (Date.now() > deadline) break;
    processed += 1;
    counts.deals.seen += 1;
    const dealName = item.name.trim();
    if (!dealName) {
      counts.deals.skipped += 1;
      warnings.push(`Deal ${item.id}: blank name — skipped`);
      continue;
    }

    const industry = firstLabel(item.text[DEAL_COL.industry]);
    if (isUnmappedIndustry(industry)) unmapped.add(industry!);
    const customerType = toCustomerType(industry);
    const stage = toStage(item.text[DEAL_COL.stage]);
    const projectId = parseProjectId(item.text[DEAL_COL.projectId]);
    if (projectId) counts.projectIds.present += 1;
    tally(samples.customerTypes, customerType);
    tally(samples.stages, stage);
    tally(samples.stageLabels, clean(item.text[DEAL_COL.stage]) ?? '(blank)');

    // ---- Organization (deal name is the customer name on this board) ----
    counts.organizations.seen += 1;
    const normalizedName = normalizeOrgName(dealName);
    const website = clean(item.text[DEAL_COL.website]);
    const orgNotes = [website ? `Website: ${website}` : null].filter(Boolean).join('\n') || null;

    let organizationId: string;
    const twin = normalizedName
      ? await prisma.organization.findFirst({ where: { normalizedName }, select: { id: true } })
      : null;

    if (twin) {
      if (!dryRun) {
        await prisma.organization.update({
          where: { id: twin.id },
          data: { customerType, ...(orgNotes ? { notes: orgNotes } : {}) },
        });
      }
      organizationId = twin.id;
      counts.organizations.adopted += 1;
    } else if (dryRun) {
      organizationId = `dry-${item.id}`;
      counts.organizations.created += 1;
    } else {
      const org = await prisma.organization.create({
        data: { name: dealName, normalizedName, customerType, notes: orgNotes },
        select: { id: true },
      });
      organizationId = org.id;
      counts.organizations.created += 1;
    }

    const addr = buildAddress(item.text, item.raw[DEAL_COL.location]);
    await writeAddressIfMissing(
      addr,
      organizationId,
      dealName,
      counts,
      dryRun,
    );
    await upsertPrimaryContact(item, organizationId, counts, dryRun);

    // ---- Opportunity (one per deal row, keyed on the monday item id) ----
    const summary = clean(item.text[DEAL_COL.summary]);
    const oppNotes =
      [projectId ? `Project ID: ${projectId}` : null, summary].filter(Boolean).join('\n') || null;
    const budgetAmountMinor =
      parseMoneyMinor(item.text[DEAL_COL.grandTotal]) ?? parseMoneyMinor(item.text[DEAL_COL.value]);

    if (samples.firstRows.length < 5) {
      samples.firstRows.push({
        deal: dealName,
        industry,
        customerType,
        stage,
        stageLabel: clean(item.text[DEAL_COL.stage]),
        projectId,
        contact: clean(item.text[DEAL_COL.contactName]),
        email: parseEmail(item.raw[DEAL_COL.contactEmail], item.text[DEAL_COL.contactEmail] ?? ''),
        street: addr?.line1 ?? null,
        city: addr?.city ?? null,
        state: addr?.region ?? null,
        zip: addr?.postalCode ?? null,
        country: addr?.country ?? null,
      });
    }

    if (dryRun) {
      const exists = await prisma.opportunity.findUnique({
        where: { mondayItemId: item.id },
        select: { id: true },
      });
      if (exists) counts.deals.updated += 1;
      else counts.deals.created += 1;
      continue;
    }

    const oppData = {
      name: dealName,
      stage,
      notes: oppNotes,
      budgetAmountMinor,
      budgetCurrency: budgetAmountMinor ? 'USD' : null,
      mondaySyncedAt: new Date(),
    };

    const existingOpp = await prisma.opportunity.findUnique({
      where: { mondayItemId: item.id },
      select: { id: true },
    });

    if (existingOpp) {
      await prisma.opportunity.update({ where: { id: existingOpp.id }, data: oppData });
      counts.deals.updated += 1;
    } else {
      const opp = await prisma.opportunity.create({
        data: { ...oppData, organizationId, mondayItemId: item.id },
        select: { id: true },
      });
      await saveLink('Opportunity', opp.id, item.id, DEALS_BOARD_ID);
      counts.deals.created += 1;
    }
  }

  samples.unmappedIndustryLabels = [...unmapped];
  if (unmapped.size) {
    warnings.push(
      `${unmapped.size} industry label(s) are not in the mapping table and fell back to OTHER: ` +
        [...unmapped].join(', '),
    );
  }
  return processed;
}

// ----- Legacy path: Organizations + Contacts boards -----

async function importOrganizations(
  items: MondayItem[],
  counts: ImportCounts,
  warnings: string[],
  dryRun: boolean,
): Promise<Map<string, string>> {
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
    const website = clean(item.text[ORG_COL.website]);
    const description = clean(item.text[ORG_COL.description]);
    const notes =
      [description, website ? `Website: ${website}` : null].filter(Boolean).join('\n') || null;

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
      continue;
    }

    const normalizedName = normalizeOrgName(name);
    const twin = normalizedName
      ? await prisma.organization.findFirst({ where: { normalizedName }, select: { id: true } })
      : null;

    if (twin) {
      if (!dryRun) {
        await prisma.organization.update({ where: { id: twin.id }, data: { customerType, notes } });
        await saveLink('Organization', twin.id, item.id, ORGANIZATIONS_BOARD_ID);
      }
      idMap.set(item.id, twin.id);
      counts.organizations.adopted += 1;
      continue;
    }

    if (dryRun) {
      counts.organizations.created += 1;
      idMap.set(item.id, `dry-${item.id}`);
      continue;
    }

    const org = await prisma.organization.create({
      data: { name, normalizedName, customerType, notes },
      select: { id: true },
    });
    await saveLink('Organization', org.id, item.id, ORGANIZATIONS_BOARD_ID);
    idMap.set(item.id, org.id);
    counts.organizations.created += 1;

    const loc = parseLocation(item.raw[ORG_COL.location]);
    const zip = clean(item.text[ORG_COL.zip]);
    if (loc && (loc.line1 || loc.city)) {
      await prisma.address.create({
        data: {
          organizationId: org.id,
          type: 'SHIPPING',
          line1: loc.line1 ?? loc.city ?? name,
          city: loc.city ?? '',
          region: loc.region ?? '',
          postalCode: zip ?? '',
          country: loc.country,
        },
      });
      counts.addresses.created += 1;
    }
  }

  return idMap;
}

async function importContacts(
  items: MondayItem[],
  orgIdByMondayId: Map<string, string>,
  counts: ImportCounts,
  dryRun: boolean,
): Promise<void> {
  for (const item of items) {
    counts.contacts.seen += 1;

    const accountIds = parseLinkedIds(item.raw[CONTACT_COL.account]);
    const mondayOrgId = accountIds[0];
    const organizationId = mondayOrgId ? orgIdByMondayId.get(mondayOrgId) : undefined;

    if (!organizationId) {
      counts.contacts.unlinked += 1;
      continue;
    }

    const { first, last } = splitName(item.name, item.text[CONTACT_COL.firstName] ?? '');
    const data = {
      firstName: first,
      lastName: last,
      email: parseEmail(item.raw[CONTACT_COL.email], item.text[CONTACT_COL.email] ?? ''),
      phone: clean(item.text[CONTACT_COL.phone]),
      title: clean(item.text[CONTACT_COL.title]),
      isDecisionMaker: isDecisionMaker(item.text[CONTACT_COL.contactType]),
      notes: clean(item.text[CONTACT_COL.comments]),
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

    if (dryRun || organizationId.startsWith('dry-')) {
      counts.contacts.created += 1;
      continue;
    }

    const contact = await prisma.contact.create({ data: { ...data, organizationId } });
    await saveLink('Contact', contact.id, item.id, CONTACTS_BOARD_ID);
    counts.contacts.created += 1;
  }
}

/**
 * Pull ONE customer on demand — search Deal Tracking by name and import the
 * matches. This is the path to use at proposal time; the full board walk is
 * only for the initial backfill.
 */
export async function importDealsMatching(
  term: string,
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<ImportResult> {
  const { dryRun = false, limit = 25 } = opts;
  const started = Date.now();
  const counts = emptyCounts();
  const warnings: string[] = [];
  const samples: ImportResult['samples'] = {
    customerTypes: {},
    stages: {},
    stageLabels: {},
    unmappedIndustryLabels: [],
    firstRows: [],
  };

  const items = await searchItemsByName(DEALS_BOARD_ID, term, limit);
  if (!items.length) warnings.push(`No Deal Tracking rows match "${term}".`);
  const processed = await importDeals(items, counts, warnings, samples, dryRun, Date.now() + 25_000);

  return {
    ...counts,
    source: 'deals',
    offset: 0,
    nextOffset: processed,
    complete: true,
    dryRun,
    durationMs: Date.now() - started,
    warnings,
    samples,
  };
}

/** Import a single Deal Tracking row by its monday item id. */
export async function importDealById(itemId: string, dryRun = false): Promise<ImportResult> {
  const started = Date.now();
  const counts = emptyCounts();
  const warnings: string[] = [];
  const samples: ImportResult['samples'] = {
    customerTypes: {},
    stages: {},
    stageLabels: {},
    unmappedIndustryLabels: [],
    firstRows: [],
  };
  const item = await fetchItemById(itemId);
  if (!item) {
    warnings.push(`monday item ${itemId} not found.`);
  } else {
    await importDeals([item], counts, warnings, samples, dryRun, Date.now() + 25_000);
  }
  return {
    ...counts,
    source: 'deals',
    offset: 0,
    nextOffset: 0,
    complete: true,
    dryRun,
    durationMs: Date.now() - started,
    warnings,
    samples,
  };
}

export async function importCrmFromMonday(options: ImportOptions = {}): Promise<ImportResult> {
  const {
    dryRun = true,
    limit,
    offset = 0,
    budgetMs = 20_000,
    organizationsOnly = false,
    source = 'deals',
  } = options;
  const deadline = Date.now() + budgetMs;
  const started = Date.now();
  const counts = emptyCounts();
  const warnings: string[] = [];
  const samples: ImportResult['samples'] = {
    customerTypes: {},
    stages: {},
    stageLabels: {},
    unmappedIndustryLabels: [],
    firstRows: [],
  };

  let processed = 0;
  let remaining = 0;

  logger.info({ dryRun, limit, offset, source }, 'monday CRM import starting');

  if (source === 'deals') {
    // Never fetch the whole board in one invocation: monday paging alone can
    // outrun the function timeout. Default to a chunk and let the caller loop.
    const chunk = limit ?? 200;
    const fetched = await fetchAllItems(DEALS_BOARD_ID, 250, offset + chunk);
    const dealItems = offset ? fetched.slice(offset) : fetched;
    processed = await importDeals(dealItems, counts, warnings, samples, dryRun, deadline);
    // More rows are left if this chunk filled up, or if the budget cut it short.
    remaining =
      Math.max(0, dealItems.length - processed) + (dealItems.length === chunk ? 1 : 0);
    if (remaining > 0) {
      warnings.push(`Chunk done — re-run with ?offset=${offset + processed} to continue.`);
    }
  } else {
    const orgItems = (await fetchAllItems(ORGANIZATIONS_BOARD_ID, 250, offset + (limit ?? 200))).slice(offset);
    processed = orgItems.length;
    const orgIdByMondayId = await importOrganizations(orgItems, counts, warnings, dryRun);
    if (!organizationsOnly) {
      const contactItems = await fetchAllItems(CONTACTS_BOARD_ID, 250, limit);
      await importContacts(contactItems, orgIdByMondayId, counts, dryRun);
    }
    if (counts.contacts.unlinked > 0) {
      warnings.push(
        `${counts.contacts.unlinked} contact(s) have no linked account in monday and were skipped — ` +
          `a contact requires an organization in the CPQ.`,
      );
    }
  }

  const result: ImportResult = {
    ...counts,
    source,
    offset,
    nextOffset: offset + processed,
    complete: remaining === 0,
    dryRun,
    durationMs: Date.now() - started,
    warnings,
    samples,
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
