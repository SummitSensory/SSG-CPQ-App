import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { env } from '../config/env.js';
import { NotFoundError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import {
  DEFAULT_ORDER_LOCKED_BODY,
  DEFAULT_ORDER_LOCKED_SUBJECT,
  ORDER_LOCKED_FIELDS,
  findOrderForNotice,
  loadOrderLockedRecipients,
  loadOrderLockedTemplate,
  previewOrderLockedEmail,
  saveOrderLockedRecipients,
  saveOrderLockedTemplate,
  validateOrderLockedTemplate,
  sendOrderLockedNotice,
  sendOrderLockedTestEmail,
} from '../handoff/orderLockedNotice.js';

/**
 * Settings → Email → "Order locked email": who is told when a signed proposal
 * becomes an order, and what the email says. See handoff/orderLockedNotice.ts.
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

  // The wording: what is saved, the defaults (for "Reset to default"), and the
  // merge fields the editor lists.
  app.get('/admin/order-locked-email/template', manage, async () => ({
    ...(await loadOrderLockedTemplate()),
    defaults: { subject: DEFAULT_ORDER_LOCKED_SUBJECT, body: DEFAULT_ORDER_LOCKED_BODY },
    fields: ORDER_LOCKED_FIELDS,
  }));

  app.put('/admin/order-locked-email/template', manage, async (req) => {
    const saved = await saveOrderLockedTemplate(req.body, req.user!.sub);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'settings.orderLockedEmail.template',
      entity: 'UiSetting',
      entityId: 'notify.orderLocked',
      details: { ...saved },
    });
    return saved;
  });

  // Render a draft — saved or not — against the latest order, so the wording can be
  // checked before anyone receives it.
  app.post('/admin/order-locked-email/preview', manage, async (req) => {
    const { email, basedOn } = await previewOrderLockedEmail(validateOrderLockedTemplate(req.body));
    return { ...email, basedOn };
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
