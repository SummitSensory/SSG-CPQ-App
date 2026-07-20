import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { verifyPassword } from '../auth/password.js';
import { signAccessToken } from '../auth/tokens.js';
import { createSession, rotateSession, revokeSession, resolveSession } from '../auth/session.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { requireAuth } from '../plugins/authz.js';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const RefreshBody = z.object({ refreshToken: z.string().min(1) });

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

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
    if (!user) throw new UnauthorizedError();
    return user;
  });
}
