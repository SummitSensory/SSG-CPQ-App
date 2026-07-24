import { logger } from '../lib/logger.js';

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

export let inviteSender: InviteSender = new LogInviteSender();
export function setInviteSender(s: InviteSender): void {
  inviteSender = s;
}
