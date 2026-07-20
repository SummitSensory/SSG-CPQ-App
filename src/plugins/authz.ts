import type { FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from './auth.js';
import { assertCan, type Role } from '../authz/rbac.js';
import { isRole } from '../authz/permissions.js';
import { UnauthorizedError } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { sub: string; role: Role };
  }
}

/** Attach the authenticated principal to the request. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const claims = await authenticate(req);
  if (!isRole(claims.role)) throw new UnauthorizedError('Unknown role');
  req.user = { sub: claims.sub, role: claims.role };
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
