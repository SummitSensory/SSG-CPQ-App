import type { FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from './auth.js';
import { assertCan, type Role } from '../authz/rbac.js';
import { isRole } from '../authz/permissions.js';
import { UnauthorizedError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { sub: string; role: Role };
  }
}

/**
 * Live account state, cached briefly.
 *
 * The access token is a stateless JWT carrying the role, valid for its full TTL
 * (JWT_ACCESS_TTL, 15 minutes by default). Nothing checked the account behind it, so
 * for up to a full TTL after an admin deactivated a user or demoted them, their token
 * still opened every route their OLD role allowed — and `revokeAllForUser`, which
 * runs on a password change and a reset, revoked refresh sessions only. "Access after
 * a user is disabled" and "access after a role changes" were both open windows.
 *
 * Verified per request against the database, with a short in-process cache so the
 * common case is not a query per request. Five seconds is short enough that a
 * deactivation is effectively immediate and long enough to absorb a page's burst of
 * parallel calls. The cache holds only id, isActive and role — no credentials.
 */
interface AccountState {
  isActive: boolean;
  role: string;
  at: number;
}
const CACHE_MS = 5_000;
const accounts = new Map<string, AccountState>();

/** Test seam, and a safety valve for a long-lived process. */
export function clearAccountCache(): void {
  accounts.clear();
}

async function liveAccount(userId: string): Promise<AccountState | null> {
  const now = Date.now();
  const cached = accounts.get(userId);
  if (cached && now - cached.at < CACHE_MS) return cached;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isActive: true, role: true },
  });
  if (!user) {
    accounts.delete(userId);
    return null;
  }
  const state: AccountState = { isActive: user.isActive, role: user.role, at: now };
  if (accounts.size > 5_000) accounts.clear();
  accounts.set(userId, state);
  return state;
}

/** Attach the authenticated principal to the request. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const claims = await authenticate(req);
  if (!isRole(claims.role)) throw new UnauthorizedError('Unknown role');
  const account = await liveAccount(claims.sub);
  if (!account || !account.isActive) throw new UnauthorizedError('Account is not active');
  // The DATABASE role decides what happens next, never the token's copy of it. A
  // token minted before a demotion therefore cannot spend the old authority, and a
  // token whose role claim was tampered with is simply ignored.
  if (!isRole(account.role)) throw new UnauthorizedError('Unknown role');
  req.user = { sub: claims.sub, role: account.role };
}

/**
 * preHandler factory enforcing a permission on the SERVER — independent of any
 * UI. Returns 401 if unauthenticated, 403 if authenticated but not permitted.
 */
export function requirePermission(permission: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(req, reply);
    assertCan(req.user!.role, permission);
  };
}
