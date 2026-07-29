import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../auth/password.js';
import { revokeAllForUser } from '../auth/session.js';
import { recordAudit } from '../lib/audit.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission, ROLES, isRole } from '../authz/permissions.js';
import { ValidationError, NotFoundError, ConflictError } from '../lib/errors.js';

const CreateUserBody = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  password: z.string().min(12),
  role: z.enum(ROLES),
});
const RoleBody = z.object({ role: z.enum(ROLES) });
const ResetPasswordBody = z.object({ password: z.string().min(12) });

export function registerAdminRoutes(app: FastifyInstance): void {
  const guard = { preHandler: requirePermission(Permission.USERS_MANAGE) };

  app.get('/admin/users', guard, async () =>
    prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, isActive: true },
    }),
  );

  app.post('/admin/users', guard, async (req, reply) => {
    const parsed = CreateUserBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid user');
    const { email, name, password, role } = parsed.data;
    // Email is unique, so creating a duplicate threw an unhandled Prisma P2002 and
    // surfaced as a bare 500. Check first and say what actually happened.
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, isActive: true } });
    if (existing) {
      throw new ConflictError(
        existing.isActive
          ? 'A user with that email already exists.'
          : 'A deactivated user with that email already exists — reactivate them instead of creating a duplicate.',
      );
    }
    const user = await prisma.user.create({
      data: { email, name: name ?? null, role, passwordHash: await hashPassword(password) },
      select: { id: true, email: true, role: true },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'user.create',
      targetUserId: user.id,
      details: { role },
    });
    return reply.status(201).send(user);
  });

  /**
   * Admin-set password reset. Used when someone is locked out and cannot use the
   * self-service change-password flow (which requires the current password). Every
   * session is revoked, so the old password stops working everywhere immediately.
   */
  app.post('/admin/users/:id/reset-password', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ResetPasswordBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Password must be at least 12 characters');
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true } });
    if (!user) throw new NotFoundError('User not found');
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(parsed.data.password) },
    });
    await revokeAllForUser(user.id);
    await recordAudit({
      actorId: req.user!.sub, action: 'user.password.reset', targetUserId: user.id,
      details: { email: user.email, by: 'admin' },
    });
    return reply.status(204).send();
  });

  // Role assignment — always audited.
  app.patch('/admin/users/:id/role', guard, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = RoleBody.safeParse(req.body);
    if (!parsed.success || !isRole(parsed.data.role)) throw new ValidationError();
    const before = await prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!before) throw new NotFoundError('User not found');
    const user = await prisma.user.update({
      where: { id },
      data: { role: parsed.data.role },
      select: { id: true, role: true },
    });
    await revokeAllForUser(id); // force re-auth with new permissions
    await recordAudit({
      actorId: req.user!.sub,
      action: 'user.role.change',
      targetUserId: id,
      details: { from: before.role, to: parsed.data.role },
    });
    return user;
  });

  app.patch('/admin/users/:id/deactivate', guard, async (req) => {
    const { id } = req.params as { id: string };
    const user = await prisma.user.update({
      where: { id },
      data: { isActive: false },
      select: { id: true, isActive: true },
    });
    await revokeAllForUser(id);
    await recordAudit({ actorId: req.user!.sub, action: 'user.deactivate', targetUserId: id });
    return user;
  });

  app.patch('/admin/users/:id/reactivate', guard, async (req) => {
    const { id } = req.params as { id: string };
    const user = await prisma.user.update({
      where: { id },
      data: { isActive: true },
      select: { id: true, isActive: true },
    });
    await recordAudit({ actorId: req.user!.sub, action: 'user.reactivate', targetUserId: id });
    return user;
  });

  // Audit records are themselves a protected resource.
  app.get('/admin/audit', { preHandler: requirePermission(Permission.AUDIT_READ) }, async () =>
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
  );
}
