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
 * ── The asymmetry that governs this whole module ──────────────────────────────
 *
 * Adoption writes CPQ's customer data over an existing QuickBooks customer. Get it
 * right and a duplicate is avoided. Get it WRONG — adopt a different customer who
 * merely has a similar name — and CPQ overwrites a real customer's address, email and
 * contact in the company's actual books, with no undo. One failure mode is untidy; the
 * other is unrecoverable.
 *
 * So matches are graded, and only the grades that cannot mean two different businesses
 * are allowed to adopt automatically:
 *
 *   exact         DisplayName is identical                         → auto-adopt
 *   code-stripped identical once a trailing "(R-4MBL1Z)" is removed → auto-adopt
 *   company-name  QuickBooks CompanyName is identical               → auto-adopt
 *   prefix        name merely STARTS with the same text             → NEVER auto-adopt
 *
 * The first three are equality tests on a normalised name; "The Therapy Spot LLC" and
 * "The Therapy Spot LLC (R-4MBL1Z)" are the same business by any reading. `prefix` is
 * not: "Soar Autism Center" prefix-matches "Soar Autism Center - Glendale", a genuinely
 * different site with its own invoices. It is still searched, because it is exactly
 * what a human needs to see in the profile panel — but it is returned as a SUGGESTION,
 * and `findOrCreateCustomer` will create a new customer rather than act on it.
 *
 * Additionally, an auto-adoptable pass that returns more than one active candidate is
 * demoted to a suggestion. Two customers with the same name is a bookkeeping question
 * for a person, not a coin flip for a script.
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

/** The passes whose match is an equality test, and so cannot mean a different business. */
const AUTO_ADOPT_KINDS: readonly NameMatchKind[] = ['exact', 'code-stripped', 'company-name'];

export interface QboNameMatch<T extends QboNamedCustomer> {
  customer: T;
  matchedOn: NameMatchKind;
  /** The name actually searched on, for the log line and the operator-facing note. */
  searchedFor: string;
  /**
   * Safe to adopt without a human looking first. False for a prefix match, and for an
   * otherwise-strong match that was ambiguous. Callers that WRITE must check this;
   * callers that only display may ignore it.
   */
  autoAdoptable: boolean;
  /** Set when a pass matched several active customers — why it was demoted. */
  ambiguousCount?: number;
}

/** Escape a QuickBooks query string literal. */
const esc = (s: string): string => s.replace(/'/g, "\\'");

/**
 * Drop a trailing account/deal code in parentheses or brackets — "The Therapy Spot
 * LLC (R-4MBL1Z)" becomes "The Therapy Spot LLC".
 *
 * Only a trailing group that LOOKS like a code is removed: at least three characters,
 * all uppercase letters, digits or hyphens, and containing at least one digit. That
 * last requirement is deliberate — it keeps "Soar Autism Center (Fort Collins)" and
 * "(West)" intact, because a location is part of the customer's identity and stripping
 * it would collapse two real customers into one name.
 */
export function stripAccountCode(name: string): string {
  const s = String(name ?? '').trim();
  const m = /[\s]*[([]([A-Z0-9][A-Z0-9-]{2,})[)\]]$/.exec(s);
  if (!m) return s.replace(/\s+/g, ' ');
  const code = m[1]!;
  if (!/[0-9]/.test(code)) return s.replace(/\s+/g, ' ');
  return s.slice(0, m.index).replace(/\s+/g, ' ').trim();
}

/** LIKE wildcards are not escapable in the QuickBooks query language — drop them. */
const noWildcards = (s: string): string => s.replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim();

const norm = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[.,#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const sameish = (a: string, b: string): boolean => norm(a) === norm(b);

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

  /**
   * Resolve one pass's rows into a verdict. An active customer is what anyone means by
   * "already in QuickBooks"; several active customers is an ambiguity a person must
   * settle, so the match is returned but flagged not-auto-adoptable.
   */
  const verdict = (
    rows: T[],
    matchedOn: NameMatchKind,
    searchedFor: string,
  ): QboNameMatch<T> | null => {
    const active = rows.filter((c) => c.Active !== false);
    const pool = active.length ? active : rows;
    if (!pool.length) return null;
    const auto = AUTO_ADOPT_KINDS.includes(matchedOn);
    if (active.length > 1) {
      return {
        customer: pool[0]!,
        matchedOn,
        searchedFor,
        autoAdoptable: false,
        ambiguousCount: active.length,
      };
    }
    // A single INACTIVE match is not adopted automatically either: reactivating a
    // customer the bookkeeper deliberately closed is their call, not this script's.
    return {
      customer: pool[0]!,
      matchedOn,
      searchedFor,
      autoAdoptable: auto && active.length === 1,
    };
  };

  const exact = verdict(await run(`DisplayName = '${esc(full)}'`), 'exact', full);
  if (exact) return exact;

  if (stripped && stripped !== full) {
    const bare = verdict(await run(`DisplayName = '${esc(stripped)}'`), 'code-stripped', stripped);
    if (bare) return bare;
  }

  for (const candidate of stripped && stripped !== full ? [full, stripped] : [full]) {
    const byCompany = verdict(
      await run(`CompanyName = '${esc(candidate)}'`),
      'company-name',
      candidate,
    );
    if (byCompany) return byCompany;
  }

  // Last pass: the accountant's name starts the same way but carries their own suffix.
  // Returned for a human to look at; never adopted automatically, because a suffix can
  // denote a different site of the same organisation, with its own invoices.
  const term = noWildcards(stripped || full);
  if (term.length >= 4) {
    const rows = (await run(`DisplayName like '${esc(term)}%'`)).filter((c) => c.Active !== false);
    if (rows.length) {
      const exactish = rows.filter((c) => sameish(c.DisplayName ?? '', stripped || full));
      const pick = exactish.length === 1 ? exactish[0]! : rows[0]!;
      return {
        customer: pick,
        matchedOn: 'prefix',
        searchedFor: term,
        autoAdoptable: false,
        ...(rows.length > 1 ? { ambiguousCount: rows.length } : {}),
      };
    }
  }
  return null;
}

/** How a match reads to an operator in the profile panel and the sync log. */
export function describeNameMatch(match: QboNameMatch<QboNamedCustomer>): string {
  const name = match.customer.DisplayName || match.customer.CompanyName || match.customer.Id;
  const id = match.customer.Id;
  if (match.ambiguousCount && match.ambiguousCount > 1) {
    return `${match.ambiguousCount} QuickBooks customers match "${match.searchedFor}" — including "${name}" (id ${id}). Link the right one by hand before pushing.`;
  }
  if (match.matchedOn === 'exact') return `"${name}" (id ${id}), matched by name`;
  if (match.matchedOn === 'code-stripped')
    return `"${name}" (id ${id}), matched once the account code was ignored`;
  if (match.matchedOn === 'company-name')
    return `"${name}" (id ${id}), matched on its QuickBooks company name`;
  return `"${name}" (id ${id}) starts with "${match.searchedFor}" but is not an exact match — check it is the same customer before linking`;
}
