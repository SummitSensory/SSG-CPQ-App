import { primaryShippingAddress } from '../crm/addresses.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError, ConflictError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { formatUsPhone } from '../lib/phone.js';
import { readDealContacts } from '../integrations/monday/dealContacts.js';
import {
  carrierOptions,
  syncBeltSlipToMonday,
  type BeltPushResult,
} from '../integrations/monday/beltShipmentPush.js';

/**
 * Belt shipments — which customers are owed a belt, which belt, and the slip that
 * goes in the box.
 *
 * The list is DERIVED, not kept. Belts are already on the customer's bill of
 * materials as procurement lines, so this route reads them straight off the BOM and
 * subtracts what has already been shipped. Nobody re-types an order, and a belt
 * cannot be missed because someone forgot to add it to a second list.
 *
 * The only thing stored is the shipping ledger: how many of each BOM line have gone
 * out, which were cleared from the queue without a slip, and the slips that were
 * printed. That lives in one UiSetting JSON document,
 * because it is a few hundred rows that nothing queries across — and it needs no
 * migration, so this ships as a code deploy.
 *
 * A slip can also cover an item with no ProcurementLine behind it at all — a
 * replacement, warranty, or goodwill shipment that was never on a bill of materials.
 * Its line simply carries an empty lineId, which /ship and /void already skip when
 * crediting/returning BOM quantities, so nothing further was needed to support it; see
 * belt-shipments.js for where that path is built.
 *
 * If belts ever need per-piece history, serial numbers or reporting, the ledger wants
 * a real table. Until then the simplest correct thing wins.
 */

const KEY = 'belt.shipments';

/**
 * Belts are recognised by SKU prefix.
 *
 * A prefix rather than a fixed list of the seven sizes, so a new size appears here
 * the day it is added to the catalog with no code change. Case-insensitive, since
 * SKUs are entered by hand in places.
 */
const BELT_SKU_PREFIX = 'FLEX-BELT-';

/** Orders that are no longer shipping anything. */
const DEAD_STATUSES = ['CANCELLED'] as const;

/** A slip that has been printed and put in a box. */
const Slip = z.object({
  id: z.string().trim().min(1).max(40),
  number: z.string().trim().max(40),
  orgId: z.string().trim().max(40).default(''),
  customer: z.string().trim().min(1).max(160),
  /** The proposal these belts were sold on. Printed on the slip. */
  proposalNumber: z.string().trim().max(40).default(''),
  /**
   * Who printed it and when, and who withdrew it.
   *
   * Set by the server from the session, never sent by the browser — an accountability
   * record that the person being recorded can edit is not a record. shippedAt is a
   * full timestamp rather than a date, because "who shipped what today" needs the
   * order things happened in.
   */
  shippedById: z.string().trim().max(40).default(''),
  shippedBy: z.string().trim().max(160).default(''),
  shippedAt: z.string().trim().max(40).default(''),
  voidedById: z.string().trim().max(40).default(''),
  voidedBy: z.string().trim().max(160).default(''),
  voidedAt: z.string().trim().max(40).default(''),
  attention: z.string().trim().max(160).default(''),
  date: z.string().trim().max(30),
  address: z.string().trim().max(400).default(''),
  /**
   * The customer's email and phone, printed below the address. Pre-filled from the
   * order's monday deal (email_1__1 / phone__1), editable before printing, and kept
   * on the slip so a reprint shows what went in the box.
   */
  email: z.string().trim().max(160).default(''),
  phone: z.string().trim().max(60).default(''),
  note: z.string().trim().max(400).default(''),
  /**
   * Freight Carrier and Freight Tracking ID. Usually known only after the box is
   * handed over, so editable on the shipping record after printing; every change is
   * written through to the slip's "UEU Belt(s)" subitem on the Manufacturing board
   * (see integrations/monday/beltShipmentPush.ts).
   */
  carrier: z.string().trim().max(80).default(''),
  trackingId: z.string().trim().max(120).default(''),
  /** The slip's subitem on monday, once created, and what the last sync said. */
  mondaySubitemId: z.string().trim().max(40).default(''),
  mondaySubitemBoardId: z.string().trim().max(40).default(''),
  mondayNote: z.string().trim().max(300).default(''),
  lines: z
    .array(
      z.object({
        /** ProcurementLine id, so a reprint still ties back to the BOM. */
        lineId: z.string().trim().max(40).default(''),
        sku: z.string().trim().max(60),
        item: z.string().trim().min(1).max(200),
        qty: z.number().int().min(1).max(999),
      }),
    )
    .max(60),
});

/**
 * Pieces taken off the queue without a slip — a belt that went out some other way, or
 * one the customer no longer needs. Written off, not deleted: the BOM line is untouched,
 * the entry records who cleared it and why, and Restore puts it back on the list.
 */
const Cleared = z.object({
  qty: z.number().int().min(1).max(9999),
  customer: z.string().trim().max(160).default(''),
  item: z.string().trim().max(200).default(''),
  sku: z.string().trim().max(60).default(''),
  orderNumber: z.string().trim().max(40).default(''),
  proposalNumber: z.string().trim().max(40).default(''),
  reason: z.string().trim().max(300).default(''),
  clearedById: z.string().trim().max(40).default(''),
  clearedBy: z.string().trim().max(160).default(''),
  clearedAt: z.string().trim().max(40).default(''),
});

const Ledger = z.object({
  /** ProcurementLine id -> total pieces shipped against it. */
  shipped: z.record(z.string().max(40), z.number().int().min(0).max(9999)).default({}),
  /** ProcurementLine id -> pieces cleared from the queue without shipping. */
  cleared: z.record(z.string().max(40), Cleared).default({}),
  slips: z.array(Slip).max(2000).default([]),
  seq: z.number().int().min(0).max(1_000_000).default(0),
});

type LedgerT = z.infer<typeof Ledger>;

const EMPTY_LEDGER: LedgerT = { shipped: {}, cleared: {}, slips: [], seq: 0 };

/**
 * The whole ledger lives in one JSON blob (`UiSetting`), read in full and written
 * back in full — there is no per-slip row to lock. `updatedAt` (row) is the version
 * this read was made at; `ship`/`void` must pass it back to `writeLedger` so a second
 * write from a stale read is refused instead of silently overwriting the first —
 * see writeLedger's own comment.
 */
async function readLedgerRow(): Promise<{ ledger: LedgerT; updatedAt: Date | null }> {
  const row = await prisma.uiSetting.findUnique({ where: { key: KEY } });
  if (!row) return { ledger: structuredClone(EMPTY_LEDGER), updatedAt: null };
  try {
    return { ledger: Ledger.parse(JSON.parse(row.value)), updatedAt: row.updatedAt };
  } catch {
    // A malformed document must not take the screen down with it.
    return { ledger: structuredClone(EMPTY_LEDGER), updatedAt: row.updatedAt };
  }
}

async function readLedger(): Promise<LedgerT> {
  return (await readLedgerRow()).ledger;
}

/**
 * Write the ledger back, claimed on the `updatedAt` the caller read it at.
 *
 * Two staff printing shipment slips (or one shipping while another voids) within the
 * same window both used to read the same base ledger, compute their own change in
 * memory, and blind-`upsert` the whole document back — whichever request's write
 * landed second silently erased the first slip from history and reverted its
 * quantity credit, a real double-ship risk despite the comment above `ship` claiming
 * "two people shipping at once cannot silently undo each other" (true only within a
 * single request). Refused rather than merged: there is no per-slip row to merge,
 * only a JSON blob computed from a point-in-time read.
 */
async function writeLedger(
  ledger: LedgerT,
  expectedUpdatedAt: Date | null,
  actorId: string,
): Promise<void> {
  const value = JSON.stringify(Ledger.parse(ledger));
  if (expectedUpdatedAt === null) {
    try {
      await prisma.uiSetting.create({ data: { key: KEY, value, updatedById: actorId } });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw new ConflictError('Someone else just recorded a shipment. Reload and try again.');
      }
      throw err;
    }
    return;
  }
  const claim = await prisma.uiSetting.updateMany({
    where: { key: KEY, updatedAt: expectedUpdatedAt },
    data: { value, updatedById: actorId },
  });
  if (claim.count !== 1) {
    throw new ConflictError('Someone else just recorded a shipment. Reload and try again.');
  }
}

/**
 * Record a monday sync's outcome on its slip. Runs after the slip's own write, so
 * another shipment may have landed in between — re-read and retry a few times
 * rather than fail: losing the subitem id would make the next save create a second
 * subitem.
 */
async function saveMondayResult(
  slipId: string,
  result: BeltPushResult,
  actorId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { ledger, updatedAt } = await readLedgerRow();
    const slip = ledger.slips.find((s) => s.id === slipId);
    if (!slip) return;
    slip.mondaySubitemId = result.subitemId;
    slip.mondaySubitemBoardId = result.subitemBoardId;
    slip.mondayNote = result.note.slice(0, 300);
    try {
      await writeLedger(ledger, updatedAt, actorId);
      return;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
    }
  }
}

/**
 * The proposal meta frozen on an order. `sections` is an ARRAY of section objects, and
 * the meta is the one with id 'meta', under .data — the same shape app.js reads when it
 * builds the document. Read defensively: the snapshot is free-form JSON frozen at
 * acceptance, so an older order may not carry a meta section at all.
 */
function snapshotMeta(snapshot: unknown): Record<string, unknown> {
  const snap = snapshot as { sections?: unknown } | null;
  const sections = Array.isArray(snap?.sections)
    ? (snap.sections as Array<Record<string, unknown>>)
    : [];
  const metaSection = sections.find((sec) => sec && sec.id === 'meta');
  return (metaSection?.data ?? {}) as Record<string, unknown>;
}

/** One line of one address, formatted the way it prints on the slip. */
function formatAddress(
  a:
    | {
        line1: string;
        line2: string | null;
        city: string;
        region: string;
        postalCode: string;
      }
    | undefined,
): string {
  if (!a) return '';
  const street = [a.line1, a.line2].filter(Boolean).join('\n');
  const city = [a.city, a.region].filter(Boolean).join(', ');
  return [street, [city, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join('\n');
}

export function registerBeltShipmentRoutes(app: FastifyInstance): void {
  // Anyone who can work an order can work this list — the person who packs the box
  // is not always the person who sold it.
  const guard = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  // Shipping, voiding, clearing, restoring and adding freight all change the ledger
  // (and push to monday), so they need a write permission: PROPOSAL_WRITE, held by
  // every staff role that does the work (reps pack and ship belts too), but not by
  // READ_ONLY or INSTALLER. Reading the list stays on PROPOSAL_READ.
  const manage = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };

  /**
   * Everything the screen needs in one call: the belts still owed, grouped-ready,
   * plus the slips already printed.
   */
  app.get('/belt-shipments', guard, async () => {
    const ledger = await readLedger();

    const lines = await prisma.procurementLine.findMany({
      where: {
        sku: { startsWith: BELT_SKU_PREFIX, mode: 'insensitive' },
        order: { status: { notIn: DEAD_STATUSES as unknown as never[] } },
      },
      select: {
        id: true,
        sku: true,
        name: true,
        quantity: true,
        order: {
          select: {
            id: true,
            number: true,
            organizationId: true,
            createdAt: true,
            proposalId: true,
            // The Deal Tracking row, for the customer email and phone. Often null (it
            // is only recorded when the proposal named a deal) — the proposal's own
            // Project ID is the fallback, below.
            mondayProjectId: true,
            // The frozen accepted proposal. Its sections carry the meta the proposal
            // was written with, including the contact the letter was addressed to —
            // which is the name that should already be on the slip.
            contentSnapshot: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    });

    // Proposal numbers, one query for the whole list.
    const proposalIds = Array.from(new Set(lines.map((l) => l.order.proposalId).filter(Boolean)));
    const proposals = proposalIds.length
      ? await prisma.proposal.findMany({
          where: { id: { in: proposalIds } },
          select: { id: true, number: true },
        })
      : [];
    const proposalNumberById = new Map(proposals.map((p) => [p.id, p.number]));

    const orgIds = Array.from(new Set(lines.map((l) => l.order.organizationId)));
    const orgs = orgIds.length
      ? await prisma.organization.findMany({
          where: { id: { in: orgIds } },
          select: {
            id: true,
            name: true,
            addresses: {
              select: {
                type: true,
                line1: true,
                line2: true,
                city: true,
                region: true,
                postalCode: true,
              },
            },
            contacts: {
              select: { firstName: true, lastName: true, title: true, email: true, phone: true },
              take: 4,
            },
          },
        })
      : [];
    const orgById = new Map(orgs.map((o) => [o.id, o]));

    /**
     * Which monday deal each order belongs to, for its customer email and phone: the
     * order's own Deal Tracking id, else the Project ID on the accepted proposal (which
     * IS the deal item id), else the customer's most recently updated linked deal.
     */
    const opps = orgIds.length
      ? await prisma.opportunity.findMany({
          where: { organizationId: { in: orgIds }, mondayItemId: { not: null } },
          orderBy: { updatedAt: 'desc' },
          select: { organizationId: true, mondayItemId: true },
        })
      : [];
    const latestDealByOrg = new Map<string, string>();
    for (const o of opps) {
      if (o.mondayItemId && !latestDealByOrg.has(o.organizationId)) {
        latestDealByOrg.set(o.organizationId, o.mondayItemId);
      }
    }
    const dealItemFor = (order: (typeof lines)[number]['order']): string => {
      const own = String(order.mondayProjectId ?? '').trim();
      if (/^\d+$/.test(own)) return own;
      const fromProposal = String(snapshotMeta(order.contentSnapshot).projectId ?? '').trim();
      if (/^\d+$/.test(fromProposal)) return fromProposal;
      return latestDealByOrg.get(order.organizationId) ?? '';
    };
    const dealContacts = await readDealContacts(lines.map((l) => dealItemFor(l.order)));

    const owed = lines
      .map((l) => {
        const shipped = ledger.shipped[l.id] || 0;
        const cleared = ledger.cleared[l.id]?.qty || 0;
        const remaining = Math.max(0, l.quantity - shipped - cleared);
        const org = orgById.get(l.order.organizationId);
        const addresses = org?.addresses || [];
        const ship = primaryShippingAddress(addresses) || addresses[0];
        // The contact the proposal was addressed to.
        //
        // sections is an ARRAY of section objects, and the proposal's meta is the one
        // with id 'meta', under .data — the same shape app.js reads when it builds the
        // document. Read defensively either way: the snapshot is free-form JSON frozen
        // at acceptance, so an older order may not carry a meta section at all.
        const meta = snapshotMeta(l.order.contentSnapshot) as { contactName?: unknown };
        const contactName = typeof meta.contactName === 'string' ? meta.contactName.trim() : '';
        // Email and phone: the monday deal's own columns first — the ones the team
        // keeps current — and the CRM contact (the proposal's, else the first with
        // one) when the deal has none or monday could not be read.
        const deal = dealContacts.get(dealItemFor(l.order));
        const crm = org?.contacts || [];
        const named = contactName
          ? crm.find(
              (c) =>
                [c.firstName, c.lastName].filter(Boolean).join(' ').toLowerCase() ===
                contactName.toLowerCase(),
            )
          : undefined;
        const email = deal?.email || named?.email || crm.find((c) => c.email)?.email || '';
        const phone = deal?.phone || named?.phone || crm.find((c) => c.phone)?.phone || '';
        return {
          lineId: l.id,
          sku: l.sku || '',
          item: l.name,
          ordered: l.quantity,
          shipped,
          remaining,
          orgId: l.order.organizationId,
          customer: org?.name || 'Unknown customer',
          orderNumber: l.order.number,
          proposalNumber: proposalNumberById.get(l.order.proposalId) || '',
          contactName,
          orderedOn: l.order.createdAt.toISOString().slice(0, 10),
          address: formatAddress(ship),
          email,
          phone: formatUsPhone(phone),
          contacts: (org?.contacts || []).map((c) =>
            [[c.firstName, c.lastName].filter(Boolean).join(' '), c.title]
              .filter(Boolean)
              .join(', '),
          ),
        };
      })
      .filter((r) => r.remaining > 0);

    const cleared = Object.entries(ledger.cleared)
      .map(([lineId, c]) => ({ lineId, ...c }))
      .sort((a, b) => b.clearedAt.localeCompare(a.clearedAt));

    return { owed, cleared, slips: ledger.slips, seq: ledger.seq };
  });

  /**
   * Record a shipment: add a slip and credit the lines it covers.
   *
   * Quantities are added to the ledger rather than replacing it, so two people
   * shipping at once cannot silently undo each other, and a partial shipment leaves
   * the balance owed.
   */
  app.post('/belt-shipments/ship', manage, async (req) => {
    const Body = z.object({
      slip: Slip.omit({
        id: true,
        number: true,
        shippedById: true,
        shippedBy: true,
        shippedAt: true,
        voidedById: true,
        voidedBy: true,
        voidedAt: true,
        mondaySubitemId: true,
        mondaySubitemBoardId: true,
        mondayNote: true,
      }),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('That shipment could not be read.');
    const { slip } = parsed.data;
    if (!slip.lines.length) throw new ValidationError('A slip needs at least one item.');

    const { ledger, updatedAt } = await readLedgerRow();

    // Never credit more than the BOM says is owed: a typo must not make the belt
    // disappear off the list for good.
    const ids = slip.lines.map((l) => l.lineId).filter(Boolean);
    // Scoped to belt SKUs, matching the GET list above — an id for any other
    // procurement line is not a belt this screen has any business crediting.
    const known = ids.length
      ? await prisma.procurementLine.findMany({
          where: { id: { in: ids }, sku: { startsWith: BELT_SKU_PREFIX, mode: 'insensitive' } },
          select: { id: true, quantity: true },
        })
      : [];
    // A cleared line's written-off pieces are not available to ship.
    const capById = new Map(
      known.map((k) => [k.id, Math.max(0, k.quantity - (ledger.cleared[k.id]?.qty || 0))]),
    );

    for (const line of slip.lines) {
      if (!line.lineId) continue;
      const cap = capById.get(line.lineId);
      if (cap == null)
        throw new ValidationError('One of those items is no longer on the bill of materials.');
      const already = ledger.shipped[line.lineId] || 0;
      ledger.shipped[line.lineId] = Math.min(cap, already + line.qty);
    }

    const who = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { name: true, email: true },
    });

    ledger.seq += 1;
    const record = {
      ...slip,
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      number: `PS-${String(ledger.seq).padStart(4, '0')}`,
      shippedById: req.user!.sub,
      shippedBy: who?.name || who?.email || '',
      shippedAt: new Date().toISOString(),
      voidedById: '',
      voidedBy: '',
      voidedAt: '',
      mondaySubitemId: '',
      mondaySubitemBoardId: '',
      mondayNote: '',
    };
    ledger.slips.push(record);

    await writeLedger(ledger, updatedAt, req.user!.sub);
    // A slip with no ProcurementLine behind ANY of its rows shipped nothing off a bill
    // of materials — a replacement, goodwill, or otherwise off-order shipment. Tagged
    // distinctly in the audit trail so that traffic is reviewable on its own, separate
    // from ordinary order fulfillment. `some`, not `every`: a slip mixing one real BOM
    // line with one off-order line still contains off-order traffic that needs the same
    // review — `every` let a mixed slip pass as ordinary and defeated the whole point.
    const manual = record.lines.some((l) => !l.lineId);
    await recordAudit({
      actorId: req.user!.sub,
      action: manual ? 'belt.shipment.ship.manual' : 'belt.shipment.ship',
      entity: 'UiSetting',
      entityId: KEY,
      details: {
        slip: record.number,
        customer: record.customer,
        pieces: record.lines.reduce((a, l) => a + l.qty, 0),
        manual,
      },
    });

    // The "UEU Belt(s)" subitem on the customer's Manufacturing row. Never fails the
    // shipment — the slip is recorded either way, and the outcome rides on the slip.
    const monday = await syncBeltSlipToMonday(record);
    record.mondaySubitemId = monday.subitemId;
    record.mondaySubitemBoardId = monday.subitemBoardId;
    record.mondayNote = monday.note;
    await saveMondayResult(record.id, monday, req.user!.sub).catch((err: unknown) =>
      req.log.warn({ err, slip: record.number }, 'belt shipment: could not save monday result'),
    );

    return { slip: record, monday };
  });

  /** The Freight Carrier dropdown's options — the labels on the monday column. */
  app.get('/belt-shipments/carriers', guard, async () => carrierOptions());

  /**
   * Set a slip's Freight Carrier and/or Freight Tracking ID, and write them through to
   * its monday subitem (creating the subitem if the first attempt at print time did
   * not land — this is the retry path too).
   */
  app.post('/belt-shipments/freight', manage, async (req) => {
    const Body = z.object({
      slipId: z.string().trim().min(1).max(40),
      carrier: z.string().trim().max(80).optional(),
      trackingId: z.string().trim().max(120).optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('That freight detail could not be read.');
    const { slipId, carrier, trackingId } = parsed.data;

    if (carrier) {
      const { labels } = await carrierOptions();
      if (!labels.includes(carrier)) {
        throw new ValidationError('That carrier is not one of the Freight Carrier options.');
      }
    }

    const { ledger, updatedAt } = await readLedgerRow();
    const slip = ledger.slips.find((s) => s.id === slipId);
    if (!slip) throw new ValidationError('That slip is no longer on file.');
    if (carrier !== undefined) slip.carrier = carrier;
    if (trackingId !== undefined) slip.trackingId = trackingId;
    await writeLedger(ledger, updatedAt, req.user!.sub);

    const monday = await syncBeltSlipToMonday(slip);
    slip.mondaySubitemId = monday.subitemId;
    slip.mondaySubitemBoardId = monday.subitemBoardId;
    slip.mondayNote = monday.note;
    await saveMondayResult(slip.id, monday, req.user!.sub);

    await recordAudit({
      actorId: req.user!.sub,
      action: 'belt.shipment.freight',
      entity: 'UiSetting',
      entityId: KEY,
      details: { slip: slip.number, carrier: slip.carrier, trackingId: slip.trackingId },
    });
    return { slip, monday };
  });

  /**
   * Void a slip: give its pieces back to the list and mark it withdrawn.
   *
   * The slip is NOT deleted. It may already be in a box in the post, so the record of
   * having printed it has to survive, along with who withdrew it and when.
   */
  app.post('/belt-shipments/void', manage, async (req) => {
    const Body = z.object({ slipId: z.string().trim().min(1).max(40) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Which slip?');

    const { ledger, updatedAt } = await readLedgerRow();
    const slip = ledger.slips.find((s) => s.id === parsed.data.slipId);
    if (!slip) throw new ValidationError('That slip is no longer on file.');

    if (slip.voidedAt) throw new ValidationError('That slip has already been voided.');

    for (const line of slip.lines) {
      if (!line.lineId) continue;
      ledger.shipped[line.lineId] = Math.max(0, (ledger.shipped[line.lineId] || 0) - line.qty);
      if (!ledger.shipped[line.lineId]) delete ledger.shipped[line.lineId];
    }

    const voider = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { name: true, email: true },
    });
    slip.voidedById = req.user!.sub;
    slip.voidedBy = voider?.name || voider?.email || '';
    slip.voidedAt = new Date().toISOString();

    await writeLedger(ledger, updatedAt, req.user!.sub);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'belt.shipment.void',
      entity: 'UiSetting',
      entityId: KEY,
      details: { slip: slip.number, customer: slip.customer },
    });

    return { voided: slip.number };
  });

  /**
   * Clear belts from the queue without printing a slip: whatever is still owed on
   * each line is written off in the ledger, with who did it, when and why. The bill
   * of materials is not touched, and Restore (below) undoes it. A line whose BOM
   * quantity later goes up reappears with only the new pieces.
   */
  app.post('/belt-shipments/clear', manage, async (req) => {
    const Body = z.object({
      lineIds: z.array(z.string().trim().min(1).max(40)).min(1).max(200),
      reason: z.string().trim().max(300).default(''),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Which belts should be cleared?');
    const { reason } = parsed.data;
    const ids = Array.from(new Set(parsed.data.lineIds));

    const { ledger, updatedAt } = await readLedgerRow();
    const lines = await prisma.procurementLine.findMany({
      where: { id: { in: ids }, sku: { startsWith: BELT_SKU_PREFIX, mode: 'insensitive' } },
      select: {
        id: true,
        sku: true,
        name: true,
        quantity: true,
        order: { select: { number: true, organizationId: true, proposalId: true } },
      },
    });
    if (lines.length !== ids.length) {
      throw new ValidationError('One of those items is no longer on the bill of materials.');
    }
    const orgs = await prisma.organization.findMany({
      where: { id: { in: Array.from(new Set(lines.map((l) => l.order.organizationId))) } },
      select: { id: true, name: true },
    });
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const proposals = await prisma.proposal.findMany({
      where: { id: { in: Array.from(new Set(lines.map((l) => l.order.proposalId))) } },
      select: { id: true, number: true },
    });
    const proposalNumber = new Map(proposals.map((p) => [p.id, p.number]));
    const who = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { name: true, email: true },
    });
    const now = new Date().toISOString();

    const done: Array<{ lineId: string; qty: number }> = [];
    for (const l of lines) {
      const prior = ledger.cleared[l.id];
      const remaining = l.quantity - (ledger.shipped[l.id] || 0) - (prior?.qty || 0);
      if (remaining <= 0) continue;
      ledger.cleared[l.id] = {
        qty: (prior?.qty || 0) + remaining,
        customer: orgName.get(l.order.organizationId) || '',
        item: l.name,
        sku: l.sku || '',
        orderNumber: l.order.number,
        proposalNumber: proposalNumber.get(l.order.proposalId) || '',
        reason,
        clearedById: req.user!.sub,
        clearedBy: who?.name || who?.email || '',
        clearedAt: now,
      };
      done.push({ lineId: l.id, qty: remaining });
    }
    if (!done.length) throw new ValidationError('Nothing on those lines is still owed.');

    await writeLedger(ledger, updatedAt, req.user!.sub);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'belt.shipment.clear',
      entity: 'UiSetting',
      entityId: KEY,
      details: {
        lines: done.map((d) => ({
          ...d,
          customer: ledger.cleared[d.lineId]?.customer ?? '',
          item: ledger.cleared[d.lineId]?.item ?? '',
        })),
        pieces: done.reduce((a, d) => a + d.qty, 0),
        reason,
      },
    });
    return { cleared: done };
  });

  /** Put a cleared line back on the queue. */
  app.post('/belt-shipments/restore', manage, async (req) => {
    const Body = z.object({ lineId: z.string().trim().min(1).max(40) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Which belt?');
    const { ledger, updatedAt } = await readLedgerRow();
    const entry = ledger.cleared[parsed.data.lineId];
    if (!entry) throw new ValidationError('That belt is not cleared.');
    delete ledger.cleared[parsed.data.lineId];

    await writeLedger(ledger, updatedAt, req.user!.sub);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'belt.shipment.restore',
      entity: 'UiSetting',
      entityId: KEY,
      details: {
        lineId: parsed.data.lineId,
        customer: entry.customer,
        item: entry.item,
        qty: entry.qty,
      },
    });
    return { restored: parsed.data.lineId };
  });
}
