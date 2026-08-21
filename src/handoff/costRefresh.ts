import { prisma } from '../lib/prisma.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';

/**
 * Bringing a locked order's costs back in line with the catalog.
 *
 * A proposal's costs are copied onto the order at acceptance and the Bill of
 * Materials prints from that copy, not from the catalog. That is correct and has to
 * stay correct: the sheet a vendor was sent must keep saying what it said, and a
 * margin report for a job that shipped in March must not silently change in August
 * because someone edited a part.
 *
 * The cost of that correctness is this: when a catalog cost was simply WRONG — a
 * typo, a vendor price rise entered late — every open job carries the wrong figure
 * and nothing propagates. That is a real and frequent problem, and the answer is a
 * deliberate, reviewed, logged re-read rather than either automatic propagation or
 * editing the database by hand.
 *
 * So: a preview that states every difference in words and money, and an apply that
 * takes an explicit list of lines. Nothing is repriced that somebody has not looked
 * at. Three rules:
 *
 *   1. **Cost is internal.** This moves the BOM's totals and the job's margin. It
 *      does NOT touch the proposal, the price snapshot, the invoice, or anything the
 *      customer has signed or been sent. There is no path from here to a customer.
 *   2. **A submitted section is frozen.** The vendor is holding that sheet. Those
 *      lines are reported as blocked, with the reason, rather than skipped silently.
 *   3. **Free issue stays free.** Summit has already paid for the part; it prints at
 *      zero on the vendor's sheet. Its underlying cost is refreshed, since that is
 *      what the margin uses, but nothing about the printed zero changes.
 */

export interface CostRefreshRow {
  lineId: string;
  sku: string;
  name: string;
  vendor: string;
  quantity: number;
  currentMinor: number;
  catalogMinor: number | null;
  deltaMinor: number;
  extendedDeltaMinor: number;
  freeIssue: boolean;
  /** Why this line cannot be refreshed, or null when it can. */
  blocked: string | null;
}

export interface CostRefreshPreview {
  orderId: string;
  rows: CostRefreshRow[];
  /** Lines whose cost would move and which nothing is stopping. */
  changeable: number;
  /** Sum of the extended differences across those lines. */
  netMinor: number;
  /** Lines with no catalog row to read — hand-added parts, generated mat SKUs. */
  unmatched: number;
  blocked: number;
}

const s = (v: unknown): string => (v == null ? '' : String(v));

/**
 * What would change, and what would not.
 *
 * Reads every procurement line on the order, matches each to the catalog by part
 * number, and reports the difference. Lines that match at the same cost are left out
 * entirely — a list of two hundred rows that says "no change" two hundred times is
 * not a review, it is a wall.
 */
export async function previewCostRefresh(
  orderId: string,
  opts: { vendor?: string } = {},
): Promise<CostRefreshPreview> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order not found');

  const lines = await prisma.procurementLine.findMany({
    where: { orderId, ...(opts.vendor ? { vendor: opts.vendor } : {}) },
    select: {
      id: true,
      sku: true,
      name: true,
      vendor: true,
      quantity: true,
      unitCostMinor: true,
      freeIssue: true,
    },
    orderBy: [{ vendor: 'asc' }, { sku: 'asc' }],
  });
  if (!lines.length) {
    return { orderId, rows: [], changeable: 0, netMinor: 0, unmatched: 0, blocked: 0 };
  }

  const parts = [...new Set(lines.map((l) => s(l.sku).trim()).filter(Boolean))];
  const [skus, sections] = await Promise.all([
    parts.length
      ? prisma.sku.findMany({
          where: { part: { in: parts, mode: 'insensitive' } },
          select: { part: true, unitCostMinor: true },
        })
      : Promise.resolve([]),
    prisma.bomVendorSection.findMany({
      where: { orderId },
      select: { vendor: true, status: true },
    }),
  ]);

  const catalog = new Map(skus.map((k) => [k.part.trim().toUpperCase(), k.unitCostMinor ?? 0]));
  const submitted = new Set(sections.filter((x) => x.status === 'SUBMITTED').map((x) => x.vendor));

  const rows: CostRefreshRow[] = [];
  let unmatched = 0;

  for (const l of lines) {
    const sku = s(l.sku).trim();
    const vendor = s(l.vendor).trim() || 'Unassigned vendor';
    const current = Number(l.unitCostMinor ?? 0);
    const catalogMinor = sku ? (catalog.get(sku.toUpperCase()) ?? null) : null;

    if (catalogMinor == null) {
      // No catalog row: a hand-added part, or a generated mat number that has never
      // been stocked. Counted so the dialog can say so, not listed as a change.
      unmatched += 1;
      continue;
    }
    if (catalogMinor === current) continue;

    const qty = Number(l.quantity) || 0;
    rows.push({
      lineId: l.id,
      sku,
      name: s(l.name),
      vendor,
      quantity: qty,
      currentMinor: current,
      catalogMinor,
      deltaMinor: catalogMinor - current,
      extendedDeltaMinor: (catalogMinor - current) * qty,
      freeIssue: !!l.freeIssue,
      blocked: submitted.has(vendor)
        ? `The ${vendor} sheet has been submitted. Unlock that section to reprice its lines.`
        : null,
    });
  }

  const open = rows.filter((r) => !r.blocked);
  return {
    orderId,
    rows,
    changeable: open.length,
    netMinor: open.reduce((a, r) => a + r.extendedDeltaMinor, 0),
    unmatched,
    blocked: rows.length - open.length,
  };
}

export interface CostRefreshResult {
  applied: number;
  netMinor: number;
  skipped: Array<{ lineId: string; reason: string }>;
}

/**
 * Apply the catalog cost to the named lines.
 *
 * Takes explicit line ids rather than "everything in the preview": the preview is a
 * moment in time, and between reading it and clicking apply somebody may have
 * submitted a section or edited a cost. Every line is re-checked here against the
 * catalog and the section status, so what gets written is what is true now, and
 * anything that has moved underneath is reported rather than forced.
 */
export async function applyCostRefresh(
  orderId: string,
  lineIds: string[],
  actorId: string,
): Promise<CostRefreshResult> {
  const wanted = [...new Set((lineIds ?? []).map((id) => s(id).trim()).filter(Boolean))];
  if (!wanted.length) throw new ValidationError('Pick at least one line to reprice.');

  const preview = await previewCostRefresh(orderId);
  const byId = new Map(preview.rows.map((r) => [r.lineId, r]));

  const skipped: Array<{ lineId: string; reason: string }> = [];
  const doable: CostRefreshRow[] = [];
  for (const id of wanted) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({
        lineId: id,
        reason: 'That line no longer differs from the catalog — somebody has already changed it.',
      });
      continue;
    }
    if (row.blocked) {
      skipped.push({ lineId: id, reason: row.blocked });
      continue;
    }
    doable.push(row);
  }
  if (!doable.length) {
    return { applied: 0, netMinor: 0, skipped };
  }

  await prisma.$transaction(
    doable.map((r) =>
      prisma.procurementLine.update({
        where: { id: r.lineId },
        data: { unitCostMinor: r.catalogMinor ?? 0 },
      }),
    ),
  );

  const netMinor = doable.reduce((a, r) => a + r.extendedDeltaMinor, 0);
  const detail = {
    lines: doable.map((r) => ({
      sku: r.sku,
      name: r.name,
      vendor: r.vendor,
      quantity: r.quantity,
      fromMinor: r.currentMinor,
      toMinor: r.catalogMinor,
      extendedDeltaMinor: r.extendedDeltaMinor,
    })),
    count: doable.length,
    netMinor,
    skipped,
  };

  // Both, deliberately. The order event is what somebody reading this job's history
  // sees; the audit row is what an auditor asking "who repriced anything, ever"
  // searches. Neither is a substitute for the other.
  //
  // The event is written straight to the table rather than through service.ts's
  // logEvent, which is module-private — exporting it to reach it from here would
  // widen that module's surface for the sake of one call.
  await prisma.orderEvent.create({
    data: {
      orderId,
      action: 'bom.cost.refresh',
      actorId,
      detail: detail as unknown as object,
    },
  });
  await recordAudit({
    actorId,
    action: 'bom.cost.refresh',
    entity: 'AcceptedOrder',
    entityId: orderId,
    details: detail,
  });

  return { applied: doable.length, netMinor, skipped };
}
