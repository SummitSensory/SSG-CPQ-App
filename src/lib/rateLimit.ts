/**
 * A dependency-free, in-process rate limiter for the unauthenticated auth routes.
 *
 * `POST /auth/login`, `/auth/forgot-password` and `/auth/reset-password` had no
 * throttle of any kind: the repository declares no rate-limit plugin (see
 * package.json — there is no `@fastify/rate-limit`), and nothing in app.ts installs
 * one. An attacker could try passwords, or reset tokens, as fast as the function
 * would answer. `verifyPassword` is argon2, which makes each attempt expensive for
 * the SERVER as much as the attacker — so the same endpoint is also the cheapest
 * denial-of-service in the application.
 *
 * Scope, stated plainly because it matters operationally: this counts attempts in
 * ONE process's memory. On Vercel the API runs as serverless instances, so the real
 * ceiling is (limit x live instances) and a cold start forgets everything. That is a
 * material reduction in attack rate, not a hard bound. The durable fix is a shared
 * store (Redis/Postgres) or an edge rule at the platform; both are recorded as
 * follow-ups in the remediation log. Adding a dependency was deliberately avoided
 * here — an audit that cannot run `pnpm install` must not leave a lockfile the
 * deployment has never resolved.
 *
 * Deliberately keyed on IP + a caller-supplied discriminator (the submitted email,
 * lower-cased). Keying on IP alone lets one office NAT lock out a whole company;
 * keying on email alone lets an attacker rotate addresses. Either bucket tripping
 * is enough to refuse.
 */

export interface RateLimitRule {
  /** Attempts allowed inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Bound the map so a flood of distinct keys cannot grow it without limit. */
const MAX_KEYS = 10_000;

function prune(now: number): void {
  if (buckets.size < MAX_KEYS) return;
  for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
  if (buckets.size >= MAX_KEYS) buckets.clear();
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets — sent as Retry-After. */
  retryAfter: number;
  remaining: number;
}

export function hit(key: string, rule: RateLimitRule, now = Date.now()): RateLimitResult {
  prune(now);
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, retryAfter: 0, remaining: rule.limit - 1 };
  }
  existing.count += 1;
  if (existing.count > rule.limit) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  return { allowed: true, retryAfter: 0, remaining: rule.limit - existing.count };
}

/** Forget a key — called on a successful sign-in so one bad typo costs nothing. */
export function reset(key: string): void {
  buckets.delete(key);
}

/** Test seam: drop all state. */
export function clearAll(): void {
  buckets.clear();
}

export const AUTH_RULES = {
  /** Password attempts: 10 per 15 minutes per IP, and per address. */
  login: { limit: 10, windowMs: 15 * 60_000 } as RateLimitRule,
  /** Reset requests: 5 per hour. Enough for a confused user, not for a mail flood. */
  forgot: { limit: 5, windowMs: 60 * 60_000 } as RateLimitRule,
  /** Reset-token submissions: 20 per hour — a token is 32 bytes, this ends guessing. */
  reset: { limit: 20, windowMs: 60 * 60_000 } as RateLimitRule,
};
