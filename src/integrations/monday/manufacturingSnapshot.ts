import { logger } from '../../lib/logger.js';
import { env, isMondayPushConfigured } from '../../config/env.js';
import { mondayQuery } from './client.js';
import { dealItemForVersion } from './dealReferences.js';
import { searchItemsByName } from './discovery.js';
import { manufacturingBoardId } from './portalInvite.js';

/**
 * Manufacturing Phase and Estimated Shipment Date, read off the Manufacturing
 * Process board — for the "is this order safe to ship" card on an order and
 * its proposal (see src/handoff/shippingReadiness.ts, which pairs this with
 * the outstanding QuickBooks balance).
 *
 * The join was checked twice against the live boards before landing here.
 * The first version read the Deals board's "connect boards" column straight
 * to the Manufacturing row — the column exists and is titled correctly, but
 * a 100-row sample of real Manufacturing items came back with it unset on
 * every single one, including jobs already marked Shipped. So it is not
 * actually in use, whatever it was built for.
 *
 * What IS reliable: a Manufacturing row's name tracks its deal's name (the
 * customer's name, sometimes with a suffix — "(Frame Relocation
 * Installation)"). So the deal item's own name is used as a search term
 * against the Manufacturing board, the same `searchItemsByName` a proposal's
 * own monday lookups already use. A customer with more than one job can
 * match more than one row; there is no field that says which order a row is
 * for, so the most recently CREATED match is taken — monday item ids are
 * assigned in increasing order account-wide, so the highest id wins.
 */

const MFG_STATUS_COL = env.MONDAY_MFG_STATUS_COLUMN ?? 'status__1';
const MFG_SHIP_DATE_COL = env.MONDAY_MFG_SHIP_DATE_COLUMN ?? 'mirror7__1';

export interface ManufacturingSnapshot {
  /** The Manufacturing Process item id, once resolved. */
  itemId: string | null;
  /** "Manufacturing Phase" — a status label, e.g. "Ready for Manufacturing". */
  status: string | null;
  /**
   * "Estimated Shipment Date" — printed as monday renders it, not reparsed.
   * Empty on nearly every job today; that is the point of showing it rather
   * than a reason to hide it (see the ship-date highlight in the UI).
   */
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

/** The deal item's own name — the search term for its Manufacturing row. */
async function dealItemName(dealItemId: string): Promise<string | null> {
  const data = await mondayQuery<{ items: Array<{ name: string }> }>(
    `query ($items: [ID!]) { items (ids: $items) { name } }`,
    { items: [dealItemId] },
  );
  return data.items?.[0]?.name?.trim() || null;
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

  let dealName: string | null;
  try {
    dealName = await dealItemName(dealItemId);
  } catch (err) {
    logger.warn({ err, dealItemId }, 'manufacturing snapshot: deal name read failed');
    return EMPTY('Could not read the deal row on monday just now.');
  }
  if (!dealName) {
    return EMPTY('The deal row on monday has no name to match a Manufacturing row against.');
  }

  try {
    const matches = await searchItemsByName(manufacturingBoardId(), dealName, 25);
    if (!matches.length) {
      return EMPTY(`No Manufacturing Process row matches “${dealName}” yet.`);
    }
    // Highest numeric id = most recently created. Safe as a plain Number
    // comparison: monday ids run well under Number.MAX_SAFE_INTEGER.
    const item = matches.reduce((best, m) => (Number(m.id) > Number(best.id) ? m : best));
    return {
      itemId: item.id,
      status: item.text[MFG_STATUS_COL] || null,
      shipDate: item.text[MFG_SHIP_DATE_COL] || null,
      note:
        matches.length > 1
          ? `Matched by name — ${matches.length} rows share “${dealName}”; the newest was used.`
          : null,
    };
  } catch (err) {
    logger.warn({ err, dealName }, 'manufacturing snapshot: board search failed');
    return EMPTY('Could not search the Manufacturing Process board on monday just now.');
  }
}
