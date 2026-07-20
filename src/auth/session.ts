import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { UnauthorizedError } from '../lib/errors.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionContext {
  userAgent?: string;
  ip?: string;
}

/** Create a server-side session and return the opaque refresh token (shown once). */
export async function createSession(userId: string, ctx: SessionContext = {}): Promise<string> {
  const refreshToken = randomBytes(48).toString('base64url');
  await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: ctx.userAgent ?? null,
      ip: ctx.ip ?? null,
      expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL * 1000),
    },
  });
  return refreshToken;
}

/** Validate a refresh token against a live (unexpired, unrevoked) session. */
export async function resolveSession(refreshToken: string): Promise<{ userId: string; id: string }> {
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hashToken(refreshToken) },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw new UnauthorizedError('Invalid session');
  }
  return { userId: session.userId, id: session.id };
}

/** Rotate: revoke the old session and issue a new refresh token. */
export async function rotateSession(refreshToken: string, ctx: SessionContext = {}): Promise<string> {
  const current = await resolveSession(refreshToken);
  await prisma.session.update({ where: { id: current.id }, data: { revokedAt: new Date() } });
  return createSession(current.userId, ctx);
}

export async function revokeSession(refreshToken: string): Promise<void> {
  await prisma.session
    .update({ where: { refreshTokenHash: hashToken(refreshToken) }, data: { revokedAt: new Date() } })
    .catch(() => undefined);
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
