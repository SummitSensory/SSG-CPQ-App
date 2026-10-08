import { decodeJwt, jwtVerify } from 'jose';
import { env } from '../../config/env.js';

/**
 * How old a signed delivery may be. monday's JWT does not cover the request body,
 * so a token observed once (a proxy log, a debug capture) could otherwise be
 * replayed with any body for as long as it verifies. Five minutes is generous for
 * a delivery in flight; the minute of clock tolerance absorbs skew either way.
 */
export const MONDAY_WEBHOOK_MAX_AGE = '5m';
const CLOCK_TOLERANCE_SECONDS = 60;

/**
 * Verify a monday webhook. monday signs each delivery with a JWT in the
 * Authorization header, signed with the account signing secret (HS256).
 *
 * When the token carries `iat` (monday's do), it must be recent — see
 * MONDAY_WEBHOOK_MAX_AGE. A token with no `iat` cannot be aged, so it is checked
 * on signature (and `exp`/`nbf`, when present) alone; refusing it outright would
 * drop every delivery if monday ever omitted the claim. That residual replay
 * window (an iat-less token with no exp stays valid indefinitely) is a known,
 * accepted limitation: the only real fix is an iat from monday, or rotating
 * MONDAY_SIGNING_SECRET if a token is ever known to have leaked.
 */
export async function verifyMondayWebhook(authHeader: string | undefined): Promise<boolean> {
  if (!authHeader || !env.MONDAY_SIGNING_SECRET) return false;
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  try {
    let hasIat = false;
    try {
      hasIat = typeof decodeJwt(token).iat === 'number';
    } catch {
      return false;
    }
    await jwtVerify(token, new TextEncoder().encode(env.MONDAY_SIGNING_SECRET), {
      algorithms: ['HS256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      ...(hasIat ? { maxTokenAge: MONDAY_WEBHOOK_MAX_AGE } : {}),
    });
    return true;
  } catch {
    return false;
  }
}
