import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare a caller-supplied secret with the configured one in constant time.
 *
 * `===` on strings returns at the first differing character, so response timing
 * leaks how much of a guess was right. Both sides are hashed first so the lengths
 * match (timingSafeEqual requires it) and the length of the real secret is not
 * leaked either.
 */
export function secretsEqual(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** True when an Authorization header is exactly `Bearer <secret>`. */
export function isBearerSecret(authorization: string | undefined, secret: string): boolean {
  return secretsEqual(authorization ?? '', `Bearer ${secret}`);
}
