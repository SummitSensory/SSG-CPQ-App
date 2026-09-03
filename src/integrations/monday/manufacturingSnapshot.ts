import { logger } from '../../lib/logger.js';
import { env, isMondayPushConfigured } from '../../config/env.js';
import { mondayQuery } from './client.js';
import { dealItemForVersion } from './dealReferences.js';
import { parseLinkedIds } from './crmMapping.js';

/**
 * Manufacturing Phase and Estimated Shipment Date, read off the Manufacturing
 * Process board — for the "is this order safe to ship" card on an order and
 * its proposal (see src/handoff/shippingReadiness.ts, which pairs this with
 * the outstanding QuickBooks balance).
 *
 * The join, confirmed against the live boards rather than assumed: the Deals
 * board carries a "connect boards" column (`connect_boards4__1`, titled
 * "Manufacturing Process") straight to the matching Manufacturing row — no
 * name-matching, no manual linking. Two hops, both already-solved problems:
 *
 *   proposal version -> deal item id      (dealItemForVersion, existing)
 *   deal item's connect column -> mfg id  (parseLinkedIds, existing)
 *
 * then one more read for the two columns themselves. Every column id is
 * env-overridable, the same convention portalInvite.ts uses for this board,
 * so a column rebuilt in monday is a config change rather than a deploy.
 */

const RELATION_COL = env.MONDAY_DEAL_MFG_RELATION_COLUMN ?? 'connect_boards4__1';
const MFG_STATUS_COL = env.MONDAY_MFG_STATUS_COLUMN ?? 'status__1';
const MFG_SHIP_DATE_COL = env.MONDAY_MFG_SHIP_DATE_COLUMN ?? 'mirror7__1';

export interface ManufacturingSnapshot {
  /** The Manufacturing Process item id, once resolved. */
  itemId: string | null;
  /** "Manufacturing Phase" — a status label, e.g. "Ready for Manufacturing". */
  status: string | null;
  /** "Estimated Shipment Date" — printed as monday renders it; not reparsed. */
  shipDate: string | null;
  /** Why itemId/status/shipDate are null, in words a rep can act on. Absent on success. */
  note: string | null;
}

const EMPTY = (note: string | null): ManufacturingSnapshot => ({
  itemId: null,
  status: null,
  shipDate: null,
  note,
});

/** The deal item's connect-to-Manufacturing column -> the linked item id, if any. */
async function manufacturingItemForDeal(dealItemId: string): Promise<string | null> {
  const data = await mondayQuery<{
    items: Array<{ column_values: Array<{ id: string; value: string | null }> }>;
  }>(
    `query ($items: [ID!]) {
       items (ids: $items) { column_values (ids: ["${RELATION_COL}"]) { id value } }
     }`,
    { items: [dealItemId] },
  );
  const raw = data.items?.[0]?.column_values?.[0]?.value ?? null;
  // A deal could in principle connect to more than one manufacturing row (a
  // split order); there is no ordering signal to prefer one, so the first is
  // taken and this is the one place that would need revisiting if that ever
  // becomes a real case rather than a theoretical one.
  return parseLinkedIds(raw)[0] ?? null;
}

/** Manufacturing Phase + Estimated Shipment Date for one proposal version's job. */
export async function manufacturingSnapshotForVersion(
  proposalVersionId: string,
): Promise<ManufacturingSnapshot> {
  if (!isMondayPushConfigured()) {
    return EMPTY('monday.com is not configured on this deployment.');
  }

  const dealItemId = await dealItemForVersion(proposalVersionId).catch((err: unknown) => {
    logger.warn({ err, proposalVersionId }, 'manufacturing snapshot: deal lookup failed');
    return null;
  });
  if (!dealItemId) {
    return EMPTY('This job is not linked to a monday deal row yet.');
  }

  let mfgItemId: string | null;
  try {
    mfgItemId = await manufacturingItemForDeal(dealItemId);
  } catch (err) {
    logger.warn({ err, dealItemId }, 'manufacturing snapshot: relation read failed');
    return EMPTY('Could not read the deal row on monday just now.');
  }
  if (!mfgItemId) {
    return EMPTY('The deal row is not connected to a Manufacturing Process row yet.');
  }

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
           column_values (ids: ["${MFG_STATUS_COL}", "${MFG_SHIP_DATE_COL}"]) {
             id
             text
             ... on MirrorValue { display_value }
           }
         }
       }`,
      { items: [mfgItemId] },
    );
    const found = data.items?.[0];
    if (!found) {
      return {
        itemId: mfgItemId,
        status: null,
        shipDate: null,
        note: 'monday returned no item with this id.',
      };
    }
    const text: Record<string, string> = {};
    for (const c of found.column_values ?? []) {
      text[c.id] = String(c.display_value ?? c.text ?? '').trim();
    }
    return {
      itemId: mfgItemId,
      status: text[MFG_STATUS_COL] || null,
      shipDate: text[MFG_SHIP_DATE_COL] || null,
      note: null,
    };
  } catch (err) {
    logger.warn({ err, mfgItemId }, 'manufacturing snapshot: item read failed');
    return {
      itemId: mfgItemId,
      status: null,
      shipDate: null,
      note: 'Could not read the Manufacturing Process row on monday just now.',
    };
  }
}
