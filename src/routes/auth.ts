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
import { env, isPasswordSignInBlocked } from '../config/env.js';
import { recordAudit } from '../lib/audit.js';
import { requestPasswordReset, checkResetToken, consumeResetToken } from '../auth/passwordReset.js';
import { hit, reset as resetLimit, AUTH_RULES } from '../lib/rateLimit.js';

/**
 * Throttle the unauthenticated auth endpoints.
 *
 * Two buckets per attempt — the caller's IP and the address they typed — because
 * either one alone is the wrong unit: IP-only lets one office NAT lock out a whole
 * company, address-only lets an attacker rotate addresses freely. Tripping either
 * refuses the attempt. See lib/rateLimit.ts for the in-process scope caveat.
 */
function throttle(
  req: { ip: string },
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  route: keyof typeof AUTH_RULES,
  discriminator: string,
): boolean {
  const rule = AUTH_RULES[route];
  const keys = [`${route}:ip:${req.ip}`, `${route}:id:${discriminator.trim().toLowerCase()}`];
  for (const key of keys) {
    const result = hit(key, rule);
    if (!result.allowed) {
      reply.status(429).send({
        message: 'Too many attempts. Wait a few minutes and try again.',
        retryAfter: result.retryAfter,
      });
      return false;
    }
  }
  return true;
}

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

/**
 * A handwritten signature, as a data URI.
 *
 * Only PNG and JPEG, and only a data URI — a remote URL would print as a broken
 * image, because the PDF renderer has no network and the letter is a document a
 * customer receives.
 *
 * 400 KB is roughly ten times what a signature needs at the 90px it prints at, and
 * it is a long way below the point where a row becomes awkward to read back. The cap
 * is on the encoded string because that is what gets stored.
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

const ProfileBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(40).nullish(),
  /** A data URI to set it, an empty string or null to remove it. */
  signatureImage: z.union([SignatureImage, z.literal(''), z.null()]).optional(),
});

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError();
    const { email, password } = parsed.data;

    // Before argon2 runs: an unthrottled password endpoint is both a credential-
    // stuffing target and the cheapest way to exhaust the function's CPU.
    if (!throttle(req, reply, 'login', email)) return reply;

    /**
     * Domains listed in SSO_ENFORCED_DOMAINS must come through Microsoft.
     *
     * Checked before the password is looked at, and answered with a plain
     * instruction rather than "Invalid credentials" — the point is to send somebody
     * to the right button, and a person who is typing the right password into a form
     * that will never accept it deserves to be told why.
     *
     * This does not reveal whether an account exists: the answer depends only on the
     * domain typed into the box, which the person typing it already knows.
     */
    if (isPasswordSignInBlocked(email)) {
      throw new UnauthorizedError(
        'Accounts on this domain sign in with Microsoft. Use “Sign in with Microsoft” below.',
      );
    }

    // Email addresses are not case-sensitive, and SSO stores them lowercased.
    // Match the same way here so a row saved as "Bryan@..." still accepts
    // "bryan@..." at the password form.
    const user = await prisma.user.findFirst({
      where: { email: { equals: email.trim(), mode: 'insensitive' } },
    });
    // Constant-ish path: always verify to reduce user enumeration.
    const ok = user && user.isActive ? await verifyPassword(user.passwordHash, password) : false;
    if (!user || !ok || !user.isActive) throw new UnauthorizedError('Invalid credentials');

    const accessToken = await signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = await createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    // A correct sign-in clears the counters, so a few typos never cost a real user
    // their next attempt.
    resetLimit(`login:ip:${req.ip}`);
    resetLimit(`login:id:${email.trim().toLowerCase()}`);
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
      // Throttled on the address as well as the IP: without this the endpoint is a
      // free mail cannon aimed at any customer or colleague's inbox.
      if (!throttle(req, reply, 'forgot', parsed.data.email)) return reply;
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
    // Guessing a reset token is meant to be hopeless; unthrottled it is merely
    // expensive. The token itself is the discriminator, so one bucket per token.
    if (!throttle(req, reply, 'reset', parsed.data.token.slice(0, 16))) return reply;
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
      actorId: user.id,
      action: 'user.password.reset',
      targetUserId: user.id,
      details: { email: user.email, by: 'self-service' },
    });
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: {
        id: true,
        email: true,
        name: true,
        title: true,
        phone: true,
        role: true,
        isActive: true,
        signatureImage: true,
      },
    });
    if (!user) throw new UnauthorizedError();
    // The image itself is several hundred KB and this response is fetched on every
    // page load. The profile form only needs to know whether one is held and to be
    // able to show it, so the bytes are served from their own endpoint below.
    const { signatureImage, ...rest } = user;
    return { ...rest, hasSignature: !!signatureImage };
  });

  /**
   * The signed-in user's own signature image, for the preview in the profile form.
   *
   * Its own endpoint so /auth/me stays small: that response is fetched on every page
   * load and this is the one field on the row big enough to notice.
   */
  app.get('/auth/me/signature', { preHandler: requireAuth }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { signatureImage: true },
    });
    return { signatureImage: user?.signatureImage ?? null };
  });

  /** Preparer details that appear on generated proposals. */
  app.patch('/auth/me', { preHandler: requireAuth }, async (req) => {
    const parsed = ProfileBody.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid profile');
    const { name, title, phone, signatureImage } = parsed.data;
    const updated = await prisma.user.update({
      where: { id: req.user!.sub },
      data: {
        ...(name === undefined ? {} : { name }),
        ...(title === undefined ? {} : { title: title || null }),
        ...(phone === undefined ? {} : { phone: phone || null }),
        // Undefined leaves it alone; an empty string or null removes it. The form
        // sends the field only when it changed, so saving a name never disturbs a
        // signature that took somebody three attempts to scan.
        ...(signatureImage === undefined ? {} : { signatureImage: signatureImage || null }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        title: true,
        phone: true,
        role: true,
        isActive: true,
        signatureImage: true,
      },
    });
    const { signatureImage: saved, ...rest } = updated;
    return { ...rest, hasSignature: !!saved };
  });
}
