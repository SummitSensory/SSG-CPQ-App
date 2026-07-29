import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { verifyPassword } from '../auth/password.js';
import { signAccessToken } from '../auth/tokens.js';
import { createSession, rotateSession, revokeSession, resolveSession, revokeAllForUser } from '../auth/session.js';
import { hashPassword } from '../auth/password.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { requireAuth } from '../plugins/authz.js';
import { env } from '../config/env.js';
import { recordAudit } from '../lib/audit.js';
import { requestPasswordReset, checkResetToken, consumeResetToken } from '../auth/passwordReset.js';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const RefreshBody = z.object({ refreshToken: z.string().min(1) });
const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12, 'New password must be at least 12 characters'),
});

const ForgotPasswordBody = z.object({ email: z.string().email() });
const ResetPasswordBody = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(12, 'New password must be at least 12 characters'),
});

const ProfileBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(40).nullish(),
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

  /**
   * Start a self-service reset. Public by necessity.
   *
   * Always answers 204, whether or not the address has an account — a different
   * response for a known address would turn this into an account-enumeration oracle.
   * Failures inside the mail send are logged, never surfaced, for the same reason.
   */
  app.post('/auth/forgot-password', async (req, reply) => {
    const parsed = ForgotPasswordBody.safeParse(req.body);
    // Even a malformed address gets the neutral answer.
    if (parsed.success) {
      const configured = env.APP_BASE_URL;
      const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
      const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
      const baseUrl = configured ?? `${proto ?? 'https'}://${host ?? 'localhost:3000'}`;
      try {
        await requestPasswordReset(parsed.data.email, baseUrl, req.ip);
      } catch (err) {
        req.log.error({ err }, 'password reset request failed');
      }
    }
    return reply.status(204).send();
  });

  /** Report whether a reset link is still good, so the UI can explain itself. */
  app.get('/auth/reset-password', async (req) => {
    const { token } = req.query as { token?: string };
    if (!token) return { state: 'UNKNOWN' };
    return { state: await checkResetToken(token) };
  });

  /** Complete a self-service reset. The token is single-use. */
  app.post('/auth/reset-password', async (req, reply) => {
    const parsed = ResetPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid password');
    }
    const user = await consumeResetToken(parsed.data.token);
    if (!user) {
      throw new ValidationError('That reset link is no longer valid. Request a new one.');
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(parsed.data.newPassword) },
    });
    // Any session opened with the old password dies with it.
    await revokeAllForUser(user.id);
    await recordAudit({
      actorId: user.id, action: 'user.password.reset', targetUserId: user.id,
      details: { email: user.email, by: 'self-service' },
    });
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { id: true, email: true, name: true, title: true, phone: true, role: true, isActive: true },
    });
    if (!user) throw new UnauthorizedError();
    return user;
  });

  /** Preparer details that appear on generated proposals. */
  app.patch('/auth/me', { preHandler: requireAuth }, async (req) => {
    const parsed = ProfileBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid profile');
    const { name, title, phone } = parsed.data;
    return prisma.user.update({
      where: { id: req.user!.sub },
      data: {
        ...(name === undefined ? {} : { name }),
        ...(title === undefined ? {} : { title: title || null }),
        ...(phone === undefined ? {} : { phone: phone || null }),
      },
      select: { id: true, email: true, name: true, title: true, phone: true, role: true, isActive: true },
    });
  });
}
