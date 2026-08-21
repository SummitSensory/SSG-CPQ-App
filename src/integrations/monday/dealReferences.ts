import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { isMondayPushConfigured } from '../../config/env.js';
import { mondayQuery } from './client.js';
import { DEAL_COL } from './crmMapping.js';

/**
 * The two references a QuickBooks invoice needs from the deal board.
 *
 * Both print on the customer's invoice as sales-form custom fields, and both are
 * maintained on the monday deal row rather than here:
 *
 *   Project ID   — `pulse_id_mm5kc9f8`, an Item ID column, so its value IS the
 *                  monday item id. The number the shop, the freight desk and the
 *                  customer all use to talk about the job.
 *   Customer PO  — `text_mkv1g18z`. The reference the customer's accounts-payable
 *                  team matches the invoice against. Without it an invoice can sit
 *                  unpaid for weeks pending "which PO is this?", which is the whole
 *                  reason it is worth a network call.
 *
 * Why read the board rather than trust our own copy. The PO frequently arrives after
 * acceptance — the customer raises it once they have the signed quote — so the field
 * captured at signing is blank on exactly the jobs that need it most, and the person
 * who eventually receives the PO puts it on the monday row because that is where
 * they work. Reading it at invoice time is the difference between the invoice
 * carrying the PO and somebody in accounting chasing it.
 *
 * Best effort, always. A board that cannot be reached must never stop an invoice
 * being raised: the caller falls back to what it already had, and the failure is
 * logged rather than thrown.
 */

export interface DealReferences {
  /** From the board, or null when it has none or could not be read. */
  projectId: string | null;
  poNumber: string | null;
  /** Set when the board could not be read at all. */
  error: string | null;
}

const EMPTY: DealReferences = { projectId: null, poNumber: null, error: null };

const clean = (v: unknown): string | null => {
  const text = String(v ?? '').trim();
  return text ? text : null;
};

/**
 * Read the Project ID and PO columns off one deal row.
 *
 * `display_value` is asked for alongside `text` because a mirror or formula column
 * returns null in `text` — the Project ID column is an Item ID type and behaves that
 * way. Getting that wrong reads every value as blank, which looks exactly like a
 * board nobody has filled in.
 */
export async function readDealReferences(
  itemId: string,
  fetchImpl?: typeof fetch,
): Promise<DealReferences> {
  const item = String(itemId ?? '').trim();
  if (!item || !isMondayPushConfigured()) return EMPTY;

  try {
    const data = await mondayQuery<{
      items: Array<{
        id: string;
        column_values: Array<{ id: string; text: string | null; display_value?: string | null }>;
      }>;
    }>(
      `query ($items: [ID!]) {
         items (ids: $items) {
           id
           column_values (ids: ["${DEAL_COL.projectId}", "${DEAL_COL.purchaseOrder}"]) {
             id
             text
             ... on FormulaValue { display_value }
             ... on MirrorValue { display_value }
           }
         }
       }`,
      { items: [item] },
      fetchImpl,
    );

    const found = data.items?.[0];
    if (!found) return { ...EMPTY, error: `monday item ${item} is not visible to this token` };

    const raw: Record<string, string> = {};
    for (const c of found.column_values ?? []) {
      raw[c.id] = String(c.display_value ?? c.text ?? '').trim();
    }
    return {
      projectId: clean(raw[DEAL_COL.projectId]),
      poNumber: clean(raw[DEAL_COL.purchaseOrder]),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, itemId: item }, 'deal references: monday read failed');
    return { ...EMPTY, error: message };
  }
}

/**
 * The deal row a proposal version belongs to.
 *
 * The Project ID on the version's meta is preferred because it is what printed on
 * the document the customer holds, and it IS the item id. The organization's linked
 * opportunity is the fallback for a proposal written before that field was filled.
 */
export async function dealItemForVersion(versionId: string): Promise<string | null> {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: { sections: true, proposal: { select: { organizationId: true } } },
  });
  if (!version) return null;

  const meta = Array.isArray(version.sections)
    ? (version.sections as Array<{ id?: string; data?: Record<string, unknown> }>).find(
        (s) => s?.id === 'meta',
      )?.data
    : undefined;
  const fromMeta = String(meta?.projectId ?? '').trim();
  if (/^\d+$/.test(fromMeta)) return fromMeta;

  const opp = await prisma.opportunity.findFirst({
    where: { organizationId: version.proposal.organizationId, mondayItemId: { not: null } },
    orderBy: { updatedAt: 'desc' },
    select: { mondayItemId: true },
  });
  return opp?.mondayItemId ?? null;
}

export interface ResolvedReferences {
  projectId: string;
  poNumber: string | null;
  /** Where each value came from, for the audit line on the push. */
  source: { projectId: 'board' | 'proposal' | 'none'; poNumber: 'board' | 'acceptance' | 'none' };
  boardError: string | null;
}

/**
 * Both references for an invoice, board first and our own records behind it.
 *
 * The precedence is deliberate and different per field:
 *
 *   Project ID — the PROPOSAL wins. It printed on the document the customer signed,
 *                and an invoice quoting a different number than the quote is worse
 *                than an invoice quoting a slightly stale one. The board is only
 *                consulted when the proposal has none.
 *   PO number  — the BOARD wins. A PO that arrived after acceptance only exists
 *                there, and a PO is not a promise we made — it is a reference the
 *                customer gave us, so the freshest one is the right one.
 */
export async function resolveInvoiceReferences(
  versionId: string,
  fallback: { projectId?: string | null; poNumber?: string | null } = {},
  fetchImpl?: typeof fetch,
): Promise<ResolvedReferences> {
  const ownProject = String(fallback.projectId ?? '').trim();
  const ownPo = String(fallback.poNumber ?? '').trim();

  const itemId = await dealItemForVersion(versionId);
  const board = itemId ? await readDealReferences(itemId, fetchImpl) : EMPTY;

  const projectId = ownProject || board.projectId || '';
  const poNumber = board.poNumber || ownPo || null;

  return {
    projectId,
    poNumber,
    source: {
      projectId: ownProject ? 'proposal' : board.projectId ? 'board' : 'none',
      poNumber: board.poNumber ? 'board' : ownPo ? 'acceptance' : 'none',
    },
    boardError: board.error,
  };
}
