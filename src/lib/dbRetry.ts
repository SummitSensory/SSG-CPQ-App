import { setTimeout as sleep } from 'node:timers/promises';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

/**
 * Riding out a database that is briefly unreachable.
 *
 * Production runs on Neon, behind its connection pooler. Neon suspends an idle
 * compute and restarts computes for maintenance, and the pooler occasionally
 * drops a connection; for a few seconds either way Prisma answers with P1001
 * ("Can't reach database server") or one of its siblings. A page request in that
 * window gets a 500 and the person clicks again. A once-a-day cron gets no second
 * click — its work is skipped until tomorrow and an alert goes out for a fault
 * that had already healed (/cron/esign-reminders, 2026-10-22 14:01 UTC).
 *
 * So the cron entry points touch the database once, cheaply, before each sweep —
 * `ensureDbReachable()` — and retry THAT on transient connectivity errors only.
 * The sweeps themselves are not wrapped: re-running half-finished work is a
 * different question from waiting for a connection, and some sweeps send email.
 *
 * Anything that is not a connectivity error (a bad query, a missing column, a
 * constraint) throws on the first attempt, exactly as before. A connectivity
 * error that outlasts every attempt throws too, and the caller alerts as before.
 * Only a blip that heals inside the retry window goes unreported — and it is
 * still logged as a warning on every retry.
 */

/**
 * Prisma error codes that mean "could not talk to the database", as opposed to
 * "the database said no".
 *
 * - P1001 Can't reach database server
 * - P1002 Database server was reached but timed out
 * - P1008 Operations timed out
 * - P1017 Server has closed the connection
 */
export const TRANSIENT_DB_CODES: ReadonlySet<string> = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
]);

/**
 * True for a Prisma connectivity error. Duck-typed rather than `instanceof`:
 * a PrismaClientKnownRequestError carries the code on `code`, a
 * PrismaClientInitializationError (the same failure surfaced while the client
 * is first connecting) on `errorCode`, and the class identity is not stable
 * across bundling.
 */
export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, errorCode } = err as { code?: unknown; errorCode?: unknown };
  return (
    (typeof code === 'string' && TRANSIENT_DB_CODES.has(code)) ||
    (typeof errorCode === 'string' && TRANSIENT_DB_CODES.has(errorCode))
  );
}

export interface DbRetryOptions {
  /**
   * Pause before each retry, in ms; its length + 1 is the number of attempts.
   * Each attempt can itself spend up to the connection string's
   * `connect_timeout` (Prisma's default is 5 s) failing to connect, so the
   * default — 3 attempts, 2 s and 5 s apart — is worst case ~22 s, well inside
   * api/cron's 300 s maxDuration.
   */
  delaysMs?: readonly number[];
  /** Names the operation in the retry log line. */
  label?: string;
}

const DEFAULT_DELAYS_MS: readonly number[] = [2_000, 5_000];

/**
 * Run `fn`, retrying it on a transient database connectivity error. Any other
 * error is thrown immediately; a transient one that persists through every
 * attempt is thrown as the last error seen.
 *
 * Only for operations that are safe to run more than once — a read, or a
 * connection probe.
 */
export async function withDbRetry<T>(fn: () => Promise<T>, opts: DbRetryOptions = {}): Promise<T> {
  const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = delays[attempt];
      if (!isTransientDbError(err) || delay === undefined) throw err;
      logger.warn(
        { err, attempt: attempt + 1, of: delays.length + 1, retryInMs: delay, op: opts.label },
        'database unreachable; retrying',
      );
      await sleep(delay);
    }
  }
}

/**
 * A `SELECT 1`, retried through a transient outage. Call it at the top of a
 * scheduled sweep that opens with a database read, so a cold or briefly
 * unreachable database is waited out instead of failing the sweep.
 */
export async function ensureDbReachable(label?: string): Promise<void> {
  await withDbRetry(() => prisma.$queryRaw`SELECT 1`, { label });
}
