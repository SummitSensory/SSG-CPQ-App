import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

/**
 * Welcome/invite delivery for auto-provisioned SSO users.
 *
 * Deliberately a thin interface, mirroring the approvals notifier: the app has
 * no email transport yet, so the default writes to the log. Swap in a real
 * sender (Resend, SendGrid, Microsoft Graph) with `setInviteSender` and every
 * call site starts delivering mail without further changes.
 */
export interface Invite {
  email: string;
  name?: string;
  role: string;
  appUrl: string;
}

export interface InviteSender {
  send(invite: Invite): Promise<void>;
}

class LogInviteSender implements InviteSender {
  async send(invite: Invite): Promise<void> {
    logger.info(
      { email: invite.email, role: invite.role },
      `invite: account created for ${invite.email} with role ${invite.role} (no email transport configured — not delivered)`,
    );
  }
}

function inviteHtml(invite: Invite): string {
  const who = invite.name ? invite.name.split(' ')[0] : 'there';
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#20241f;line-height:1.6;max-width:520px;">
<p>Hi ${who},</p>
<p>An account has been created for you in the Summit Sensory CPQ workspace.</p>
<p>Sign in with your Microsoft work account — no separate password needed:</p>
<p><a href="${invite.appUrl}" style="display:inline-block;background:#3d4a55;color:#fff;text-decoration:none;padding:11px 20px;border-radius:9px;font-weight:600;">Open the CPQ workspace</a></p>
<p style="color:#82877d;font-size:14px;">You start with <b>${invite.role.toLowerCase().replace(/_/g, ' ')}</b> access. If you need more, ask an administrator to change your role.</p>
</div>`;
}

/** Delivers through Resend's HTTP API — no SDK dependency needed. */
class ResendInviteSender implements InviteSender {
  constructor(private readonly apiKey: string) {}

  async send(invite: Invite): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: `${env.INVITE_FROM_NAME} <${env.INVITE_FROM_EMAIL}>`,
        to: [invite.email],
        reply_to: env.INVITE_REPLY_TO,
        subject: 'Your Summit Sensory CPQ account',
        html: inviteHtml(invite),
      }),
    });
    if (!res.ok) {
      throw new Error(`Resend rejected the invite (${res.status}): ${await res.text()}`);
    }
    logger.info({ email: invite.email }, 'invite: sent');
  }
}

export let inviteSender: InviteSender = env.RESEND_API_KEY
  ? new ResendInviteSender(env.RESEND_API_KEY)
  : new LogInviteSender();
export function setInviteSender(s: InviteSender): void {
  inviteSender = s;
}
