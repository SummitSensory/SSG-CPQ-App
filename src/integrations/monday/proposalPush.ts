import { prisma } from '../../lib/prisma.js';
import { env, isMondayPushConfigured } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { setColumnValues, uploadFileToColumn } from './client.js';
import { dealItemIdFor } from './dealLink.js';
import { versionTotals, metaOf } from '../../proposals/analytics.js';
import { sellerCollectedCharges } from '../../crossborder/sellerCharges.js';
import { renderPdf } from '../../render/pdf.js';

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
  /**
   * Numbers column — the discount taken off the proposal, in dollars, written as a
   * NEGATIVE number. The deal board sums its money columns, so a discount has to
   * arrive with the sign it has in the arithmetic; a positive 4,000 there reads as
   * four thousand dollars of additional deal value.
   */
  discount: 'numbers4__1',
  /**
   * Numbers column — every tax-like charge on the proposal in one figure: sales tax,
   * plus, on a cross-border job, the tariff, customs brokerage and Canadian tax that
   * Summit collects. See taxesAndDutiesMinor() for why they are summed rather than
   * given a column each.
   */
  taxes: 'numbers99__1',
  /** Numbers column — Adventure frame length, in feet. */
  frameLength: 'numeric_mm56wfja',
  /** Numbers column — Adventure frame width, in feet. */
  frameWidth: 'numeric_mm56f1rc',
  /** File column — the released proposal PDF. */
  file: 'file_mm5xt53s',
  /** Date column — the date this proposal stops being honoured. */
  expiration: 'date_mm5y5hxm',
} as const;

const ENTITY = 'ProposalVersion';

export interface ProposalPushResult {
  pushed: boolean;
  /** Why nothing was pushed, in words a rep can act on. */
  skipped?: string;
  itemId?: string;
  subtotalMinor?: number;
  /** Positive here, as the amount discounted. It is the board that takes it negative. */
  discountMinor?: number;
  /** Sales tax plus collected border charges, as written to the board. */
  taxesMinor?: number;
  /** The frame footprint in feet, or null on a proposal with no configured frame. */
  frameLengthFt?: number | null;
  frameWidthFt?: number | null;
  /** The expiration written to the board, YYYY-MM-DD, or null when the column was cleared. */
  expirationDate?: string | null;
  fileUploaded?: boolean;
  error?: string;
}

/**
 * monday date columns take `{"date":"YYYY-MM-DD"}`, and an empty object clears them.
 *
 * The calendar day is read in UTC deliberately. An expiration is a date, not an
 * instant: the stored DateTime is midnight for that day, and formatting it in the
 * server's local zone would slide a proposal that expires on the 30th back to the
 * 29th on any deployment running west of UTC — which is every Vercel region we use.
 */
function mondayDateValue(date: Date | null): { date: string } | Record<string, never> {
  if (!date) return {};
  return { date: date.toISOString().slice(0, 10) };
}

/**
 * The monday deal row behind a proposal. Shared with the accept flow and the Bill of
 * Materials freight pull — the rule lives in integrations/monday/dealLink.ts, because
 * three callers need the same answer and were each working it out differently.
 */

/**
 * A monday numbers column takes a plain decimal string, and an empty string clears
 * it. `-0.00` is a real possibility out of `(-0/100).toFixed(2)` and reads as a
 * defect on the board, so zero is normalised before it is formatted.
 */
function dollars(minor: number): string {
  const cents = Math.round(minor) || 0;
  return (cents / 100).toFixed(2);
}

/**
 * The Adventure frame footprint, in feet, from the configurator answers stored on
 * the version.
 *
 * Returns nulls for a proposal with no configured frame — a Soar order, a catalogue
 * order, a proposal built by hand. Those columns are then left alone rather than
 * written as zero: a zero-foot frame is a statement, and a wrong one.
 */
function frameFootprint(sections: unknown): { length: number | null; width: number | null } {
  const adv = (metaOf(sections) as { advAnswers?: { length?: unknown; width?: unknown } })
    .advAnswers;
  if (!adv) return { length: null, width: null };
  const ft = (v: unknown): number | null => {
    const num = Number(v);
    return Number.isFinite(num) && num > 0 ? num : null;
  };
  return { length: ft(adv.length), width: ft(adv.width) };
}

/**
 * Everything tax-like on the proposal, as one figure in USD minor units.
 *
 * Sales tax and the cross-border charges are summed rather than kept apart because
 * the board has one column for them. They cannot double-count: a Canadian proposal
 * calculates its tax through the cross-border engine, and the release blocker
 * `tax:manual_amount_present` refuses to release one that ALSO carries a hand-keyed
 * tax amount. So at most one of the two terms is non-zero on any given proposal.
 *
 * Only charges Summit actually collects are counted. Where the customer clears the
 * goods themselves, the tariff and brokerage are payable at the border to somebody
 * else — they are not deal value and they are not money Summit will ever see.
 *
 * The snapshot wins over a live calculation, which is what sellerCollectedCharges
 * does: the board should report the figures the customer was quoted, not what the
 * engine would produce at today's rates.
 */
async function taxesAndDutiesMinor(versionId: string, salesTaxMinor: number): Promise<number> {
  try {
    const border = await sellerCollectedCharges(versionId);
    return Math.round(salesTaxMinor) + Math.round(border.totalMinor);
  } catch (err) {
    // A border-charge read is not worth failing the push over. The rest of the row
    // is still correct, and the tax column then carries the sales tax alone.
    logger.warn({ err, versionId }, 'monday proposal push: border charges unavailable');
    return Math.round(salesTaxMinor);
  }
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
      skipped:
        'monday.com is not configured on this deployment — set MONDAY_API_TOKEN and MONDAY_DEALS_BOARD_ID.',
    };
  }

  const version = await prisma.proposalVersion.findUnique({
    where: { id: input.versionId },
    select: {
      id: true,
      sections: true,
      items: true,
      expirationDate: true,
      proposal: {
        select: { id: true, number: true, title: true, organizationId: true, opportunityId: true },
      },
    },
  });
  if (!version?.proposal) return { pushed: false, skipped: 'proposal version not found' };

  const { itemId, note } = await dealItemIdFor(
    version.proposal.organizationId,
    version.proposal.opportunityId,
  );
  if (!itemId) return { pushed: false, skipped: note };

  const totals = versionTotals(version.items, version.sections);
  const subtotalMinor = totals.subtotal;
  const frame = frameFootprint(version.sections);
  const taxesMinor = await taxesAndDutiesMinor(version.id, totals.tax);
  const expiration = mondayDateValue(version.expirationDate ?? null);
  const expirationDate = 'date' in expiration ? expiration.date : null;
  const boardId = env.MONDAY_DEALS_BOARD_ID!;
  const fileUploaded = false;

  try {
    // Built rather than written as a literal, because the frame columns are omitted
    // on a proposal that has no frame instead of being sent as zero.
    const columns: Record<string, unknown> = {
      [DEAL_COLUMNS.subtotal]: dollars(subtotalMinor),
      [DEAL_COLUMNS.title]: version.proposal.title || '',
      // The discount as an amount, to match the subtotal beside it, and negative:
      // the board sums these columns, so it has to arrive with the sign it has in
      // the arithmetic. The percentage is what the rep types; the dollars are what
      // the deal board reports on.
      [DEAL_COLUMNS.discount]: dollars(-totals.discount),
      // Sales tax, or the collected border charges on a Canadian job — never both.
      [DEAL_COLUMNS.taxes]: dollars(taxesMinor),
      // Written on every release, including as an empty value. A released version
      // with no expiration must clear whatever the previous version left behind —
      // a stale date on the board is worse than a blank one, because the team will
      // chase a deadline that no longer exists.
      [DEAL_COLUMNS.expiration]: expiration,
    };
    if (frame.length != null) columns[DEAL_COLUMNS.frameLength] = String(frame.length);
    if (frame.width != null) columns[DEAL_COLUMNS.frameWidth] = String(frame.width);

    await setColumnValues(boardId, itemId, columns);

    if (input.proposalHtml) {
      // The document itself is uploaded separately, by the renderer function.
      // Rendering a PDF here would need a headless browser on the main API
      // function, which has neither the memory nor the 30 seconds to spare.
      logger.info(
        { versionId: input.versionId },
        'monday proposal push: columns updated, document follows from the renderer',
      );
    }

    await prisma.integrationSyncLog.create({
      data: {
        direction: 'OUTBOUND',
        entity: ENTITY,
        entityId: version.id,
        externalId: itemId,
        status: 'ok',
      },
    });
    return {
      pushed: true,
      itemId,
      subtotalMinor,
      discountMinor: totals.discount,
      taxesMinor,
      frameLengthFt: frame.length,
      frameWidthFt: frame.width,
      expirationDate,
      fileUploaded,
    };
  } catch (err) {
    logger.error({ err, versionId: input.versionId, itemId }, 'monday proposal push failed');
    await prisma.integrationSyncLog.create({
      data: {
        direction: 'OUTBOUND',
        entity: ENTITY,
        entityId: version.id,
        externalId: itemId,
        status: 'error',
        error: String(err),
      },
    });
    return {
      pushed: false,
      itemId,
      subtotalMinor,
      discountMinor: totals.discount,
      taxesMinor,
      frameLengthFt: frame.length,
      frameWidthFt: frame.width,
      expirationDate,
      fileUploaded,
      error: String(err),
    };
  }
}

export interface ProposalFileUploadResult {
  uploaded: boolean;
  itemId?: string;
  filename?: string;
  skipped?: string;
  error?: string;
}

/**
 * Render the released proposal and put it in the deal row's file column.
 *
 * Called from the renderer function, not from the release request — see the note
 * on the route. Never throws for a monday-side problem: the proposal is already
 * released, and a missing attachment is worth reporting rather than turning into
 * a failed request the rep cannot act on.
 */
export async function uploadProposalPdfToMonday(input: {
  versionId: string;
  proposalHtml: string;
  filename?: string;
}): Promise<ProposalFileUploadResult> {
  if (!isMondayPushConfigured()) {
    return { uploaded: false, skipped: 'monday.com is not configured on this deployment.' };
  }

  const version = await prisma.proposalVersion.findUnique({
    where: { id: input.versionId },
    select: {
      id: true,
      proposal: { select: { number: true, organizationId: true, opportunityId: true } },
    },
  });
  if (!version?.proposal) return { uploaded: false, skipped: 'proposal version not found' };

  const { itemId, note } = await dealItemIdFor(
    version.proposal.organizationId,
    version.proposal.opportunityId,
  );
  if (!itemId) return { uploaded: false, skipped: note };

  const name = (input.filename || version.proposal.number).replace(/\.pdf$/i, '');
  try {
    // edgeToEdge: the proposal document owns its own page geometry — see render/pdf.ts.
    const pdf = await renderPdf(input.proposalHtml, { format: 'Letter', edgeToEdge: true });
    await uploadFileToColumn(itemId, DEAL_COLUMNS.file, `${name}.pdf`, pdf);
    await prisma.integrationSyncLog.create({
      data: {
        direction: 'OUTBOUND',
        entity: ENTITY,
        entityId: version.id,
        externalId: itemId,
        status: 'ok',
      },
    });
    logger.info({ versionId: input.versionId, itemId }, 'monday proposal push: document uploaded');
    return { uploaded: true, itemId, filename: `${name}.pdf` };
  } catch (err) {
    logger.error(
      { err, versionId: input.versionId, itemId },
      'monday proposal push: document upload failed',
    );
    await prisma.integrationSyncLog.create({
      data: {
        direction: 'OUTBOUND',
        entity: ENTITY,
        entityId: version.id,
        externalId: itemId,
        status: 'error',
        error: String(err),
      },
    });
    return { uploaded: false, itemId, error: String(err) };
  }
}
