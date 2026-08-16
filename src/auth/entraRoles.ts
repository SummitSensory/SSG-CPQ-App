import { ROLES, type Role } from '../authz/permissions.js';

/**
 * Mapping Entra group membership onto this app's roles.
 *
 * Kept side-effect free and separate from the sign-in route so the precedence
 * rules can be unit-tested without an OIDC round trip.
 *
 * Entra decides *whether* somebody may sign in. This decides what they may do once
 * they are in — which until now was always READ_ONLY plus a manual promotion, so
 * every new hire's first day involved an admin.
 */

/**
 * Privilege order, most to least. This exists for exactly one situation: a person
 * who is in two or more mapped groups. Azure has no notion of which of a user's
 * groups "wins", so the app has to say, and the safe answer is not "the last one
 * parsed" — it is a stated order somebody can read and argue with.
 *
 * The ranking is by breadth of access, not seniority. ACCOUNTING sits above
 * OPERATIONS because it can write to QuickBooks; SALES_MANAGER above SALES_REP
 * because it can release and accept. INSTALLER and READ_ONLY are the floor.
 */
export const ROLE_RANK: readonly Role[] = [
  'SYSTEM_ADMIN',
  'EXECUTIVE',
  'SALES_MANAGER',
  'ACCOUNTING',
  'OPERATIONS',
  'PROJECT_MANAGER',
  'ESTIMATOR',
  'DESIGNER',
  'SALES_REP',
  'INSTALLER',
  'READ_ONLY',
];

/** Every role must be ranked, or `pickRole` would silently drop one. */
const rankOf = (r: Role): number => {
  const i = ROLE_RANK.indexOf(r);
  return i === -1 ? ROLE_RANK.length : i;
};

export interface RoleMapEntry {
  /** Group object id, or group name — whatever the claim will contain. */
  key: string;
  role: Role;
}

export interface ParsedRoleMap {
  entries: RoleMapEntry[];
  /** Lines that could not be read, so a typo in Vercel is visible not silent. */
  problems: string[];
}

/**
 * Parse `ENTRA_ROLE_MAP`.
 *
 * Format is one `key=ROLE` pair per entry, separated by commas or newlines:
 *
 *     8f2c…=SYSTEM_ADMIN, 41ab…=SALES_REP
 *     d0e9…=ACCOUNTING
 *
 * `key` is normally the group's object id, because that is what a cloud-only
 * Entra tenant puts in the `groups` claim. A group *name* is accepted too, for
 * tenants configured to emit names — the comparison is on whatever strings arrive.
 *
 * An unrecognised role name is reported rather than ignored. A role map with a
 * typo'd role silently granting nobody anything is the kind of thing that gets
 * discovered weeks later by the person who cannot do their job.
 */
export function parseRoleMap(raw: string | undefined | null): ParsedRoleMap {
  const entries: RoleMapEntry[] = [];
  const problems: string[] = [];
  if (!raw || !raw.trim()) return { entries, problems };

  for (const chunk of raw.split(/[,\n]/)) {
    const line = chunk.trim();
    if (!line) continue;
    const at = line.indexOf('=');
    if (at === -1) {
      problems.push(`"${line}" is not a key=ROLE pair`);
      continue;
    }
    const key = line.slice(0, at).trim();
    const role = line
      .slice(at + 1)
      .trim()
      .toUpperCase();
    if (!key) {
      problems.push(`"${line}" has no group id`);
      continue;
    }
    if (!(ROLES as readonly string[]).includes(role)) {
      problems.push(`"${role}" is not a role (${ROLES.join(', ')})`);
      continue;
    }
    entries.push({ key: key.toLowerCase(), role: role as Role });
  }
  return { entries, problems };
}

/**
 * The role a set of group claims earns, or null when none of them is mapped.
 *
 * Null is meaningfully different from READ_ONLY: it means Azure has said nothing
 * about this person, so the caller should leave an existing user's role alone
 * rather than demote them on their next sign-in.
 */
export function pickRole(groups: readonly string[], map: ParsedRoleMap): Role | null {
  if (!groups.length || !map.entries.length) return null;
  const claimed = new Set(groups.map((g) => String(g).trim().toLowerCase()).filter(Boolean));
  const hits = map.entries.filter((e) => claimed.has(e.key)).map((e) => e.role);
  if (!hits.length) return null;
  return hits.reduce((best, r) => (rankOf(r) < rankOf(best) ? r : best));
}
