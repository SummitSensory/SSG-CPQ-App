import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { normalizeOrgName } from './duplicates.js';
import { projectIdOfOpportunity } from './projectId.js';
import { searchItemsByName, type MondayItem } from '../integrations/monday/discovery.js';
import {
  DEALS_BOARD_ID,
  DEAL_COL,
  clean,
  firstLabel,
  parseEmail,
} from '../integrations/monday/crmMapping.js';

/**
 * The New proposal customer picker: one search over the CRM AND the monday Deal
 * Tracking board, so a rep starting a proposal never has to leave it to import a
 * customer first.
 *
 * CRM rows come back one per project (opportunity), the way the proposal form has
 * always offered them, plus one bare row for a customer with no project yet. monday
 * rows are deals NOT already in the CRM — a deal whose item id is on an Opportunity
 * is represented by that CRM row, so the same deal is never offered twice. Picking a
 * monday row imports it through the ordinary importer (POST
 * /crm/customer-picker/monday/:itemId) and hands back the CRM ids.
 *
 * monday is best effort here: unconfigured, slow or down, the CRM half still answers
 * and `monday.status` says why the other half is missing.
 */

export interface PickerCrmRow {
  organizationId: string;
  organizationName: string;
  opportunityId: string | null;
  opportunityName: string | null;
  projectId: string;
  stage: string | null;
  closed: boolean;
}

export interface PickerMondayRow {
  itemId: string;
  name: string;
  industry: string | null;
  contact: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  projectId: string | null;
  stage: string | null;
  /** A CRM customer with this name already exists; importing adds the deal to it. */
  existingOrganizationId: string | null;
}

export type MondayPickerStatus =
  'ok' | 'not-configured' | 'not-permitted' | 'query-too-short' | 'unavailable';

export interface PickerResult {
  q: string;
  crm: PickerCrmRow[];
  monday: { status: MondayPickerStatus; rows: PickerMondayRow[]; error: string | null };
}

const CRM_ORG_LIMIT = 40;
const CRM_OPP_LIMIT = 120;
const MONDAY_LIMIT = 15;
const MONDAY_TIMEOUT_MS = 8_000;

/** The CRM half: matching customers and every project of theirs, plus projects matched by Project ID. */
export async function searchCrmCustomers(q: string): Promise<PickerCrmRow[]> {
  const term = q.trim();
  const ci = 'insensitive' as const;
  const orgs = await prisma.organization.findMany({
    where: term ? { name: { contains: term, mode: ci } } : {},
    orderBy: term ? { name: 'asc' } : { updatedAt: 'desc' },
    take: CRM_ORG_LIMIT,
    select: { id: true, name: true },
  });
  const orgIds = orgs.map((o) => o.id);
  const opps = await prisma.opportunity.findMany({
    where: term
      ? {
          OR: [
            { organizationId: { in: orgIds } },
            { name: { contains: term, mode: ci } },
            // "Project ID: 12345" is stamped into notes by the importer.
            { notes: { contains: term, mode: ci } },
            { mondayItemId: term },
          ],
        }
      : { organizationId: { in: orgIds } },
    orderBy: { updatedAt: 'desc' },
    take: CRM_OPP_LIMIT,
    select: {
      id: true,
      name: true,
      notes: true,
      stage: true,
      mondayItemId: true,
      organizationId: true,
      organization: { select: { name: true } },
    },
  });

  const rows: PickerCrmRow[] = [];
  const withProject = new Set<string>();
  for (const o of opps) {
    withProject.add(o.organizationId);
    rows.push({
      organizationId: o.organizationId,
      organizationName: o.organization.name,
      opportunityId: o.id,
      opportunityName: o.name,
      projectId: projectIdOfOpportunity(o),
      stage: o.stage,
      closed: o.stage === 'CLOSED_WON' || o.stage === 'CLOSED_LOST',
    });
  }
  for (const org of orgs) {
    if (withProject.has(org.id)) continue;
    rows.push({
      organizationId: org.id,
      organizationName: org.name,
      opportunityId: null,
      opportunityName: null,
      projectId: '',
      stage: null,
      closed: false,
    });
  }
  // Open projects before closed ones, then alphabetical, then by Project ID.
  rows.sort(
    (a, b) =>
      Number(a.closed) - Number(b.closed) ||
      a.organizationName.localeCompare(b.organizationName, undefined, { sensitivity: 'base' }) ||
      a.projectId.localeCompare(b.projectId, undefined, { numeric: true }),
  );
  return rows;
}

function toMondayRow(it: MondayItem): Omit<PickerMondayRow, 'existingOrganizationId'> {
  return {
    itemId: it.id,
    name: it.name,
    industry: firstLabel(it.text[DEAL_COL.industry]),
    contact: clean(it.text[DEAL_COL.contactName]),
    email: parseEmail(it.raw[DEAL_COL.contactEmail], it.text[DEAL_COL.contactEmail] ?? ''),
    city: clean(it.text[DEAL_COL.cityText]) ?? clean(it.text[DEAL_COL.city]),
    state: clean(it.text[DEAL_COL.state]),
    projectId: clean(it.text[DEAL_COL.projectId]),
    stage: clean(it.text[DEAL_COL.stage]),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`monday did not answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The monday half: Deal Tracking rows matching by name that the CRM does not hold yet. */
export async function searchMondayDeals(
  q: string,
  search: (term: string) => Promise<MondayItem[]> = (term) =>
    searchItemsByName(DEALS_BOARD_ID, term, MONDAY_LIMIT),
  timeoutMs = MONDAY_TIMEOUT_MS,
): Promise<PickerResult['monday']> {
  if (!env.MONDAY_API_TOKEN) return { status: 'not-configured', rows: [], error: null };
  if (q.trim().length < 2) return { status: 'query-too-short', rows: [], error: null };
  let items: MondayItem[];
  try {
    items = await withTimeout(search(q.trim()), timeoutMs);
  } catch (err) {
    logger.warn({ err }, 'customer picker: monday search failed');
    return {
      status: 'unavailable',
      rows: [],
      error: String(err instanceof Error ? err.message : err),
    };
  }
  const ids = items.map((i) => i.id);
  const linked = ids.length
    ? await prisma.opportunity.findMany({
        where: { mondayItemId: { in: ids } },
        select: { mondayItemId: true },
      })
    : [];
  const linkedIds = new Set(linked.map((l) => l.mondayItemId));
  const fresh = items.filter((i) => !linkedIds.has(i.id) && i.name.trim());

  const names = [...new Set(fresh.map((i) => normalizeOrgName(i.name)).filter(Boolean))];
  const twins = names.length
    ? await prisma.organization.findMany({
        where: { normalizedName: { in: names } },
        select: { id: true, normalizedName: true },
      })
    : [];
  const twinByName = new Map(twins.map((t) => [t.normalizedName, t.id]));

  return {
    status: 'ok',
    error: null,
    rows: fresh.map((it) => ({
      ...toMondayRow(it),
      existingOrganizationId: twinByName.get(normalizeOrgName(it.name)) ?? null,
    })),
  };
}

export async function searchCustomers(
  q: string,
  opts: { includeMonday: boolean; mondaySearch?: (term: string) => Promise<MondayItem[]> },
): Promise<PickerResult> {
  const [crm, monday] = await Promise.all([
    searchCrmCustomers(q),
    opts.includeMonday
      ? searchMondayDeals(q, opts.mondaySearch)
      : Promise.resolve<PickerResult['monday']>({ status: 'not-permitted', rows: [], error: null }),
  ]);
  return { q, crm, monday };
}
