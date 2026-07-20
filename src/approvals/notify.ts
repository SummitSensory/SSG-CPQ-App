import { logger } from '../lib/logger.js';

/**
 * Notification sink. Kept as a thin, swappable interface so the approval
 * service never hard-codes a transport. The default logs; wire email/monday/
 * in-app later by replacing `notifier`.
 */
export interface ApprovalNotification {
  event: 'requested' | 'approved' | 'rejected' | 'revision_requested' | 'escalated' | 'expired';
  requestId: string;
  type: string;
  recipientIds: string[];
  message: string;
}

export interface Notifier {
  send(n: ApprovalNotification): Promise<void>;
}

class LogNotifier implements Notifier {
  async send(n: ApprovalNotification): Promise<void> {
    logger.info({ event: n.event, requestId: n.requestId, recipients: n.recipientIds }, `notify: ${n.message}`);
  }
}

export let notifier: Notifier = new LogNotifier();
export function setNotifier(n: Notifier): void {
  notifier = n;
}
