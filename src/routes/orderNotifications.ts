import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { env } from '../config/env.js';
import { NotFoundError } from '../lib/errors.js';
import {
  findOrderForNotice,
  loadOrderLockedRecipients,
  saveOrderLockedRecipients,
  sendOrderLockedNotice,
  sendOrderLockedTestEmail,
} from '../handoff/orderLockedNotice.js';

/**
 * Settings → Email → "Order locked email": who is told when a signed proposal
 * becomes an order. See handoff/orderLockedNotice.ts for the email itself.
 */
export function registerOrderNotificationRoutes(app: FastifyInstance): void {
  const manage = { preHandler: requirePermission(Permission.ORDERS_MANAGE) };

  app.get('/admin/order-locked-email', manage, async () => ({
    recipients: await loadOrderLockedRecipients(),
    // So the screen can say the list is saved but nothing can be sent yet.
    deliveryConfigured: Boolean(env.RESEND_API_KEY),
  }));

  app.put('/admin/order-locked-email', manage, async (req) => {
    const body = (req.body ?? {}) as { recipients?: unknown };
    return {
      recipients: await saveOrderLockedRecipients(body.recipients ?? '', req.user!.sub),
      deliveryConfigured: Boolean(env.RESEND_API_KEY),
    };
  });

  // A sample notice to the saved list, through the real sender and key. The failure
  // comes back as Resend worded it, so "why isn't this arriving?" is answered here.
  app.post('/admin/order-locked-email/test', manage, async () => {
    const { to, error } = await sendOrderLockedTestEmail();
    return { sent: !error, to, error };
  });

  // Send an order's notice again, e.g. one that failed before a delivery fault was
  // fixed. Recorded on the order's timeline like the automatic send.
  app.post('/admin/order-locked-email/resend', manage, async (req) => {
    const body = (req.body ?? {}) as { order?: unknown };
    const ref = typeof body.order === 'string' ? body.order : '';
    const order = await findOrderForNotice(ref);
    if (!order) throw new NotFoundError(`No order ${ref.trim() || '(blank)'}.`);
    const error = await sendOrderLockedNotice(order.id, req.user!.sub, { resend: true });
    return { sent: !error, number: order.number, error };
  });
}
