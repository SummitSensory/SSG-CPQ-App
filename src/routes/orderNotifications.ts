import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { env } from '../config/env.js';
import {
  loadOrderLockedRecipients,
  saveOrderLockedRecipients,
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
}
