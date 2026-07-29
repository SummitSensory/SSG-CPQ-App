import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

/**
 * Self-service password reset.
 *
 * The emailed link carries a 32-byte random token; only its SHA-256 hash is stored,
 * so the database alone cannot be used to take over an account. Tokens are
 * single-use and expire in 60 minutes, and requesting a new one deletes any
 * outstanding tokens for that user.
 */

const TOKEN_TTL_MINUTES = 60;

const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

export interface ResetEmail {
  email: string;
  name: string | null;
  link: string;
  expiresInMinutes: number;
}

export interface ResetSender {
  send(msg: ResetEmail): Promise<void>;
}

function resetHtml(m: ResetEmail): string {
  const greeting = m.name ? `Hi ${m.name},` : 'Hi,';
  return [
    '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;color:#20241f;line-height:1.55;">',
    `<p>${greeting}</p>`,
    '<p>Someone asked to reset the password for your Summit Sensory CPQ account. ',
    'If that was you, use the button below. If it was not, you can ignore this email — ',
    'your password has not changed.</p>',
    `<p style="margin:26px 0;"><a href="${m.link}" style="background:#3d4a55;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:600;">Choose a new password</a></p>`,
    `<p style="color:#6b7066;font-size:13px;">This link expires in ${m.expiresInMinutes} minutes and can only be used once.</p>`,
    `<p style="color:#6b7066;font-size:13px;">If the button does not work, paste this into your browser:<br><span style="word-break:break-all;">${m.link}</span></p>`,
    '</div>',
  ].join('');
}

/** Development fallback: log the link instead of sending it. */
class LogResetSender implements ResetSender {
  async send(m: ResetEmail): Promise<void> {
    logger.warn({ email: m.email, link: m.link }, 'password reset: RESEND_API_KEY unset, link logged not sent');
  }
}

/** Delivers through Resend's HTTP API — no SDK dependency needed. */
class ResendResetSender implements ResetSender {
  constructor(private readonly apiKey: string) {}

  async send(m: ResetEmail): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: `${env.RESET_FROM_NAME} <${env.RESET_FROM_EMAIL}>`,
        to: [m.email],
        subject: 'Reset your Summit Sensory CPQ password',
        html: resetHtml(m),
      }),
    });
    if (!res.ok) {
      throw new Error(`Resend rejected the reset email (${res.status}): ${await res.text()}`);
    }
    logger.info({ email: m.email }, 'password reset: sent');
  }
}

export let resetSender: ResetSender = env.RESEND_API_KEY
  ? new ResendResetSender(env.RESEND_API_KEY)
  : new LogResetSender();
export function setResetSender(s: ResetSender): void {
  resetSender = s;
}

/**
 * Issue a reset token and email the link.
 *
 * Always resolves, whether or not the address belongs to an account — the caller
 * returns the same response either way so the endpoint cannot be used to discover
 * which emails are registered. A deactivated account gets no email either.
 */
export async function requestPasswordReset(rawEmail: string, baseUrl: string, requestIp?: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, isActive: true },
  });
  if (!user || !user.isActive) {
    logger.info({ email }, 'password reset: no active account, nothing sent');
    return;
  }

  // At most one live token per account.
  await prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });

  const raw = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000);
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashToken(raw), expiresAt, requestIp: requestIp ?? null },
  });

  const link = `${baseUrl.replace(/\/+$/, '')}/?reset=${raw}`;
  await resetSender.send({
    email: user.email, name: user.name, link, expiresInMinutes: TOKEN_TTL_MINUTES,
  });
}

export type ResetTokenState = 'VALID' | 'UNKNOWN' | 'EXPIRED' | 'USED';

/** Look up a raw token without consuming it — lets the UI show a useful message. */
export async function checkResetToken(raw: string): Promise<ResetTokenState> {
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    select: { usedAt: true, expiresAt: true },
  });
  if (!row) return 'UNKNOWN';
  if (row.usedAt) return 'USED';
  if (row.expiresAt.getTime() <= Date.now()) return 'EXPIRED';
  return 'VALID';
}

/** Consume a token, returning the user it belongs to. Null when unusable. */
export async function consumeResetToken(raw: string): Promise<{ id: string; email: string } | null> {
  const tokenHash = hashToken(raw);
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, usedAt: true, expiresAt: true, user: { select: { id: true, email: true, isActive: true } } },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now() || !row.user.isActive) return null;
  // Mark used before changing the password so a double-submit cannot reuse it.
  const claimed = await prisma.passwordResetToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return null;
  return { id: row.user.id, email: row.user.email };
}

/** Best-effort cleanup of tokens that can never be used again. */
export async function purgeExpiredResetTokens(): Promise<number> {
  const { count } = await prisma.passwordResetToken.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 24 * 3_600_000) } },
  });
  return count;
}
