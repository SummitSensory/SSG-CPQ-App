import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { fetchItemById } from '../integrations/monday/discovery.js';
import { DEAL_COL } from '../integrations/monday/crmMapping.js';
import type { ProposalSection } from '../proposals/sections.js';

/**
 * The customer's monday.com Project ID, resolved from the CRM rather than typed.
 *
 * A proposal that opens with an empty Project ID cannot request freight, cannot
 * carry a reference onto an RFQ, and prints without the number the customer's own
 * paperwork uses — and nothing about the number is a decision the rep makes. It is
 * the Project ID column on the customer's monday deal row (`pulse_id_mm5kc9f8`, an
 * Item ID column, so its value IS the deal item id). Before this module the only
 * way it ever reached a proposal was the "Project ID: 12414494509" line that the
 * CRM import happens to leave in an opportunity's notes, scraped by the browser
 * from a name-matched opportunity list — which is why a customer created by hand,
 * or one whose import predates that note, produced a blank field.
 *
 * Three sources, in the order they can be trusted:
 *
 *   1. the live Project ID column on the linked monday deal;
 *   2. the linked deal's own item id, when that column is empty — the column is an
 *      Item ID column by convention, so the two agree, and freight only ever needs
 *      the numeric item;
 *   3. the "Project ID:" line in an opportunity's notes, for a CRM that was
 *      imported before the deal link was stored.
 *
 * Never throws and never blocks: an unreachable board or an unlinked customer just
 * returns an empty string, exactly as if the rep had not typed one yet.
 */
export interface ResolvedProjectId {
  projectId: string;
  source: 'monday-column' | 'monday-item' | 'opportunity-notes' | 'none';
}

export async function resolveOrgProjectId(organizationId: string): Promise<ResolvedProjectId> {
  try {
    const opp = await prisma.opportunity.findFirst({
      where: { organizationId, mondayItemId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { mondayItemId: true },
    });
    if (opp?.mondayItemId) {
      const itemId = String(opp.mondayItemId).trim();
      try {
        const item = await fetchItemById(itemId);
        const column = String(item?.text?.[DEAL_COL.projectId] ?? '').trim();
        if (column) return { projectId: column, source: 'monday-column' };
      } catch (err) {
        logger.warn(
          { err, organizationId, itemId },
          'project id: monday deal row unreadable, using the linked item id',
        );
      }
      if (itemId) return { projectId: itemId, source: 'monday-item' };
    }

    const noted = await prisma.opportunity.findMany({
      where: { organizationId, notes: { contains: 'Project ID:' } },
      orderBy: { updatedAt: 'desc' },
      select: { notes: true },
      take: 5,
    });
    for (const o of noted) {
      const m = /Project ID:\s*(\S+)/.exec(o.notes ?? '');
      if (m?.[1]) return { projectId: m[1].trim(), source: 'opportunity-notes' };
    }
  } catch (err) {
    logger.warn({ err, organizationId }, 'project id: could not be resolved for this customer');
  }
  return { projectId: '', source: 'none' };
}

/**
 * An opportunity's own Project ID, read locally — no monday call.
 *
 * `resolveOrgProjectId` answers "which of this customer's several deals" by guessing
 * the most recently updated one, which is the wrong question once a specific
 * opportunity has already been identified — by a rep picking it in the New Proposal
 * dialog, or a proposal already linked to one via `Proposal.opportunityId`. This is
 * the two local sources that function falls back to, in the same order, with the
 * live monday read skipped: the rep already saw this exact id in the picker, sourced
 * the same way, so re-fetching it from monday could only make the two disagree.
 */
export function projectIdOfOpportunity(opp: {
  notes?: string | null;
  mondayItemId?: string | null;
}): string {
  const noted = /Project ID:\s*(\S+)/.exec(opp.notes ?? '');
  if (noted?.[1]) return noted[1].trim();
  return String(opp.mondayItemId ?? '').trim();
}

/**
 * Stamp the Project ID of a SPECIFIC opportunity, for a proposal created against it
 * explicitly. Takes precedence over `sectionsWithResolvedProjectId`'s org-wide guess
 * for exactly the reason that guess exists to cover: which of several concurrent
 * projects this proposal is for is no longer ambiguous once an opportunity id is on
 * the request.
 */
export async function sectionsWithOpportunityProjectId(
  sections: unknown,
  opportunityId: string,
): Promise<ProposalSection[]> {
  const list = (Array.isArray(sections) ? sections : []) as ProposalSection[];
  if (projectIdOfSections(list)) return list;
  const opp = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: { notes: true, mondayItemId: true },
  });
  const projectId = opp ? projectIdOfOpportunity(opp) : '';
  return projectId ? withProjectId(list, projectId) : list;
}

type MetaSection = ProposalSection & { data?: Record<string, unknown> };

/** The Project ID already on a version's sections, if any. */
export function projectIdOfSections(sections: unknown): string {
  if (!Array.isArray(sections)) return '';
  for (const sec of sections as MetaSection[]) {
    const v = String((sec?.data as { projectId?: unknown } | undefined)?.projectId ?? '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * Put `projectId` on the CUSTOMER_INFO ("meta") section — the one the builder reads
 * its header from — creating that section when the proposal has none yet, which is
 * the case for every freshly created proposal. Returns a new array; the input is
 * left alone so a caller can tell whether anything changed by identity.
 */
export function withProjectId(sections: unknown, projectId: string): ProposalSection[] {
  const list: MetaSection[] = Array.isArray(sections) ? ([...sections] as MetaSection[]) : [];
  const id = String(projectId ?? '').trim();
  if (!id) return list as ProposalSection[];
  const i = list.findIndex((s) => s?.id === 'meta');
  if (i === -1) {
    list.unshift({
      id: 'meta',
      type: 'CUSTOMER_INFO',
      title: 'Proposal',
      order: 0,
      enabled: true,
      data: { projectId: id },
    } as MetaSection);
    return list as ProposalSection[];
  }
  const sec = list[i]!;
  list[i] = { ...sec, data: { ...(sec.data ?? {}), projectId: id } };
  return list as ProposalSection[];
}

/**
 * Stamp the customer's Project ID onto sections that do not carry one. Used at
 * proposal creation, so a proposal is never born without it.
 */
export async function sectionsWithResolvedProjectId(
  sections: unknown,
  organizationId: string,
): Promise<ProposalSection[]> {
  const list = (Array.isArray(sections) ? sections : []) as ProposalSection[];
  if (projectIdOfSections(list)) return list;
  const { projectId } = await resolveOrgProjectId(organizationId);
  return projectId ? withProjectId(list, projectId) : list;
}

/**
 * Backfill the Project ID on a proposal's versions as its page loads.
 *
 * Creation-time stamping only helps proposals made from here on; the drafts already
 * in the database opened blank, and the rep hits it the moment they press Request
 * Freight. So the read path fills the gap too: one resolution per proposal, only
 * when a version is actually missing the number, and the value is persisted for
 * editable drafts so a later save keeps it. Frozen versions (released, accepted)
 * are never written to — the document a customer holds does not change — they only
 * get the number in the response.
 */
export async function backfillProjectIdOnVersions<
  V extends { id: string; sections: unknown; status: string; frozen: boolean },
>(organizationId: string, versions: V[]): Promise<V[]> {
  if (!versions.length) return versions;
  if (versions.every((v) => projectIdOfSections(v.sections))) return versions;
  const { projectId, source } = await resolveOrgProjectId(organizationId);
  if (!projectId) return versions;
  const out: V[] = [];
  for (const v of versions) {
    if (projectIdOfSections(v.sections)) {
      out.push(v);
      continue;
    }
    const sections = withProjectId(v.sections, projectId);
    if (!v.frozen && v.status === 'DRAFT') {
      try {
        await prisma.proposalVersion.update({
          where: { id: v.id },
          data: { sections: sections as unknown as object },
        });
      } catch (err) {
        logger.warn({ err, versionId: v.id }, 'project id: draft backfill could not be saved');
      }
    }
    logger.info({ versionId: v.id, projectId, source }, 'project id: backfilled onto version');
    out.push({ ...v, sections } as V);
  }
  return out;
}
