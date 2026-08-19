import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { hit } from '../lib/rateLimit.js';
import { ValidationError } from '../lib/errors.js';
import {
  colorSelectionMode,
  createColorRequest,
  loadByToken,
  submitSelection,
  applySelection,
  listSelections,
  offeredLines,
} from '../portal/colorSelection.js';

/**
 * The customer portal's own endpoints on the CRM.
 *
 * Two audiences in one file, and they are gated differently. The `/portal/*`
 * routes are opened by a customer following a link and are authenticated by the
 * token in that link alone — so they are rate limited, they return only what that
 * one order's colour question needs, and they never accept an order id. The
 * `/orders/:id/colors/*` routes are staff-side and carry the ordinary permissions.
 *
 * Every route here refuses outright while PORTAL_COLOR_SELECTION is `off`, which
 * is how it ships. See src/portal/colorSelection.ts for what the three settings
 * mean and what has to be proven before moving off the default.
 */

const PORTAL_RULE = { limit: 30, windowMs: 15 * 60_000 };

const PicksSchema = z.object({
  email: z.string().email().optional(),
  picks: z
    .array(
      z.object({
        lineId: z.string().min(1),
        picks: z.array(
          z.object({ slot: z.number().int(), colorId: z.string().nullable().optional() }),
        ),
      }),
    )
    .max(200),
});

export function registerPortalRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.ORDERS_READ) };
  const manage = { preHandler: requirePermission(Permission.ORDERS_MANAGE) };

  /** Whether this deployment is collecting colours, and how. */
  app.get('/portal/status', async () => ({
    colorSelection: colorSelectionMode(),
  }));

  /** What the customer is being asked. Token in the path, nothing else. */
  app.get('/portal/colors/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const gate = hit(`portal-colors:${req.ip}`, PORTAL_RULE);
    if (!gate.allowed) {
      return reply
        .status(429)
        .header('retry-after', gate.retryAfter)
        .send({ error: 'TOO_MANY_REQUESTS' });
    }
    const row = await loadByToken(token);
    return {
      orderNumber: row.order.number,
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      lines: row.offered ?? [],
      picks: row.picks ?? null,
    };
  });

  /** Record the picks. Never applies them — see colorSelection.ts. */
  app.post('/portal/colors/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const gate = hit(`portal-colors:${req.ip}`, PORTAL_RULE);
    if (!gate.allowed) {
      return reply
        .status(429)
        .header('retry-after', gate.retryAfter)
        .send({ error: 'TOO_MANY_REQUESTS' });
    }
    const parsed = PicksSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('That colour selection could not be read.');
    const row = await submitSelection(token, parsed.data);
    return { status: row.status, submittedAt: row.submittedAt?.toISOString() ?? null };
  });

  // ----- Staff side -----

  /** Which lines on this order take a colour, whatever the feature flag says. */
  app.get('/orders/:id/colors/lines', read, async (req) => {
    const { id } = req.params as { id: string };
    return offeredLines(id);
  });

  app.get('/orders/:id/colors', read, async (req) => {
    const { id } = req.params as { id: string };
    return { mode: colorSelectionMode(), selections: await listSelections(id) };
  });

  /**
   * Mint the customer's link. Returns the token exactly once — it is stored
   * hashed, so a lost link is re-minted rather than looked up.
   */
  app.post('/orders/:id/colors/request', manage, async (req) => {
    const { id } = req.params as { id: string };
    return createColorRequest(id, req.user!.sub);
  });

  /** Put a submitted selection onto the procurement lines. Live mode only. */
  app.post('/orders/:id/colors/:selectionId/apply', manage, async (req) => {
    const { selectionId } = req.params as { selectionId: string };
    return applySelection(selectionId, req.user!.sub);
  });
}
