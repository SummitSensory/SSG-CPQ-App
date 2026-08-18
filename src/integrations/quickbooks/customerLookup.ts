import { query } from './client.js';

/**
 * Find a QuickBooks customer by name when CPQ has no link to one yet.
 *
 * Two problems this exists to solve, both of which read as "the customer is not in
 * QuickBooks" when they plainly are:
 *
 *   1. The profile panel only ever queried QuickBooks when a QboEntityLink already
 *      existed, so an unlinked customer showed "Not in QuickBooks" on every row
 *      without a single search having been made.
 *   2. The adoption step in `findOrCreateCustomer` matched on `DisplayName = '…'`
 *      exactly. CRM names imported from monday carry the deal code — "The Therapy
 *      Spot LLC (R-4MBL1Z)" — while the accountant typed "The Therapy Spot LLC".
 *      Exact equality never matched, so the push created a second customer next to
 *      the real one.
 *
 * Four passes, most exact first, so an adoption is never a guess:
 *   exact name → exact name with the trailing "(CODE)" stripped → the same against
 *   CompanyName → prefix LIKE on the stripped name, accepted only when it returns
 *   exactly one customer.
 *
 * Read-only, and it never throws on a bad query: a lookup failure means "no match
 * found", which leaves the caller behaving exactly as it did before.
 */

export interface QboNamedCustomer {
  Id: string;
  SyncToken: string;
  DisplayName?: string;
  CompanyName?: string;
  Active?: boolean;
}

export type NameMatchKind = 'exact' | 'code-stripped' | 'company-name' | 'prefix';

export interface QboNameMatch<T extends QboNamedCustomer> {
  customer: T;
  matchedOn: NameMatchKind;
  /** The name actually searched on, for the log line and the operator-facing note. */
  searchedFor: string;
}

/** Escape a QuickBooks query string literal. */
const esc = (s: string): string => s.replace(/'/g, "\\'");

/**
 * Drop a trailing account/deal code in parentheses or brackets — "The Therapy Spot
 * LLC (R-4MBL1Z)" becomes "The Therapy Spot LLC". Only a trailing group of code-like
 * characters is removed, so "Soar Autism Center (Fort Collins)" keeps its location.
 */
export function stripAccountCode(name: string): string {
  return String(name ?? '')
    .replace(/[\s]*[([][A-Z0-9][A-Z0-9-]{2,}[)\]]\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** LIKE wildcards are not escapable in the QuickBooks query language — drop them. */
const noWildcards = (s: string): string => s.replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim();

const sameish = (a: string, b: string): boolean =>
  String(a ?? '')
    .toLowerCase()
    .replace(/[.,#]/g, '')
    .replace(/\s+/g, ' ')
    .trim() ===
  String(b ?? '')
    .toLowerCase()
    .replace(/[.,#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export async function findQboCustomerByName<T extends QboNamedCustomer = QboNamedCustomer>(
  realmId: string,
  displayName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QboNameMatch<T> | null> {
  const full = String(displayName ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!full) return null;
  const stripped = stripAccountCode(full);

  const run = async (where: string): Promise<T[]> => {
    try {
      const res = await query<{ Customer?: T[] }>(
        realmId,
        `select * from Customer where ${where}`,
        fetchImpl,
      );
      return res.Customer ?? [];
    } catch {
      return [];
    }
  };
  // An active customer is what anyone means by "already in QuickBooks"; a
  // deactivated one is only adopted when it is the sole match.
  const pick = (rows: T[]): T | null => rows.find((c) => c.Active !== false) ?? rows[0] ?? null;

  const exact = pick(await run(`DisplayName = '${esc(full)}'`));
  if (exact) return { customer: exact, matchedOn: 'exact', searchedFor: full };

  if (stripped && stripped !== full) {
    const bare = pick(await run(`DisplayName = '${esc(stripped)}'`));
    if (bare) return { customer: bare, matchedOn: 'code-stripped', searchedFor: stripped };
  }

  for (const candidate of stripped && stripped !== full ? [full, stripped] : [full]) {
    const byCompany = pick(await run(`CompanyName = '${esc(candidate)}'`));
    if (byCompany)
      return { customer: byCompany, matchedOn: 'company-name', searchedFor: candidate };
  }

  // Last pass: the accountant's name starts the same way but carries their own
  // suffix ("The Therapy Spot LLC - ABQ"). Accepted only when it is unambiguous:
  // one row, or one row whose name matches the stripped name case-insensitively.
  const term = noWildcards(stripped || full);
  if (term.length >= 4) {
    const rows = (await run(`DisplayName like '${esc(term)}%'`)).filter((c) => c.Active !== false);
    const exactish = rows.filter((c) => sameish(c.DisplayName ?? '', stripped || full));
    const only = exactish.length === 1 ? exactish[0] : rows.length === 1 ? rows[0] : null;
    if (only) return { customer: only, matchedOn: 'prefix', searchedFor: term };
  }
  return null;
}

/** How a match reads to an operator in the profile panel and the sync log. */
export function describeNameMatch(match: QboNameMatch<QboNamedCustomer>): string {
  const name = match.customer.DisplayName || match.customer.CompanyName || match.customer.Id;
  if (match.matchedOn === 'exact') return `"${name}" (id ${match.customer.Id}), matched by name`;
  if (match.matchedOn === 'code-stripped')
    return `"${name}" (id ${match.customer.Id}), matched once the account code was ignored`;
  if (match.matchedOn === 'company-name')
    return `"${name}" (id ${match.customer.Id}), matched on its QuickBooks company name`;
  return `"${name}" (id ${match.customer.Id}), the only customer whose name starts with "${match.searchedFor}"`;
}
