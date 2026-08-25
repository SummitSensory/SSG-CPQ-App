import { prisma } from '../lib/prisma.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';

/**
 * Checking a vendor's invoice against the Bill of Materials they were sent.
 *
 * The submitted sheet is the claim — these parts, these quantities, this unit cost.
 * The invoice is what the vendor says they are owed. They disagree often enough that
 * it was being checked in a spreadsheet nobody kept, and an overcharge found six
 * weeks later is an overcharge already paid.
 *
 * Three rules hold here:
 *
 *   1. **The agreed cost is never overwritten.** `unitCostMinor` is what the sheet
 *      said; `invoicedUnitCostMinor` is what they billed. Writing the invoice over
 *      the agreement would erase the very difference it exists to show.
 *   2. **A blank is not a zero.** A line with no invoiced figure has not been checked;
 *      a line invoiced at zero is a line they did not charge for. Both are facts and
 *      they are not the same fact.
 *   3. **Every difference is reported.** No tolerance band — a cent is shown as a
 *      cent. Whether it matters is a judgement, and the judgement is the approval.
 *
 * Approval accepts the difference. It does not change the sheet, and it does not
 * change what the vendor was sent; it records that someone looked at the variance and
 * accepted it, with their name and the date against it.
 */

/**
 * Above this, in minor units, accepting a variance needs VENDOR_INVOICE_APPROVE.
 * Below it, whoever is doing the receiving can accept it and get on with the job.
 * Overridable per deployment without a code change.
 */
export const APPROVAL_THRESHOLD_MINOR = Number(
  process.env.VENDOR_INVOICE_APPROVAL_THRESHOLD_MINOR ?? 25000,
);

export interface InvoiceLineVariance {
  lineId: string;
  sku: string;
  name: string;
  quantity: number;
  /** What the sheet said, per unit. */
  agreedUnitMinor: number;
  /** What they invoiced, per unit. Null when nobody has typed it yet. */
  invoicedUnitMinor: number | null;
  /** invoiced - agreed, per unit. Null when uninvoiced. */
  unitDeltaMinor: number | null;
  /** The same difference across the line's quantity — the money at stake. */
  extendedDeltaMinor: number | null;
  /** Difference as a fraction of the agreed cost, or null when the agreed cost is 0. */
  deltaPct: number | null;
  /** Checked against the invoice and not on it. */
  notBilled: boolean;
}

export interface InvoiceVariance {
  /** Lines with an invoiced figure typed in. */
  checkedLines: number;
  /** Lines still waiting to be checked against the invoice. */
  uncheckedLines: number;
  /**
   * Lines checked and NOT on the invoice.
   *
   * Counted separately from the money, because an unbilled line is rarely good news:
   * a vendor who did not charge for a part usually did not ship it either, and that
   * turns up in the shop weeks later as a shortage. It is a chase, not a saving.
   */
  notBilledLines: number;
  /** What those unbilled lines were supposed to cost, at the sheet's figures. */
  notBilledMinor: number;
  /** The sheet's cost for the CHECKED lines only — the honest comparison base. */
  agreedMinor: number;
  /** What the vendor invoiced for those same lines. */
  invoicedMinor: number;
  /** invoiced - agreed. Positive means they billed more than the sheet said. */
  varianceMinor: number;
  variancePct: number | null;
  /** Whether accepting this variance needs the approval permission. */
  needsApproval: boolean;
  thresholdMinor: number;
}

interface LineLike {
  id: string;
  sku: string | null;
  name: string;
  quantity: number | string | { toString(): string };
  unitCostMinor: number | null;
  invoicedUnitCostMinor: number | null;
  /** Checked, and genuinely not on their invoice. */
  invoiceNotBilled?: boolean | null;
  freeIssue?: boolean | null;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);

/** Per-line differences, in the order the lines were given. */
export function lineVariances(lines: LineLike[]): InvoiceLineVariance[] {
  return lines.map((l) => {
    const qty = num(l.quantity);
    const agreed = num(l.unitCostMinor);
    const invoiced = l.invoicedUnitCostMinor == null ? null : num(l.invoicedUnitCostMinor);
    const unitDelta = invoiced == null ? null : invoiced - agreed;
    return {
      lineId: l.id,
      sku: (l.sku ?? '').trim(),
      name: l.name,
      quantity: qty,
      agreedUnitMinor: agreed,
      invoicedUnitMinor: invoiced,
      unitDeltaMinor: unitDelta,
      extendedDeltaMinor: unitDelta == null ? null : unitDelta * qty,
      deltaPct: unitDelta == null || agreed === 0 ? null : (unitDelta / agreed) * 100,
      notBilled: !!l.invoiceNotBilled,
    };
  });
}

/**
 * The section's totals.
 *
 * Only lines that have been CHECKED are counted. Comparing an invoice against the
 * whole sheet while half of it is untyped reports a huge underbilling that is really
 * just work not done yet.
 */
export function summarize(lines: LineLike[]): InvoiceVariance {
  let agreedMinor = 0;
  let invoicedMinor = 0;
  let checked = 0;
  let unchecked = 0;
  let notBilled = 0;
  let notBilledMinor = 0;

  for (const l of lines) {
    const qty = num(l.quantity);
    // Marked as not on the invoice: counted as CHECKED and invoiced at nothing, which
    // is the truth — they were asked for it and did not bill it. It shows as a negative
    // variance, which is correct arithmetic and the wrong reading, so the count beside
    // it is what the screen actually leads with.
    if (l.invoiceNotBilled) {
      checked += 1;
      notBilled += 1;
      notBilledMinor += num(l.unitCostMinor) * qty;
      agreedMinor += num(l.unitCostMinor) * qty;
      continue;
    }
    if (l.invoicedUnitCostMinor == null) {
      unchecked += 1;
      continue;
    }
    checked += 1;
    agreedMinor += num(l.unitCostMinor) * qty;
    invoicedMinor += num(l.invoicedUnitCostMinor) * qty;
  }

  const varianceMinor = invoicedMinor - agreedMinor;
  return {
    checkedLines: checked,
    uncheckedLines: unchecked,
    notBilledLines: notBilled,
    notBilledMinor,
    agreedMinor,
    invoicedMinor,
    varianceMinor,
    variancePct: agreedMinor === 0 ? null : (varianceMinor / agreedMinor) * 100,
    needsApproval: Math.abs(varianceMinor) >= APPROVAL_THRESHOLD_MINOR,
    thresholdMinor: APPROVAL_THRESHOLD_MINOR,
  };
}

/**
 * Accept the difference between this vendor's invoice and their sheet.
 *
 * `canApproveAboveThreshold` is the caller's permission, passed in rather than read
 * here: the route owns authorization, this owns the rule about when it is needed.
 */
export async function approveVendorInvoice(
  sectionId: string,
  actorId: string,
  canApproveAboveThreshold: boolean,
): Promise<{ varianceMinor: number; approvedAt: Date }> {
  const section = await prisma.bomVendorSection.findUnique({
    where: { id: sectionId },
    select: {
      id: true,
      orderId: true,
      vendor: true,
      invoiceApprovedAt: true,
      vendorInvoiceNumber: true,
    },
  });
  if (!section) throw new NotFoundError('Bill of Materials section not found');
  if (section.invoiceApprovedAt) {
    throw new ValidationError('This invoice has already been accepted.');
  }

  const lines = await prisma.procurementLine.findMany({
    where: { orderId: section.orderId },
    select: {
      id: true,
      sku: true,
      name: true,
      quantity: true,
      vendor: true,
      unitCostMinor: true,
      invoicedUnitCostMinor: true,
      invoiceNotBilled: true,
    },
  });
  const mine = lines.filter(
    (l) => ((l.vendor && l.vendor.trim()) || 'Unassigned vendor') === section.vendor,
  );
  const totals = summarize(mine);

  if (!totals.checkedLines) {
    throw new ValidationError(
      'No invoiced figures have been entered for this vendor yet, so there is nothing to accept.',
    );
  }
  // Accepting with lines still unchecked would freeze a comparison that was never
  // finished, and the unchecked lines are exactly where an unbilled part hides.
  if (totals.uncheckedLines) {
    throw new ValidationError(
      `${totals.uncheckedLines} line${totals.uncheckedLines === 1 ? ' has' : 's have'} not been checked against this invoice yet. ` +
        'Enter what the vendor billed, or mark the line as not billed, then accept.',
    );
  }
  if (totals.needsApproval && !canApproveAboveThreshold) {
    throw new ValidationError(
      `This invoice differs from the sheet by ${(Math.abs(totals.varianceMinor) / 100).toFixed(2)}, ` +
        `which is over the ${(APPROVAL_THRESHOLD_MINOR / 100).toFixed(2)} threshold. A manager has to accept it.`,
    );
  }

  const approvedAt = new Date();
  await prisma.bomVendorSection.update({
    where: { id: sectionId },
    data: { invoiceApprovedAt: approvedAt, invoiceApprovedById: actorId },
  });
  await prisma.orderEvent.create({
    data: {
      orderId: section.orderId,
      action: 'bom.invoice.accepted',
      actorId,
      detail: {
        vendor: section.vendor,
        invoiceNumber: section.vendorInvoiceNumber,
        checkedLines: totals.checkedLines,
        agreedMinor: totals.agreedMinor,
        invoicedMinor: totals.invoicedMinor,
        varianceMinor: totals.varianceMinor,
      },
    },
  });
  return { varianceMinor: totals.varianceMinor, approvedAt };
}

/** Withdraw an acceptance — the figure turned out to be wrong after all. */
export async function reopenVendorInvoice(sectionId: string, reason: string, actorId: string) {
  const section = await prisma.bomVendorSection.findUnique({
    where: { id: sectionId },
    select: { id: true, orderId: true, vendor: true, invoiceApprovedAt: true },
  });
  if (!section) throw new NotFoundError('Bill of Materials section not found');
  if (!reason.trim()) throw new ValidationError('Give a reason for reopening this invoice');
  if (!section.invoiceApprovedAt) return section;
  await prisma.bomVendorSection.update({
    where: { id: sectionId },
    data: { invoiceApprovedAt: null, invoiceApprovedById: null },
  });
  await prisma.orderEvent.create({
    data: {
      orderId: section.orderId,
      action: 'bom.invoice.reopened',
      actorId,
      detail: { vendor: section.vendor, reason: reason.trim() },
    },
  });
  return section;
}

/**
 * Every order with an invoice variance on it, across the company.
 *
 * Ordered by the money at stake, because that is the order somebody would work the
 * list in. Accepted variances are included and marked — an accepted overcharge is
 * still a fact about that vendor, and the pattern is only visible if it stays listed.
 */
export async function invoiceVarianceReport() {
  const [lines, orders, sections, orgs] = await Promise.all([
    prisma.procurementLine.findMany({
      where: { OR: [{ invoicedUnitCostMinor: { not: null } }, { invoiceNotBilled: true }] },
      select: {
        id: true,
        orderId: true,
        sku: true,
        name: true,
        vendor: true,
        quantity: true,
        unitCostMinor: true,
        invoicedUnitCostMinor: true,
        invoiceNotBilled: true,
      },
    }),
    prisma.acceptedOrder.findMany({
      select: { id: true, number: true, jobName: true, organizationId: true, status: true },
    }),
    prisma.bomVendorSection.findMany({
      select: {
        orderId: true,
        vendor: true,
        status: true,
        vendorInvoiceNumber: true,
        vendorInvoiceDate: true,
        vendorInvoiceTotalMinor: true,
        invoiceApprovedAt: true,
        invoiceApprovedById: true,
      },
    }),
    prisma.organization.findMany({ select: { id: true, name: true } }),
  ]);

  const orderById = new Map(orders.map((o) => [o.id, o]));
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const sectionOf = new Map(sections.map((s) => [`${s.orderId}::${s.vendor.toLowerCase()}`, s]));
  const approverIds = [
    ...new Set(sections.map((s) => s.invoiceApprovedById).filter(Boolean) as string[]),
  ];
  const users = approverIds.length
    ? await prisma.user.findMany({
        where: { id: { in: approverIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  // One row per (order, vendor): the invoice is a per-vendor document.
  const groups = new Map<string, { orderId: string; vendor: string; lines: typeof lines }>();
  for (const l of lines) {
    const vendor = (l.vendor && l.vendor.trim()) || 'Unassigned vendor';
    const key = `${l.orderId}::${vendor}`;
    const g = groups.get(key) ?? { orderId: l.orderId, vendor, lines: [] as typeof lines };
    g.lines.push(l);
    groups.set(key, g);
  }

  const rows = [...groups.values()]
    .map((g) => {
      const totals = summarize(g.lines);
      const sec = sectionOf.get(`${g.orderId}::${g.vendor.toLowerCase()}`);
      const order = orderById.get(g.orderId);
      return {
        orderId: g.orderId,
        number: order?.number ?? '',
        jobName: order?.jobName ?? '',
        customer: order ? (orgName.get(order.organizationId) ?? '') : '',
        vendor: g.vendor,
        invoiceNumber: sec?.vendorInvoiceNumber ?? null,
        invoiceDate: sec?.vendorInvoiceDate ?? null,
        statedTotalMinor: sec?.vendorInvoiceTotalMinor ?? null,
        accepted: !!sec?.invoiceApprovedAt,
        acceptedAt: sec?.invoiceApprovedAt ?? null,
        acceptedBy: sec?.invoiceApprovedById
          ? (nameById.get(sec.invoiceApprovedById) ?? null)
          : null,
        ...totals,
        lines: lineVariances(g.lines)
          .filter((v) => (v.extendedDeltaMinor ?? 0) !== 0 || v.notBilled)
          .sort(
            (a, b) => Math.abs(b.extendedDeltaMinor ?? 0) - Math.abs(a.extendedDeltaMinor ?? 0),
          ),
      };
    })
    // A vendor who billed exactly the sheet but missed a line is still a finding.
    .filter((r) => r.varianceMinor !== 0 || r.notBilledLines > 0)
    .sort((a, b) => Math.abs(b.varianceMinor) - Math.abs(a.varianceMinor));

  return {
    rows,
    summary: {
      vendorCount: new Set(rows.map((r) => r.vendor)).size,
      orderCount: new Set(rows.map((r) => r.orderId)).size,
      notBilledLines: rows.reduce((a, r) => a + r.notBilledLines, 0),
      notBilledMinor: rows.reduce((a, r) => a + r.notBilledMinor, 0),
      overchargedMinor: rows.reduce((a, r) => a + Math.max(0, r.varianceMinor), 0),
      underchargedMinor: rows.reduce((a, r) => a + Math.min(0, r.varianceMinor), 0),
      netMinor: rows.reduce((a, r) => a + r.varianceMinor, 0),
      openCount: rows.filter((r) => !r.accepted).length,
    },
  };
}

/**
 * What this order actually cost, once the invoices are in.
 *
 * The Bill of Materials figure is what was AGREED — it is the document the vendor was
 * sent and it never changes. This is what was BILLED, which is what the job really cost.
 * Kept internal by design: it moves margin reporting, and nothing about it reaches the
 * customer, QuickBooks or any document.
 *
 * Per line, in order of what is known:
 *   an accepted invoiced figure   -> that, it is what was charged
 *   marked not billed             -> nothing, they did not charge for it
 *   anything else                 -> the agreed cost, the best figure available
 *
 * Only ACCEPTED invoices move the number. An invoice sitting in dispute is a claim, and
 * a claim is not a cost.
 */
export interface ActualCost {
  agreedMinor: number;
  actualMinor: number;
  /** actual - agreed. Positive means the job cost more than the sheet said. */
  varianceMinor: number;
  /** Lines whose figure came from an accepted invoice. */
  fromInvoiceLines: number;
  /** Vendors whose invoice is entered but not yet accepted. */
  pendingVendors: string[];
}

export async function actualCostForOrder(orderId: string): Promise<ActualCost> {
  const [lines, sections] = await Promise.all([
    prisma.procurementLine.findMany({
      where: { orderId },
      select: {
        vendor: true,
        quantity: true,
        unitCostMinor: true,
        invoicedUnitCostMinor: true,
        invoiceNotBilled: true,
      },
    }),
    prisma.bomVendorSection.findMany({
      where: { orderId },
      select: { vendor: true, invoiceApprovedAt: true, vendorInvoiceNumber: true },
    }),
  ]);
  const accepted = new Set(
    sections.filter((s) => s.invoiceApprovedAt).map((s) => s.vendor.toLowerCase()),
  );
  const pendingVendors = sections
    .filter((s) => !s.invoiceApprovedAt && s.vendorInvoiceNumber)
    .map((s) => s.vendor);

  let agreedMinor = 0;
  let actualMinor = 0;
  let fromInvoiceLines = 0;
  for (const l of lines) {
    const qty = num(l.quantity);
    const agreed = num(l.unitCostMinor) * qty;
    agreedMinor += agreed;
    const vendorAccepted = accepted.has(
      ((l.vendor && l.vendor.trim()) || 'Unassigned vendor').toLowerCase(),
    );
    if (!vendorAccepted) {
      actualMinor += agreed;
      continue;
    }
    if (l.invoiceNotBilled) {
      fromInvoiceLines += 1;
      continue;
    }
    if (l.invoicedUnitCostMinor != null) {
      fromInvoiceLines += 1;
      actualMinor += num(l.invoicedUnitCostMinor) * qty;
      continue;
    }
    actualMinor += agreed;
  }
  return {
    agreedMinor,
    actualMinor,
    varianceMinor: actualMinor - agreedMinor,
    fromInvoiceLines,
    pendingVendors,
  };
}
