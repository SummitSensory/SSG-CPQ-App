/**
 * Guards that can refuse a user's action, and the switch that decides whether they do.
 *
 * Two of the audit's fixes are capable of stopping work rather than allowing it:
 *
 *   1. proposal content validation — could refuse a save of a legacy proposal whose
 *      stored numbers predate the rules;
 *   2. the document-total check — could refuse an e-sign send or a monday upload whose
 *      rendered total the matcher fails to find.
 *
 * Both are correct in principle and both were reasoned about carefully, but neither has
 * been exercised against this business's real data or its real proposal template. A
 * guard that wrongly refuses is worse than the problem it prevents: it stops a rep
 * mid-deal with an error they cannot act on.
 *
 * So they ship in MONITOR mode. The guard runs, the outcome is logged with everything
 * needed to judge it, and the request proceeds. After a week of logs showing what would
 * have been refused — and confirming it is only ever a genuine mismatch — set
 * `STRICT_PROPOSAL_GUARDS=true` and they begin enforcing.
 *
 * Deliberately one flag, not two. Two flags mean four states, and nobody remembers
 * which pair is live in production.
 */
import { logger } from './logger.js';

/** True once the business is ready for these guards to refuse rather than report. */
export function guardsEnforce(): boolean {
  return String(process.env.STRICT_PROPOSAL_GUARDS ?? '').toLowerCase() === 'true';
}

/**
 * Apply a guard's verdict.
 *
 * In enforcing mode, throws whatever the caller built. In monitor mode, logs at WARN
 * with `guard` and `wouldBlock: true` so the occurrences are trivially searchable, and
 * returns so the request continues. Returns nothing either way; the call reads as a
 * statement, not a condition.
 */
export function enforceOrReport(
  guard: string,
  detail: Record<string, unknown>,
  buildError: () => Error,
): void {
  if (guardsEnforce()) throw buildError();
  logger.warn(
    { guard, wouldBlock: true, ...detail },
    `guard ${guard} would have refused this request (monitor mode)`,
  );
}
