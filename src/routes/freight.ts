import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { mondayQuery } from '../integrations/monday/client.js';
import { DEALS_BOARD_ID } from '../integrations/monday/crmMapping.js';
import { prisma } from '../lib/prisma.js';

/**
 * Freight requests against the monday.com Deal Tracking board.
 *
 * Two directions, deliberately separate calls:
 *
 *   push — the proposal's estimated shipment weight goes to `numbers__1`, and
 *          `color__1` flips to Yes so the freight desk sees an outstanding request
 *          on their own board rather than in an email.
 *   pull — `formula_mky8s42a` (the freight amount they enter) is read back.
 *
 * They are separate because the amount does not exist at push time — it arrives
 * hours or days later, and the salesperson pulls it when they are ready to price.
 * Both column ids are fixed to this board; if the board is rebuilt they change, so
 * they live here in one place rather than being spread across the client.
 */

const WEIGHT_COLUMN = 'numbers__1';
const REQUESTED_COLUMN = 'color__1';
const AMOUNT_COLUMN = 'formula_mky8s42a';
const MATS_FREIGHT_COLUMN = 'formula_mkzd3p9s';
const MATS_TAX_COLUMN = 'formula_mkzde17n';

/** The monday item id — the proposal header's Project ID. */
const ItemIdSchema = z
  .string()
  .trim()
  .regex(/^\d{4,}$/, 'Project ID must be the numeric monday item id');

const RequestSchema = z.object({
  itemId: ItemIdSchema,
  weightLb: z.number().finite().min(0).max(1_000_000),
  /** Lines with no catalog weight — recorded so a low number is explainable later. */
  linesMissingWeight: z.number().int().min(0).optional(),
});

/** "$1,234.56" / "1234.56" / "" → minor units, or null when there is no number. */
function parseAmountMinor(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = String(text).replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * Take an outstanding freight request back off the board.
 *
 * Called when a proposal is rejected or marked no longer active. The freight desk
 * works a queue of items flagged `Yes`; a dead proposal sitting in it costs them a
 * quote nobody will ever use, and the salesperson has no reason to remember to go
 * clear it.
 *
 * Two things it deliberately does NOT do. It never clears a request the desk has
 * already answered — that amount is real, it belongs on the record, and a later
 * version of the same proposal can use it. And it never throws: a proposal must be
 * rejectable whether or not monday.com is reachable, so a failure is logged and
 * audited rather than blocking the status change.
 */
export async function releaseFreightRequest(
  proposalId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  let itemId = '';
  try {
    // The Project ID lives on the version's CUSTOMER_INFO section, which is where the
    // builder writes it. Newest version first: that is the one that raised the request.
    const versions = await prisma.proposalVersion.findMany({
      where: { proposalId },
      orderBy: { version: 'desc' },
      select: { sections: true },
    });
    for (const v of versions) {
      const secs = Array.isArray(v.sections)
        ? (v.sections as Array<{ id?: string; data?: { projectId?: string } }>)
        : [];
      const found = secs.find((s) => s?.id === 'meta')?.data?.projectId;
      if (found && /^\d{4,}$/.test(String(found).trim())) {
        itemId = String(found).trim();
        break;
      }
    }
  } catch {
    itemId = '';
  }
  // No Project ID means no request was ever raised against a board item.
  if (!itemId) return;

  let cleared = false;
  let alreadyQuoted = false;
  let error: string | null = null;
  try {
    const data = await mondayQuery<{
      items: Array<{
        column_values: Array<{ id: string; text: string | null; display_value?: string | null }>;
      }>;
    }>(
      `query ($items: [ID!]) {
         items (ids: $items) {
           column_values (ids: ["${AMOUNT_COLUMN}", "${REQUESTED_COLUMN}"]) {
             id
             text
             ... on FormulaValue { display_value }
             ... on MirrorValue { display_value }
           }
         }
       }`,
      { items: [itemId] },
    );
    const cols = data.items?.[0]?.column_values ?? [];
    const amount = parseAmountMinor(cols.find((c) => c.id === AMOUNT_COLUMN)?.display_value);
    const flag = (cols.find((c) => c.id === REQUESTED_COLUMN)?.text ?? '').trim().toLowerCase();
    if (amount != null) {
      alreadyQuoted = true;
    } else if (flag === 'yes') {
      await mondayQuery(
        `mutation ($board: ID!, $item: ID!, $cols: JSON!) {
           change_multiple_column_values (board_id: $board, item_id: $item, column_values: $cols) { id }
         }`,
        {
          board: DEALS_BOARD_ID,
          item: itemId,
          cols: JSON.stringify({ [REQUESTED_COLUMN]: { label: 'No' } }),
        },
      );
      cleared = true;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : 'monday update failed';
    logger.error({ err: error, itemId, proposalId }, 'freight request release failed');
  }

  await recordAudit({
    actorId,
    action: cleared ? 'freight.request_released' : 'freight.request_release_skipped',
    entity: 'Proposal',
    entityId: proposalId,
    details: { itemId, boardId: DEALS_BOARD_ID, reason, alreadyQuoted, error },
  });
}

export function registerFreightRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };

  /**
   * Push the weight and raise the flag. One mutation, so the board never ends up
   * with a weight and no request marker (or the reverse) if the second call fails.
   */
  app.post('/proposals/:id/freight-request', write, async (req) => {
    const { id } = req.params as { id: string };
    const input = RequestSchema.parse(req.body ?? {});

    const columnValues = {
      [WEIGHT_COLUMN]: String(Math.round(input.weightLb * 100) / 100),
      [REQUESTED_COLUMN]: { label: 'Yes' },
    };

    let ok = false;
    let error: string | null = null;
    try {
      await mondayQuery(
        `mutation ($board: ID!, $item: ID!, $cols: JSON!) {
           change_multiple_column_values (board_id: $board, item_id: $item, column_values: $cols) { id }
         }`,
        { board: DEALS_BOARD_ID, item: input.itemId, cols: JSON.stringify(columnValues) },
      );
      ok = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'monday update failed';
      logger.error({ err: error, itemId: input.itemId }, 'freight request push failed');
    }

    // Logged either way: a request the board never received, with nothing on record,
    // is how a proposal goes out with freight nobody actually quoted.
    await recordAudit({
      actorId: req.user!.sub,
      action: ok ? 'freight.requested' : 'freight.request_failed',
      entity: 'Proposal',
      entityId: id,
      details: {
        itemId: input.itemId,
        boardId: DEALS_BOARD_ID,
        weightLb: input.weightLb,
        linesMissingWeight: input.linesMissingWeight ?? null,
        error,
      },
    });

    if (!ok) throw new ValidationError(`monday.com did not accept the freight request: ${error}`);
    return {
      ok: true,
      itemId: input.itemId,
      weightLb: input.weightLb,
      requestedAt: new Date().toISOString(),
    };
  });

  /**
   * Read the freight amount back. `display_value` is what a formula column exposes —
   * `text` is null on formula columns, which is why the fragment is here.
   */
  app.get('/proposals/:id/freight-amount', read, async (req) => {
    const { itemId } = req.query as { itemId?: string };
    const item = ItemIdSchema.parse(itemId ?? '');

    const data = await mondayQuery<{
      items: Array<{
        id: string;
        name: string;
        column_values: Array<{ id: string; text: string | null; display_value?: string | null }>;
      }>;
    }>(
      `query ($items: [ID!]) {
         items (ids: $items) {
           id
           name
           column_values (ids: ["${AMOUNT_COLUMN}", "${REQUESTED_COLUMN}", "${MATS_FREIGHT_COLUMN}", "${MATS_TAX_COLUMN}"]) {
             id
             text
             ... on FormulaValue { display_value }
             ... on MirrorValue { display_value }
           }
         }
       }`,
      { items: [item] },
    );

    const found = data.items?.[0];
    if (!found)
      throw new ValidationError(
        `monday item ${item} is not on the Deal Tracking board, or the token cannot see it`,
      );

    const amountCol = found.column_values.find((c) => c.id === AMOUNT_COLUMN);
    const raw = amountCol?.display_value ?? '';
    const amountMinor = parseAmountMinor(raw);
    const requestFlag = found.column_values.find((c) => c.id === REQUESTED_COLUMN)?.text ?? '';
    const matsFreightMinor = parseAmountMinor(
      found.column_values.find((c) => c.id === MATS_FREIGHT_COLUMN)?.display_value,
    );
    const matsTaxMinor = parseAmountMinor(
      found.column_values.find((c) => c.id === MATS_TAX_COLUMN)?.display_value,
    );

    return {
      itemId: item,
      itemName: found.name,
      raw,
      amountMinor,
      // Null rather than 0 when the desk has not answered yet: 0 would read as
      // "freight is free" and go straight onto a customer proposal.
      pending: amountMinor == null,
      requestFlag,
      matsFreightMinor,
      matsTaxMinor,
      fetchedAt: new Date().toISOString(),
    };
  });
}
