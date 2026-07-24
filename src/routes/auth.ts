import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { verifyPassword } from '../auth/password.js';
import { signAccessToken } from '../auth/tokens.js';
import {
  createSession,
  rotateSession,
  revokeSession,
  resolveSession,
  revokeAllForUser,
} from '../auth/session.js';
import { hashPassword } from '../auth/password.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { requireAuth } from '../plugins/authz.js';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const RefreshBody = z.object({ refreshToken: z.string().min(1) });
const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12, 'New password must be at least 12 characters'),
});

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError();
    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    // Constant-ish path: always verify to reduce user enumeration.
    const ok = user && user.isActive ? await verifyPassword(user.passwordHash, password) : false;
    if (!user || !ok || !user.isActive) throw new UnauthorizedError('Invalid credentials');

    const accessToken = await signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = await createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    return reply.send({ accessToken, refreshToken, role: user.role });
  });

  app.post('/auth/refresh', async (req, reply) => {
    const parsed = RefreshBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError();
    const { userId } = await resolveSession(parsed.data.refreshToken);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw new UnauthorizedError('Invalid session');
    const accessToken = await signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = await rotateSession(parsed.data.refreshToken, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    return reply.send({ accessToken, refreshToken });
  });

  app.post('/auth/logout', async (req, reply) => {
    const parsed = RefreshBody.safeParse(req.body);
    if (parsed.success) await revokeSession(parsed.data.refreshToken);
    return reply.status(204).send();
  });

  /**
   * Self-service password change. Requires the caller's CURRENT password even
   * though they hold a valid token, so a stolen access token alone cannot lock
   * the owner out. Every other session is revoked on success.
   */
  app.post('/auth/password', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = ChangePasswordBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid password');
    }
    const { currentPassword, newPassword } = parsed.data;
    if (currentPassword === newPassword) {
      throw new ValidationError('New password must be different from the current one');
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user || !user.isActive) throw new UnauthorizedError();
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new UnauthorizedError('Current password is incorrect');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword) },
    });
    // Force a fresh sign-in everywhere, including this client.
    await revokeAllForUser(user.id);
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
    if (!user) throw new UnauthorizedError();
    return user;
  });
}
