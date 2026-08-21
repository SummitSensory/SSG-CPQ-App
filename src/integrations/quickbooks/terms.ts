import { prisma } from '../../lib/prisma.js';
import { query } from './client.js';

/**
 * QuickBooks payment Terms — read from QuickBooks, chosen in the portal, stored
 * per client and per proposal.
 *
 * Terms are a QuickBooks list (Settings → All lists → Terms); CPQ never creates
 * them, it only references them by Id. The resolution order when invoicing is
 * proposal -> organization -> system default, so a client who is not allowed
 * 50/50 simply gets a different term on their proposal without touching code.
 */
export interface QboTerm {
  id: string;
  name: string;
  /** Net days, when the term is a plain due-in-N-days term. */
  dueDays: number | null;
  active: boolean;
}

interface RawTerm {
  Id: string;
  Name: string;
  DueDays?: number;
  Active?: boolean;
}

/** Every active payment term in QuickBooks, for a portal dropdown. */
export async function listTerms(
  realmId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QboTerm[]> {
  // select * — the query API does not reliably return named columns.
  const res = await query<{ Term?: RawTerm[] }>(realmId, 'select * from Term', fetchImpl);
  return (res.Term ?? [])
    .filter((t) => t.Active !== false)
    .map((t) => ({
      id: t.Id,
      name: t.Name,
      dueDays: typeof t.DueDays === 'number' ? t.DueDays : null,
      active: t.Active !== false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ResolvedTerm {
  id: string | null;
  name: string | null;
  /** Where the term came from — surfaced in the portal so the choice is explicit. */
  source: 'proposal' | 'organization' | 'default' | 'none';
}

/**
 * Resolve the payment term for a proposal: its own term, else the client's
 * default, else the system default (QBO_SALES_TERM_ID). Returns source so the UI
 * can show "inherited from client" rather than implying a per-deal choice.
 */
export async function resolveTermForProposal(proposalId: string): Promise<ResolvedTerm> {
  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    select: { qboSalesTermId: true, qboSalesTermName: true, organizationId: true },
  });
  if (proposal?.qboSalesTermId) {
    return {
      id: proposal.qboSalesTermId,
      name: proposal.qboSalesTermName ?? null,
      source: 'proposal',
    };
  }
  if (proposal?.organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: proposal.organizationId },
      select: { qboSalesTermId: true, qboSalesTermName: true },
    });
    if (org?.qboSalesTermId) {
      return { id: org.qboSalesTermId, name: org.qboSalesTermName ?? null, source: 'organization' };
    }
  }
  const fallback = process.env.QBO_SALES_TERM_ID?.trim();
  if (fallback) return { id: fallback, name: null, source: 'default' };
  return { id: null, name: null, source: 'none' };
}

/** Set (or clear, with null) the term on a proposal. */
export async function setProposalTerm(
  proposalId: string,
  termId: string | null,
  termName: string | null,
) {
  return prisma.proposal.update({
    where: { id: proposalId },
    data: { qboSalesTermId: termId, qboSalesTermName: termId ? termName : null },
    select: { id: true, qboSalesTermId: true, qboSalesTermName: true },
  });
}

/** Set (or clear) the default term on a client. */
export async function setOrganizationTerm(
  organizationId: string,
  termId: string | null,
  termName: string | null,
) {
  return prisma.organization.update({
    where: { id: organizationId },
    data: { qboSalesTermId: termId, qboSalesTermName: termId ? termName : null },
    select: { id: true, qboSalesTermId: true, qboSalesTermName: true },
  });
}

/**
 * The two terms the deposit checkbox chooses between.
 *
 * "Show the 50% deposit on the customer proposal" is not a display toggle by the
 * time an invoice is raised — it is the deal. Ticked, the customer pays half up
 * front and half before shipment; unticked, they pay the whole thing on receipt.
 * The QuickBooks term has to say the same thing, or the invoice contradicts the
 * document the customer signed and the due date it derives is wrong.
 *
 * Matched by NAME against the terms already in QuickBooks rather than created here,
 * because Terms is an accounting list and this application has no business writing
 * to it. Several spellings are accepted per side: a company that calls it "Due on
 * receipt" should not have to rename it to satisfy us. An id set in the environment
 * wins outright, for the case where neither name matches.
 */
const DEPOSIT_TERM_NAMES = [
  '50% upfront / 50% pia',
  '50% upfront/50% pia',
  '50% up front / 50% pia',
  '50/50',
];

const RECEIPT_TERM_NAMES = ['due upon receipt', 'due on receipt', 'due upon reciept'];

const norm = (v: string): string => v.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The term for an invoice, given whether the deposit applies.
 *
 * Falls back to the ordinary resolution — proposal override, client default, system
 * default — when the named term is not in this company’s list. That keeps a
 * misnamed term from silently producing an invoice with no term at all, which would
 * make it due the day it was issued regardless of what was agreed.
 */
export async function resolveTermForInvoice(
  realmId: string,
  proposalId: string,
  depositApplies: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedTerm> {
  const envId = (
    depositApplies ? process.env.QBO_TERM_ID_DEPOSIT : process.env.QBO_TERM_ID_ON_RECEIPT
  )?.trim();
  const wanted = depositApplies ? DEPOSIT_TERM_NAMES : RECEIPT_TERM_NAMES;

  if (envId) {
    return { id: envId, name: null, source: 'default' };
  }
  try {
    const terms = await listTerms(realmId, fetchImpl);
    const hit = terms.find((t) => wanted.includes(norm(t.name)));
    if (hit) return { id: hit.id, name: hit.name, source: 'default' };
  } catch {
    // A term list that cannot be read is not a reason to fail an invoice.
  }
  return resolveTermForProposal(proposalId);
}
