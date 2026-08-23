import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';

/**
 * Belt shipments — the short list of belts owed to customers, and the slips that
 * have been printed to clear it.
 *
 * Deliberately small. This covers about ten belt SKUs shipped by hand out of our own
 * facility; it is not order fulfilment and it is not tied to the BOM. The whole state
 * is one JSON document in UiSetting, for three reasons:
 *
 *   1. It is a worklist of a few dozen rows, not a reporting table. Nothing queries
 *      across it, so tables and indexes would buy nothing.
 *   2. It needs no migration, so this ships as a code deploy.
 *   3. Everyone sees the same list. A browser-local list would mean one person's
 *      shipment is invisible to the next, which is the exact failure being fixed.
 *
 * If this ever grows past a worklist — per-item history, reporting, thousands of rows
 * — it wants real tables. Until then the simplest thing that is correct wins.
 */

const KEY = 'belt.shipments';

/** One belt owed to one customer. */
const Owed = z.object({
  id: z.string().trim().min(1).max(40),
  customer: z.string().trim().min(1).max(160),
  sku: z.string().trim().max(60),
  item: z.string().trim().min(1).max(200),
  qty: z.number().int().min(1).max(999),
  note: z.string().trim().max(400).default(''),
  /** ISO date the row was added, which is what "owed for 9 days" is counted from. */
  added: z.string().trim().max(30),
});

/** A slip that has been printed and put in a box. */
const Slip = z.object({
  id: z.string().trim().min(1).max(40),
  number: z.string().trim().max(40),
  customer: z.string().trim().min(1).max(160),
  date: z.string().trim().max(30),
  address: z.string().trim().max(400).default(''),
  note: z.string().trim().max(400).default(''),
  lines: z
    .array(
      z.object({
        sku: z.string().trim().max(60),
        item: z.string().trim().min(1).max(200),
        qty: z.number().int().min(1).max(999),
      }),
    )
    .max(60),
});

const State = z.object({
  /** The belt SKUs offered in the picker. Maintained here, not hard-coded. */
  catalog: z
    .array(
      z.object({
        sku: z.string().trim().max(60),
        item: z.string().trim().min(1).max(200),
      }),
    )
    .max(60)
    .default([]),
  owed: z.array(Owed).max(400).default([]),
  slips: z.array(Slip).max(600).default([]),
  /** Increments per printed slip, so slip numbers never repeat. */
  seq: z.number().int().min(0).max(1_000_000).default(0),
});

const EMPTY = { catalog: [], owed: [], slips: [], seq: 0 };

export function registerBeltShipmentRoutes(app: FastifyInstance): void {
  // Anyone who can work a proposal can work this list — it is a shipping worklist,
  // not privileged data, and the person who packs the box is not always the rep.
  const guard = { preHandler: requirePermission(Permission.PROPOSAL_READ) };

  app.get('/belt-shipments', guard, async () => {
    const row = await prisma.uiSetting.findUnique({ where: { key: KEY } });
    if (!row) return EMPTY;
    try {
      return State.parse(JSON.parse(row.value));
    } catch {
      // A malformed document must not take the screen down with it.
      return EMPTY;
    }
  });

  /**
   * Replace the whole document.
   *
   * Last write wins. With one or two people working a list of this size that is the
   * right trade: no locking, no merge, and a lost edit is one row retyped.
   */
  app.put('/belt-shipments', guard, async (req) => {
    const parsed = State.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('That shipment list could not be read.');
    const value = JSON.stringify(parsed.data);
    await prisma.uiSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value, updatedById: req.user!.sub },
      update: { value, updatedById: req.user!.sub, updatedAt: new Date() },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'belt.shipments.save',
      entity: 'UiSetting',
      entityId: KEY,
      details: { owed: parsed.data.owed.length, slips: parsed.data.slips.length },
    });
    return { saved: true };
  });
}
