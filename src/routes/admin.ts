import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../auth/password.js';
import { revokeAllForUser } from '../auth/session.js';
import { recordAudit } from '../lib/audit.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission, ROLES, isRole } from '../authz/permissions.js';
import { ValidationError, NotFoundError, ConflictError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { resetSender } from '../auth/passwordReset.js';

const CreateUserBody = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  password: z.string().min(12),
  role: z.enum(ROLES),
});
const RoleBody = z.object({ role: z.enum(ROLES) });

/*
 * A handwritten signature, as a data URI.
 *
 * Same rule and same cap as the self-service version in routes/auth.ts, deliberately
 * repeated rather than shared: these are two different acts — signing for yourself,
 * and an administrator setting up somebody's account — and a change to one should not
 * silently change the other.
 *
 * 400 KB encoded is roughly ten times what a signature needs at the size it prints
 * at, and well below the point where the row becomes awkward to read back. The cap is
 * on the encoded string because that is what gets stored.
 */
const SIGNATURE_MAX_CHARS = 400_000;
const SignatureImage = z
  .string()
  .trim()
  .max(SIGNATURE_MAX_CHARS, 'That image is too large — use one under about 300 KB.')
  .refine(
    (v) => /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v),
    'The signature must be a PNG or JPEG image.',
  );
/**
 * Profile edit. Every field is optional so a caller can change one thing, but an
 * empty name/title/phone means "clear it" — hence the nullish handling below,
 * which distinguishes absent from blank.
 */
const ProfileBody = z.object({
  email: z.string().email().optional(),
  name: z.string().trim().max(120).nullish(),
  title: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(40).nullish(),
  addressLine1: z.string().trim().max(200).nullish(),
  addressLine2: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(120).nullish(),
  region: z.string().trim().max(120).nullish(),
  postalCode: z.string().trim().max(20).nullish(),
  country: z.string().trim().max(120).nullish(),
  /** A data URI to set it, an empty string or null to remove it. */
  signatureImage: z.union([SignatureImage, z.literal(''), z.null()]).optional(),
});

/**
 * The profile fields, in one place.
 *
 * `signatureImage` is deliberately NOT here: it is tens of kilobytes and would ride
 * along on every user list. The list reports whether one exists; the image itself is
 * fetched only when a form opens.
 */
const PROFILE_FIELDS = [
  'name',
  'title',
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postalCode',
  'country',
] as const;

const PROFILE_SELECT = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  name: true,
  title: true,
  phone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  country: true,
} as const;
const ResetPasswordBody = z.object({ password: z.string().min(12) });

export function registerAdminRoutes(app: FastifyInstance): void {
  const guard = { preHandler: requirePermission(Permission.USERS_MANAGE) };

  app.get('/admin/users', guard, async () => {
    const users = await prisma.user.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: { ...PROFILE_SELECT, signatureImage: true },
    });
    // Whether a signature exists, not the signature: a list of four users would
    // otherwise carry a megabyte of base64 nobody on that screen looks at.
    return users.map(({ signatureImage, ...rest }) => ({
      ...rest,
      hasSignature: !!signatureImage,
    }));
  });

  /**
   * One user's signature image.
   *
   * Its own endpoint for the reason above — the list stays small and the bytes are
   * fetched only when a form opens and needs to show what is already on file.
   */
  app.get('/admin/users/:id/signature', guard, async (req) => {
    const { id } = req.params as { id: string };
    const user = await prisma.user.findUnique({ where: { id }, select: { signatureImage: true } });
    if (!user) throw new NotFoundError('User not found');
    return { signatureImage: user.signatureImage ?? null };
  });

  /**
   * Edit another user's profile, including their email address.
   *
   * Email is the login identifier, so a change here changes how that person signs
   * in. Their existing sessions stay valid — access tokens carry the user id, not
   * the address — but they are told, and the change is audited with both values so
   * the trail explains a login that suddenly stops working.
   *
   * Editing yourself is allowed and is the supported way to move the account off a
   * shared address like admin@ onto a personal one.
   */
  app.patch('/admin/users/:id', guard, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ProfileBody.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid profile');
    const { email, signatureImage, ...profile } = parsed.data;

    const before = await prisma.user.findUnique({
      where: { id },
      select: { ...PROFILE_SELECT, signatureImage: true },
    });
    if (!before) throw new NotFoundError('User not found');

    // Same unique-email trap as user creation: check first so the caller gets a
    // sentence instead of a Prisma P2002 surfacing as a bare 500.
    if (email && email !== before.email) {
      const clash = await prisma.user.findUnique({
        where: { email },
        select: { id: true, isActive: true },
      });
      if (clash && clash.id !== id) {
        throw new ConflictError(
          clash.isActive
            ? 'Another user already signs in with that email.'
            : 'A deactivated user already has that email — reactivate or change that account first.',
        );
      }
    }

    // undefined means the field was not sent; null or '' means clear it.
    const blank = (v: string | null | undefined) =>
      v === undefined ? undefined : v === null || v === '' ? null : v;
    const data: Record<string, string | null | undefined> = { email: email ?? undefined };
    for (const f of PROFILE_FIELDS) data[f] = blank(profile[f]);
    // Absent leaves the existing signature alone; '' or null removes it. Those are
    // three different intentions and a form that sends the field on every save would
    // otherwise wipe a signature it never showed.
    if (signatureImage !== undefined) data.signatureImage = signatureImage || null;

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { ...PROFILE_SELECT, signatureImage: true },
    });
    const { signatureImage: savedSignature, ...user } = updated;

    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ['email', ...PROFILE_FIELDS] as const) {
      if (user[k] !== before[k]) changed[k] = { from: before[k], to: user[k] };
    }
    // The image itself never goes in the audit trail — it is tens of kilobytes and
    // the fact of the change is the part anyone reviewing this needs.
    if (!!savedSignature !== !!before.signatureImage) {
      changed.signatureImage = { from: !!before.signatureImage, to: !!savedSignature };
    }
    if (Object.keys(changed).length) {
      await recordAudit({
        actorId: req.user!.sub,
        action: email && email !== before.email ? 'user.email.change' : 'user.profile.update',
        targetUserId: id,
        details: changed,
      });
    }
    return { ...user, hasSignature: !!savedSignature };
  });

  app.post('/admin/users', guard, async (req, reply) => {
    const parsed = CreateUserBody.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid user');
    const { email, name, password, role } = parsed.data;
    // Email is unique, so creating a duplicate threw an unhandled Prisma P2002 and
    // surfaced as a bare 500. Check first and say what actually happened.
    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, isActive: true },
    });
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
      actorId: req.user!.sub,
      action: 'user.password.reset',
      targetUserId: user.id,
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

  /**
   * Send a test email to the signed-in admin.
   *
   * /auth/forgot-password deliberately returns 204 even when Resend rejects the send,
   * so misconfiguration is invisible there by design. This endpoint reports the real
   * failure instead, which is what you want when checking a from-address or a
   * domain's verification status.
   */
  app.post('/admin/email/test', guard, async (req) => {
    const me = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { email: true, name: true },
    });
    if (!me) throw new NotFoundError('User not found');
    if (!env.RESEND_API_KEY) {
      return {
        sent: false,
        from: env.RESET_FROM_EMAIL,
        to: me.email,
        message: 'RESEND_API_KEY is not set — emails are written to the log instead of sent.',
      };
    }
    try {
      await resetSender.send({
        email: me.email,
        name: me.name,
        link: `${env.APP_BASE_URL ?? 'https://example.invalid'}/?reset=test-link-not-valid`,
        expiresInMinutes: 60,
      });
      return { sent: true, from: env.RESET_FROM_EMAIL, replyTo: env.RESET_REPLY_TO, to: me.email };
    } catch (err) {
      throw new ValidationError(
        `Resend rejected the send from ${env.RESET_FROM_EMAIL}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // Audit records are themselves a protected resource.
  app.get('/admin/audit', { preHandler: requirePermission(Permission.AUDIT_READ) }, async () =>
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
  );
}
