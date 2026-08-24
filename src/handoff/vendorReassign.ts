import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { ensureSections } from './bomSections.js';

/**
 * A part changing hands in the catalog, carried onto the orders already in flight.
 *
 * An accepted order stores each line's vendor as a NAME, snapshotted at acceptance,
 * which is what lets a sheet sent months ago still describe what was actually bought.
 * The cost of that rule is that re-sourcing a part in the catalog never reached the
 * live jobs: the part kept appearing on the old vendor's Bill of Materials, and the
 * new vendor was never asked for it.
 *
 * So a manufacturer change on a SKU moves that part's OPEN order lines with it.
 *
 * Two things are deliberately left alone:
 *
 *   1. A SUBMITTED section. That document is in the vendor's hands; moving a line off
 *      it silently would put the shop and the sheet out of step. Those lines are
 *      reported back, by order and vendor, so whoever made the catalog change is told
 *      what needs unlocking.
 *   2. An emptied section that carries history — questions answered, a sheet sent. It
 *      stays, because that history is the record of what was asked and when. A section
 *      with nothing in it and nothing behind it is removed, since an empty vendor block
 *      on the order page is only clutter.
 */

export interface VendorReassignSkip {
  orderNumber: string;
  vendor: string;
  reason: string;
}

export interface VendorReassignResult {
  part: string;
  toVendor: string;
  /** Lines moved onto the new vendor. */
  moved: number;
  /** Orders touched. */
  orders: number;
  skipped: VendorReassignSkip[];
}

const UNASSIGNED = 'Unassigned vendor';
const vendorOf = (v: string | null | undefined): string => (v && v.trim()) || UNASSIGNED;

/**
 * Move every open order line for `part` onto `toVendor`.
 *
 * Called after the catalog write, never instead of it: the catalog is the record of
 * where a part is bought now, and this only brings the live jobs into line with it.
 */
export async function reassignSkuVendor(
  part: string,
  toVendor: string | null | undefined,
  actorId: string,
): Promise<VendorReassignResult | null> {
  const sku = (part ?? '').trim();
  const target = (toVendor ?? '').trim();
  // Clearing a SKU's manufacturer is not a re-sourcing decision — it is an empty
  // field — and it must not strip the vendor off work already sold.
  if (!sku || !target) return null;

  const lines = await prisma.procurementLine.findMany({
    where: { sku: { equals: sku, mode: 'insensitive' } },
    select: {
      id: true,
      vendor: true,
      orderId: true,
      order: { select: { number: true } },
    },
  });
  const wrong = lines.filter((l) => vendorOf(l.vendor).toLowerCase() !== target.toLowerCase());
  if (!wrong.length) return null;

  const orderIds = [...new Set(wrong.map((l) => l.orderId))];
  const sections = await prisma.bomVendorSection.findMany({
    where: { orderId: { in: orderIds } },
    select: {
      id: true,
      orderId: true,
      vendor: true,
      status: true,
      _count: { select: { sends: true, answers: true } },
    },
  });
  const statusOf = new Map(
    sections.map((s) => [`${s.orderId}::${s.vendor.toLowerCase()}`, s.status]),
  );

  const skipped: VendorReassignSkip[] = [];
  const movable: typeof wrong = [];
  for (const l of wrong) {
    const from = vendorOf(l.vendor);
    const status = statusOf.get(`${l.orderId}::${from.toLowerCase()}`);
    const targetStatus = statusOf.get(`${l.orderId}::${target.toLowerCase()}`);
    if (status === 'SUBMITTED') {
      skipped.push({
        orderNumber: l.order.number,
        vendor: from,
        reason: `${from}'s Bill of Materials is submitted. Unlock it to move ${sku} to ${target}.`,
      });
      continue;
    }
    if (targetStatus === 'SUBMITTED') {
      skipped.push({
        orderNumber: l.order.number,
        vendor: target,
        reason: `${target}'s Bill of Materials is submitted. Unlock it before ${sku} is added to it.`,
      });
      continue;
    }
    movable.push(l);
  }
  if (!movable.length) return { part: sku, toVendor: target, moved: 0, orders: 0, skipped };

  await prisma.procurementLine.updateMany({
    where: { id: { in: movable.map((l) => l.id) } },
    data: { vendor: target },
  });

  const touched = [...new Set(movable.map((l) => l.orderId))];
  for (const orderId of touched) {
    const mine = movable.filter((l) => l.orderId === orderId);
    // The new vendor may not have a section on this order yet. Sections are derived
    // from the lines, so this is the same call the BOM page makes on load.
    await ensureSections(orderId, actorId);
    await prisma.orderEvent.create({
      data: {
        orderId,
        action: 'bom.line.vendorChanged',
        actorId,
        detail: {
          sku,
          to: target,
          from: [...new Set(mine.map((l) => vendorOf(l.vendor)))],
          lines: mine.length,
          reason: 'The catalog moved this part to another manufacturer',
        },
      },
    });

    // Sections left with no lines and no history are removed; anything that was asked
    // or sent stays, because that is the record.
    const remaining = await prisma.procurementLine.findMany({
      where: { orderId },
      select: { vendor: true },
    });
    const stillUsed = new Set(remaining.map((l) => vendorOf(l.vendor).toLowerCase()));
    const emptied = sections.filter(
      (s) =>
        s.orderId === orderId &&
        !stillUsed.has(s.vendor.toLowerCase()) &&
        s.status !== 'SUBMITTED' &&
        s._count.sends === 0 &&
        s._count.answers === 0,
    );
    if (emptied.length) {
      await prisma.bomVendorSection.deleteMany({ where: { id: { in: emptied.map((s) => s.id) } } });
    }
  }

  logger.info(
    {
      sku,
      toVendor: target,
      moved: movable.length,
      orders: touched.length,
      skipped: skipped.length,
    },
    'catalog re-sourcing: moved open order lines onto the new manufacturer',
  );
  return { part: sku, toVendor: target, moved: movable.length, orders: touched.length, skipped };
}
