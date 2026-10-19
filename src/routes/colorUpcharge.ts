import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import {
  colorUpchargePreview,
  colorUpchargeState,
  markColorUpchargeHandled,
  pushColorUpcharge,
  unbilledColorUpcharges,
} from '../integrations/quickbooks/colorUpcharge.js';

/**
 * The Prismatic paint upcharge a customer agreed to in the portal → their invoice
 * (integrations/quickbooks/colorUpcharge.ts).
 *
 * Reading where it stands is open to anyone who can read orders, so the order page
 * can show "to bill" to whoever is looking. Billing it — or recording that it was
 * handled by hand — needs INVOICE_UPCHARGE_PUSH, because both change what the
 * customer is recorded as owing.
 */

const Minor = z.string().regex(/^-?\d+$/);

const PushSchema = z.object({
  /** All three come straight back from the preview — see pushColorUpcharge. */
  expectedCurrentTotalMinor: Minor,
  expectedNewTotalMinor: Minor,
  expectedChargeMinor: Minor,
});

const HandledSchema = z.object({
  note: z.string().trim().min(3).max(1000),
  expectedChargeMinor: Minor,
});

export function registerColorUpchargeRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.ORDERS_READ) };
  const push = { preHandler: requirePermission(Permission.INVOICE_UPCHARGE_PUSH) };

  /** Owed (per the portal), billed, and what is left — for the order page. */
  app.get('/orders/:id/color-upcharge', read, async (req) => {
    const { id } = req.params as { id: string };
    return colorUpchargeState(id);
  });

  /** Every order with an upcharge still to bill — what the daily reminder lists. */
  app.get('/color-upcharges/unbilled', push, async () => unbilledColorUpcharges());

  /** Before / after, read live from QuickBooks. */
  app.get('/orders/:id/color-upcharge/preview', push, async (req) => {
    const { id } = req.params as { id: string };
    return colorUpchargePreview(id);
  });

  /** Add it to the invoice, or raise the upcharge-only one. Confirmed figures required. */
  app.post('/orders/:id/color-upcharge/push', push, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = PushSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    return pushColorUpcharge(id, req.user!.sub, parsed.data);
  });

  /** It was billed, credited or waived outside the CRM — record it, with a note. */
  app.post('/orders/:id/color-upcharge/handled', push, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = HandledSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    return markColorUpchargeHandled(id, req.user!.sub, parsed.data);
  });
}
