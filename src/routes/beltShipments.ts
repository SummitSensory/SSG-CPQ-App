import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';

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
 * out, and the slips that were printed. That lives in one UiSetting JSON document,
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
  note: z.string().trim().max(400).default(''),
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

const Ledger = z.object({
  /** ProcurementLine id -> total pieces shipped against it. */
  shipped: z.record(z.string().max(40), z.number().int().min(0).max(9999)).default({}),
  slips: z.array(Slip).max(2000).default([]),
  seq: z.number().int().min(0).max(1_000_000).default(0),
});

type LedgerT = z.infer<typeof Ledger>;

const EMPTY_LEDGER: LedgerT = { shipped: {}, slips: [], seq: 0 };

async function readLedger(): Promise<LedgerT> {
  const row = await prisma.uiSetting.findUnique({ where: { key: KEY } });
  if (!row) return EMPTY_LEDGER;
  try {
    return Ledger.parse(JSON.parse(row.value));
  } catch {
    // A malformed document must not take the screen down with it.
    return EMPTY_LEDGER;
  }
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
            contacts: { select: { firstName: true, lastName: true, title: true }, take: 4 },
          },
        })
      : [];
    const orgById = new Map(orgs.map((o) => [o.id, o]));

    const owed = lines
      .map((l) => {
        const shipped = ledger.shipped[l.id] || 0;
        const remaining = Math.max(0, l.quantity - shipped);
        const org = orgById.get(l.order.organizationId);
        const addresses = org?.addresses || [];
        const ship = addresses.find((a) => a.type === 'SHIPPING') || addresses[0];
        // The contact the proposal was addressed to.
        //
        // sections is an ARRAY of section objects, and the proposal's meta is the one
        // with id 'meta', under .data — the same shape app.js reads when it builds the
        // document. Read defensively either way: the snapshot is free-form JSON frozen
        // at acceptance, so an older order may not carry a meta section at all.
        const snap = l.order.contentSnapshot as { sections?: unknown } | null;
        const sections = Array.isArray(snap?.sections)
          ? (snap!.sections as Array<Record<string, unknown>>)
          : [];
        const metaSection = sections.find((sec) => sec && sec.id === 'meta');
        const meta = (metaSection?.data ?? {}) as { contactName?: unknown };
        const contactName = typeof meta.contactName === 'string' ? meta.contactName.trim() : '';
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
          contacts: (org?.contacts || []).map((c) =>
            [[c.firstName, c.lastName].filter(Boolean).join(' '), c.title]
              .filter(Boolean)
              .join(', '),
          ),
        };
      })
      .filter((r) => r.remaining > 0);

    return { owed, slips: ledger.slips, seq: ledger.seq };
  });

  /**
   * Record a shipment: add a slip and credit the lines it covers.
   *
   * Quantities are added to the ledger rather than replacing it, so two people
   * shipping at once cannot silently undo each other, and a partial shipment leaves
   * the balance owed.
   */
  app.post('/belt-shipments/ship', guard, async (req) => {
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
      }),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('That shipment could not be read.');
    const { slip } = parsed.data;
    if (!slip.lines.length) throw new ValidationError('A slip needs at least one item.');

    const ledger = await readLedger();

    // Never credit more than the BOM says is owed: a typo must not make the belt
    // disappear off the list for good.
    const ids = slip.lines.map((l) => l.lineId).filter(Boolean);
    const known = ids.length
      ? await prisma.procurementLine.findMany({
          where: { id: { in: ids } },
          select: { id: true, quantity: true },
        })
      : [];
    const capById = new Map(known.map((k) => [k.id, k.quantity]));

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
    };
    ledger.slips.push(record);

    const value = JSON.stringify(Ledger.parse(ledger));
    await prisma.uiSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value, updatedById: req.user!.sub },
      update: { value, updatedById: req.user!.sub, updatedAt: new Date() },
    });
    // A slip with no ProcurementLine behind any of its rows shipped nothing off a bill
    // of materials — a replacement, goodwill, or otherwise off-order shipment. Tagged
    // distinctly in the audit trail so that traffic is reviewable on its own, separate
    // from ordinary order fulfillment.
    const manual = record.lines.every((l) => !l.lineId);
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

    return { slip: record };
  });

  /**
   * Void a slip: give its pieces back to the list and mark it withdrawn.
   *
   * The slip is NOT deleted. It may already be in a box in the post, so the record of
   * having printed it has to survive, along with who withdrew it and when.
   */
  app.post('/belt-shipments/void', guard, async (req) => {
    const Body = z.object({ slipId: z.string().trim().min(1).max(40) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Which slip?');

    const ledger = await readLedger();
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

    const value = JSON.stringify(Ledger.parse(ledger));
    await prisma.uiSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value, updatedById: req.user!.sub },
      update: { value, updatedById: req.user!.sub, updatedAt: new Date() },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'belt.shipment.void',
      entity: 'UiSetting',
      entityId: KEY,
      details: { slip: slip.number, customer: slip.customer },
    });

    return { voided: slip.number };
  });
}
