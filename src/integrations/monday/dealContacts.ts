import { isMondayPushConfigured } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { mondayQuery } from './client.js';
import { DEAL_COL } from './crmMapping.js';

export interface DealContact {
  email: string;
  phone: string;
}

/** monday's `items (ids:)` takes at most 100 ids per query. */
const CHUNK = 100;

/**
 * The customer email (email_1__1) and phone (phone__1) on each of these Deal Tracking
 * rows, keyed by item id.
 *
 * For screens that list many orders at once (belt shipments): one query per hundred
 * rows rather than one per order, and a hard cap on the whole read. The screen must
 * still load when monday is slow, so a read past `timeoutMs` — or any failure —
 * returns what it has (possibly nothing) and the caller falls back to the CRM's own
 * contact. Never throws.
 */
export async function readDealContacts(
  itemIds: string[],
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Map<string, DealContact>> {
  const out = new Map<string, DealContact>();
  const ids = Array.from(
    new Set(itemIds.map((i) => String(i).trim()).filter((i) => /^\d+$/.test(i))),
  );
  if (!ids.length || !isMondayPushConfigured()) return out;

  const work = (async () => {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const data = await mondayQuery<{
        items: Array<{ id: string; column_values: Array<{ id: string; text: string | null }> }>;
      }>(
        `query ($items: [ID!]) {
           items (ids: $items, limit: ${CHUNK}) {
             id
             column_values (ids: ["${DEAL_COL.contactEmail}", "${DEAL_COL.contactPhone}"]) { id text }
           }
         }`,
        { items: ids.slice(i, i + CHUNK) },
        opts.fetchImpl,
      );
      for (const item of data.items ?? []) {
        const text: Record<string, string> = {};
        for (const c of item.column_values ?? []) text[c.id] = String(c.text ?? '').trim();
        out.set(String(item.id), {
          email: text[DEAL_COL.contactEmail] ?? '',
          phone: text[DEAL_COL.contactPhone] ?? '',
        });
      }
    }
  })();

  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), opts.timeoutMs ?? 6_000);
  });
  try {
    const result = await Promise.race([work.then(() => 'done' as const), limit]);
    if (result === 'timeout') {
      logger.warn(
        { items: ids.length },
        'deal contacts: monday read timed out; using CRM contacts',
      );
    }
  } catch (err) {
    logger.warn(
      { err, items: ids.length },
      'deal contacts: monday read failed; using CRM contacts',
    );
  } finally {
    clearTimeout(timer);
  }
  // A read still running after the cap keeps going in the background; swallow its
  // eventual failure so it cannot surface as an unhandled rejection.
  work.catch(() => undefined);
  return new Map(out);
}
