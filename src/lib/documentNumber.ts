/**
 * Sequential document numbers that survive two people pressing the button at once.
 *
 * `P-2026-000079` and `SO-2026-000012` are allocated read-then-write: find the
 * highest existing number for the year, add one, insert. Two concurrent creates read
 * the same highest number and try to insert the same next one. `number` is `@unique`
 * on both Proposal and AcceptedOrder, so the loser did not corrupt anything — it
 * crashed with a Prisma P2002 and the user saw a 500 on a document that, from their
 * side, simply failed to exist. With two reps working the same list, or an accept and
 * a create landing together, that is a routine collision rather than an exotic one.
 *
 * This wraps the insert in a bounded retry: on a unique-constraint violation of the
 * number column, re-read the high-water mark and try the next one. Deliberately not a
 * database sequence — the format is `PREFIX-YEAR-NNNNNN` with a per-year restart,
 * which a bare sequence cannot express, and changing the storage of a number printed
 * on signed customer documents is not a change to make inside an audit.
 */

/** Prisma's unique-constraint error code, matched without importing the runtime. */
export function isUniqueViolation(err: unknown, field?: string): boolean {
  const e = err as { code?: unknown; meta?: { target?: unknown } } | null;
  if (!e || e.code !== 'P2002') return false;
  if (!field) return true;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.some((t) => String(t).includes(field));
  if (typeof target === 'string') return target.includes(field);
  // No target information — treat it as ours rather than surfacing a 500.
  return true;
}

/** `P-2026-000079` → 79. Anything unparseable counts as 0, never NaN. */
export function sequenceOf(number: string | null | undefined, prefix: string): number {
  if (!number || !number.startsWith(prefix)) return 0;
  const n = parseInt(number.slice(prefix.length), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function formatNumber(prefix: string, seq: number, width = 6): string {
  return `${prefix}${String(seq).padStart(width, '0')}`;
}

export interface AllocateOptions<T> {
  /** e.g. `P-2026-`. Used to find this year's numbers and to build the next one. */
  prefix: string;
  /** Highest number currently on record for this prefix, or null. */
  highest: () => Promise<string | null>;
  /** Insert using the allocated number. Must throw P2002 on a collision. */
  create: (number: string) => Promise<T>;
  /** Override the rendering of prefix + sequence. Defaults to six zero-padded digits. */
  format?: (seq: number) => string;
  /** Attempts before giving up. Six covers far more contention than this app sees. */
  attempts?: number;
  /** The unique column, so an unrelated P2002 is not swallowed as a collision. */
  field?: string;
}

/**
 * Allocate the next number and create the row, retrying past collisions.
 *
 * Each attempt re-reads the high-water mark, so a retry cannot reuse the number it
 * just lost. A P2002 on any OTHER unique column is rethrown untouched — a duplicate
 * proposalVersionId on an accepted order means "this version is already accepted",
 * which must keep reaching the caller as the conflict it is.
 */
export async function allocateNumbered<T>(
  opts: AllocateOptions<T>,
): Promise<{ number: string; row: T }> {
  const attempts = opts.attempts ?? 6;
  const render = opts.format ?? ((seq: number) => formatNumber(opts.prefix, seq));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const number = render(sequenceOf(await opts.highest(), opts.prefix) + 1);
    try {
      return { number, row: await opts.create(number) };
    } catch (err) {
      if (!isUniqueViolation(err, opts.field)) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Could not allocate a document number after repeated collisions');
}
