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

/**
 * What Goldberg needs before they can price the steel.
 *
 * They quote crating and freight from the weight, but the shape of the load is what
 * decides how it crates: how many welded legs are in it, and whether a trolley rail
 * is going in the same shipment. Both are answerable from the proposal's own lines,
 * so neither should be a question anybody has to ask.
 */
const WELDED_LEGS_COLUMN = '__of_welded_legs__1';
const TROLLEY_COLUMN = 'status7__1';

/**
 * A welded leg is a vertical post. The frame rules generate A-2245 as
 * (legs − ladder bays) and A-2246 as the ladder-bay posts, so the two quantities
 * together are the frame's leg count — which is why both are counted and neither
 * alone would be right.
 */
const LEG_PARTS = new Set(['A-2245', 'A-2246']);

/**
 * The trolley rail, sized from the frame length. The rail is the tell rather than
 * the trolley hardware: A07–A10 are the only parts that exist because a trolley
 * system is in the order.
 */
const TROLLEY_PARTS = new Set(['TR2000-A07', 'TR2000-A08', 'TR2000-A09', 'TR2000-A10']);

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
  /**
   * Legs and trolley as the builder counts them, from the same line list the weight
   * comes from. Optional: an older client sends neither, and the version on file is
   * counted instead.
   */
  weldedLegs: z.number().int().min(0).max(1000).optional(),
  trolley: z.boolean().optional(),
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

interface ProposalLineish {
  sku?: string;
  quantity?: number;
  optional?: boolean;
  components?: Array<{ part?: string; qty?: number }> | null;
}

export interface AdventureFacts {
  legs: number;
  trolley: boolean;
  /** False when the proposal has no Adventure Series content at all. */
  found: boolean;
}

/**
 * Count the welded legs and spot a trolley rail in a set of proposal lines.
 *
 * Parts arrive two ways and both are counted: as a line in their own right, and as a
 * component of a kit line (an Adventure frame is one customer-facing line carrying
 * its real part numbers underneath — see the bundle/kit comment in the builder). A
 * component's quantity is per parent unit, so it is multiplied by the parent's.
 *
 * Optional lines are excluded, exactly as they are from the shipment weight: a
 * trolley the customer has not bought is not in the load Goldberg is pricing.
 */
export function adventureFacts(items: unknown): AdventureFacts {
  const lines: ProposalLineish[] = Array.isArray(items) ? (items as ProposalLineish[]) : [];
  let legs = 0;
  let trolley = false;

  for (const line of lines) {
    if (line?.optional) continue;
    const qty = Number(line?.quantity) || 0;
    const sku = String(line?.sku ?? '')
      .trim()
      .toUpperCase();
    if (LEG_PARTS.has(sku)) legs += qty;
    if (TROLLEY_PARTS.has(sku)) trolley = true;

    for (const c of line?.components ?? []) {
      const part = String(c?.part ?? '')
        .trim()
        .toUpperCase();
      const perParent = Number(c?.qty) || 0;
      if (LEG_PARTS.has(part)) legs += perParent * (qty || 1);
      if (TROLLEY_PARTS.has(part)) trolley = true;
    }
  }

  return { legs, trolley, found: legs > 0 || trolley };
}

/** The same count from the version on file, for a client that did not send one. */
async function adventureFactsFromVersion(proposalId: string): Promise<AdventureFacts> {
  const version = await prisma.proposalVersion.findFirst({
    where: { proposalId },
    orderBy: { version: 'desc' },
    select: { items: true },
  });
  return adventureFacts(version?.items);
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

/** One `change_multiple_column_values` call. */
async function writeColumns(itemId: string, cols: Record<string, unknown>): Promise<void> {
  await mondayQuery(
    `mutation ($board: ID!, $item: ID!, $cols: JSON!) {
       change_multiple_column_values (board_id: $board, item_id: $item, column_values: $cols) { id }
     }`,
    { board: DEALS_BOARD_ID, item: itemId, cols: JSON.stringify(cols) },
  );
}

export function registerFreightRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };

  /**
   * Raise the request, in the order the desk reads the row.
   *
   * TWO mutations, and the sequence is the point:
   *
   *   1. `# of Welded Legs` and `Trolley` — what the load is.
   *   2. `Approximate Weight` and `GB Freight Request` — how heavy, and "please quote".
   *
   * The flag is what Goldberg reacts to, so it flips LAST and only if the first write
   * succeeded. A row that says "quote this" while the legs column is still empty is a
   * question back to us, and that round trip is the thing this is meant to remove.
   *
   * Weight and flag stay in one mutation together, as before, so the board can never
   * hold a weight with no request against it or the reverse.
   *
   * A proposal with no Adventure Series content writes NEITHER of the two new
   * columns — not a zero and not a "No". There is nothing to say about legs on an
   * order that has none, and a false "No trolley" on the row reads as a fact somebody
   * checked.
   */
  app.post('/proposals/:id/freight-request', write, async (req) => {
    const { id } = req.params as { id: string };
    const input = RequestSchema.parse(req.body ?? {});

    // The builder counts from the same lines it weighed. Without those numbers (an
    // older client), count the version on file rather than leaving the row silent.
    const facts: AdventureFacts =
      input.weldedLegs != null || input.trolley != null
        ? {
            legs: input.weldedLegs ?? 0,
            trolley: !!input.trolley,
            found: (input.weldedLegs ?? 0) > 0 || !!input.trolley,
          }
        : await adventureFactsFromVersion(id);

    let ok = false;
    let error: string | null = null;
    let stage: 'load' | 'request' = 'load';
    try {
      /**
       * Written every time, not only when there is something to say.
       *
       * Gating this on `found` meant a proposal with no legs and no trolley left both
       * columns untouched — so a count from a PREVIOUS push stayed on the board,
       * describing a load that no longer exists. A revised proposal that drops the
       * frame is exactly when the desk most needs the row to be right.
       */
      await writeColumns(input.itemId, {
        [WELDED_LEGS_COLUMN]: String(facts.legs),
        [TROLLEY_COLUMN]: { label: facts.trolley ? 'Yes' : 'No' },
      });
      stage = 'request';
      await writeColumns(input.itemId, {
        [WEIGHT_COLUMN]: String(Math.round(input.weightLb * 100) / 100),
        [REQUESTED_COLUMN]: { label: 'Yes' },
      });
      ok = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'monday update failed';
      logger.error({ err: error, itemId: input.itemId, stage }, 'freight request push failed');
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
        weldedLegs: facts.found ? facts.legs : null,
        trolley: facts.found ? facts.trolley : null,
        failedAt: ok ? null : stage,
        error,
      },
    });

    if (!ok) {
      // Naming the stage matters: "the legs never landed" and "the flag never flipped"
      // need different things done about them.
      const where =
        stage === 'load'
          ? 'the welded legs and trolley columns'
          : 'the weight and freight request columns';
      throw new ValidationError(`monday.com did not accept ${where}: ${error}`);
    }
    return {
      ok: true,
      itemId: input.itemId,
      weightLb: input.weightLb,
      weldedLegs: facts.found ? facts.legs : null,
      trolley: facts.found ? facts.trolley : null,
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
           column_values (ids: ["${AMOUNT_COLUMN}", "${REQUESTED_COLUMN}", "${MATS_FREIGHT_COLUMN}", "${MATS_TAX_COLUMN}", "${WELDED_LEGS_COLUMN}", "${TROLLEY_COLUMN}"]) {
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
      // Echoed back so the builder can show what the desk is looking at, and so a
      // row edited by hand on the board is visible rather than silently overwritten.
      weldedLegs: found.column_values.find((c) => c.id === WELDED_LEGS_COLUMN)?.text ?? '',
      trolley: found.column_values.find((c) => c.id === TROLLEY_COLUMN)?.text ?? '',
      fetchedAt: new Date().toISOString(),
    };
  });
}
