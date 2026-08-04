import { prisma } from '../../lib/prisma.js';
import { env, isMondayPushConfigured } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { setColumnValues, uploadFileToColumn } from './client.js';
import { findLink } from './links.js';
import { versionTotals } from '../../proposals/analytics.js';
import { renderPdf, pdfAvailable } from '../../render/pdf.js';

/**
 * Releasing a proposal writes back to the monday deal row: the amount, the proposal
 * title, and the proposal document itself.
 *
 * The column ids are monday's own, not ours — they are the board's internal keys and
 * cannot be derived, so they live here as named constants. Change a column on the
 * board and this is the one place to update.
 */
export const DEAL_COLUMNS = {
  /** Numbers column — the proposal subtotal, in dollars. */
  subtotal: 'deal_value',
  /** Text column — the proposal title. */
  title: 'text29__1',
  /** Numbers column — the discount taken off the proposal, in dollars. */
  discount: 'numbers4__1',
  /** File column — the released proposal PDF. */
  file: 'file_mm5xt53s',
} as const;

const ENTITY = 'ProposalVersion';

export interface ProposalPushResult {
  pushed: boolean;
  /** Why nothing was pushed, in words a rep can act on. */
  skipped?: string;
  itemId?: string;
  subtotalMinor?: number;
  discountMinor?: number;
  fileUploaded?: boolean;
  error?: string;
}

/**
 * The monday deal row behind a proposal. A proposal is filed against an
 * organization, not a deal, so the deal is reached through the organization's
 * opportunities: the most recently updated one that monday knows about. An
 * organization with no synced opportunity has no row to write to, which is reported
 * rather than guessed at.
 */
async function dealItemIdFor(organizationId: string): Promise<{ itemId?: string; note?: string }> {
  const opps = await prisma.opportunity.findMany({
    where: { organizationId },
    select: { id: true, name: true, mondayItemId: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (!opps.length) return { note: 'this customer has no opportunity in the CRM, so there is no monday deal row to update' };

  for (const o of opps) {
    if (o.mondayItemId) return { itemId: o.mondayItemId };
    const link = await findLink({ entity: 'Opportunity', entityId: o.id });
    if (link?.externalId) return { itemId: link.externalId };
  }
  return { note: 'none of this customer’s opportunities are linked to a monday deal row yet' };
}

/**
 * Push a released proposal to the monday deal board. Never throws: a release must
 * not fail because monday is unreachable, so the outcome comes back to the caller as
 * data and is written to the sync log either way.
 *
 * `proposalHtml` is the document the browser rendered — the same markup the preview
 * and the customer email use, so monday receives the file the customer receives. It
 * is rendered to PDF here rather than in the browser, so the upload does not depend
 * on the rep's print dialog.
 */
export async function pushReleasedProposal(input: {
  versionId: string;
  proposalHtml?: string;
  filename?: string;
}): Promise<ProposalPushResult> {
  // Token + board id only. The signing secret guards inbound webhooks, not this.
  if (!isMondayPushConfigured()) {
    return {
      pushed: false,
      skipped: 'monday.com is not configured on this deployment — set MONDAY_API_TOKEN and MONDAY_DEALS_BOARD_ID.',
    };
  }

  const version = await prisma.proposalVersion.findUnique({
    where: { id: input.versionId },
    select: {
      id: true, sections: true, items: true,
      proposal: { select: { id: true, number: true, title: true, organizationId: true } },
    },
  });
  if (!version?.proposal) return { pushed: false, skipped: 'proposal version not found' };

  const { itemId, note } = await dealItemIdFor(version.proposal.organizationId);
  if (!itemId) return { pushed: false, skipped: note };

  const totals = versionTotals(version.items, version.sections);
  const subtotalMinor = totals.subtotal;
  const boardId = env.MONDAY_DEALS_BOARD_ID!;
  let fileUploaded = false;

  try {
    await setColumnValues(boardId, itemId, {
      [DEAL_COLUMNS.subtotal]: (subtotalMinor / 100).toFixed(2),
      [DEAL_COLUMNS.title]: version.proposal.title || '',
      // The discount as an amount, to match the subtotal beside it. The percentage is
      // what the rep types; the dollars are what the deal board reports on.
      [DEAL_COLUMNS.discount]: (totals.discount / 100).toFixed(2),
    });

    if (input.proposalHtml) {
      if (await pdfAvailable()) {
        const name = (input.filename || version.proposal.number).replace(/\.pdf$/i, '');
        const pdf = await renderPdf(input.proposalHtml, { format: 'Letter' });
        await uploadFileToColumn(itemId, DEAL_COLUMNS.file, `${name}.pdf`, pdf);
        fileUploaded = true;
      } else {
        logger.warn({ versionId: input.versionId }, 'monday proposal push: PDF renderer unavailable, columns updated without the file');
      }
    }

    await prisma.integrationSyncLog.create({
      data: { direction: 'OUTBOUND', entity: ENTITY, entityId: version.id, externalId: itemId, status: 'ok' },
    });
    return { pushed: true, itemId, subtotalMinor, discountMinor: totals.discount, fileUploaded };
  } catch (err) {
    logger.error({ err, versionId: input.versionId, itemId }, 'monday proposal push failed');
    await prisma.integrationSyncLog.create({
      data: {
        direction: 'OUTBOUND', entity: ENTITY, entityId: version.id, externalId: itemId,
        status: 'error', error: String(err),
      },
    });
    return { pushed: false, itemId, subtotalMinor, discountMinor: totals.discount, fileUploaded, error: String(err) };
  }
}
