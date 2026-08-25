import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { invoiceVarianceReport } from '../handoff/vendorInvoice.js';
import {
  buildReport,
  versionTotals,
  type AnalyticsProposal,
  type Status,
} from '../proposals/analytics.js';

/**
 * Company-wide proposal reporting. One aggregate endpoint: the client renders
 * every report view (conversion, aging, pipeline, win/loss, product demand)
 * from a single payload so the numbers can never disagree between tabs.
 */
export function registerReportRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };

  /**
   * Vendor invoice variance: every vendor invoice that disagrees with the sheet it
   * was checked against, across every project, biggest money first. Accepted ones stay
   * listed and marked — an accepted overcharge is still a fact about that vendor, and
   * the pattern only shows up if it keeps being counted.
   */
  app.get('/reports/invoice-variance', read, async () => invoiceVarianceReport());

  /**
   * Cost drift: every order line whose cost no longer matches the catalog.
   *
   * Costs are snapshotted onto an order at acceptance and never re-read, which is
   * what keeps an already-sent sheet honest. The cost of that rule is that a catalog
   * correction never reaches the jobs already in flight, and nothing said so. This is
   * that list — one row per order, with the lines behind it — so a drifted job is
   * found before its Bill of Materials goes to a vendor rather than after.
   *
   * Read-only. Repricing stays where it was: the order's own "Refresh costs from
   * catalog", which is per-line and audited.
   */
  app.get('/reports/cost-drift', read, async () => {
    const [lines, skus, orders, sections] = await Promise.all([
      prisma.procurementLine.findMany({
        select: {
          id: true,
          orderId: true,
          sku: true,
          name: true,
          vendor: true,
          quantity: true,
          unitCostMinor: true,
          freeIssue: true,
        },
      }),
      prisma.sku.findMany({ select: { part: true, unitCostMinor: true } }),
      prisma.acceptedOrder.findMany({
        select: {
          id: true,
          number: true,
          status: true,
          organizationId: true,
          jobName: true,
          createdAt: true,
        },
      }),
      prisma.bomVendorSection.findMany({ select: { orderId: true, vendor: true, status: true } }),
    ]);

    const catalog = new Map(skus.map((k) => [k.part.trim().toUpperCase(), k.unitCostMinor ?? 0]));
    const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const orderById = new Map(orders.map((o) => [o.id, o]));
    // A submitted section is a document the vendor already holds; its lines are
    // reported but flagged, because repricing one means unlocking that sheet.
    const submitted = new Set(
      sections.filter((s) => s.status === 'SUBMITTED').map((s) => `${s.orderId}::${s.vendor}`),
    );

    interface DriftLine {
      lineId: string;
      sku: string;
      name: string;
      vendor: string;
      quantity: number;
      currentMinor: number;
      catalogMinor: number;
      deltaMinor: number;
      extendedDeltaMinor: number;
      freeIssue: boolean;
      locked: boolean;
    }
    const byOrder = new Map<string, DriftLine[]>();

    for (const l of lines) {
      const sku = (l.sku ?? '').trim();
      if (!sku) continue;
      const catalogMinor = catalog.get(sku.toUpperCase());
      if (catalogMinor == null) continue;
      const current = Number(l.unitCostMinor ?? 0);
      if (catalogMinor === current) continue;
      const vendor = (l.vendor && l.vendor.trim()) || 'Unassigned vendor';
      const qty = Number(l.quantity) || 0;
      const list = byOrder.get(l.orderId) ?? [];
      list.push({
        lineId: l.id,
        sku,
        name: l.name,
        vendor,
        quantity: qty,
        currentMinor: current,
        catalogMinor,
        deltaMinor: catalogMinor - current,
        extendedDeltaMinor: (catalogMinor - current) * qty,
        freeIssue: !!l.freeIssue,
        locked: submitted.has(`${l.orderId}::${vendor}`),
      });
      byOrder.set(l.orderId, list);
    }

    const rows = [...byOrder.entries()]
      .map(([orderId, driftLines]) => {
        const o = orderById.get(orderId);
        return {
          orderId,
          number: o?.number ?? '',
          status: o?.status ?? '',
          jobName: o?.jobName ?? '',
          customer: o ? (orgName.get(o.organizationId) ?? '') : '',
          acceptedAt: o?.createdAt ?? null,
          lineCount: driftLines.length,
          lockedCount: driftLines.filter((l) => l.locked).length,
          netMinor: driftLines.reduce((a, l) => a + l.extendedDeltaMinor, 0),
          lines: driftLines.sort(
            (a, b) => Math.abs(b.extendedDeltaMinor) - Math.abs(a.extendedDeltaMinor),
          ),
        };
      })
      // Biggest money first: that is the order someone would work the list in.
      .sort((a, b) => Math.abs(b.netMinor) - Math.abs(a.netMinor));

    return {
      orders: rows,
      summary: {
        orderCount: rows.length,
        lineCount: rows.reduce((a, r) => a + r.lineCount, 0),
        netMinor: rows.reduce((a, r) => a + r.netMinor, 0),
        lockedCount: rows.reduce((a, r) => a + r.lockedCount, 0),
      },
    };
  });

  app.get('/reports/proposals', read, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const from = q.from ? new Date(q.from) : null;
    const to = q.to ? new Date(q.to + (q.to.length <= 10 ? 'T23:59:59.999Z' : '')) : null;

    const [proposals, orgs, users] = await Promise.all([
      prisma.proposal.findMany({
        orderBy: { updatedAt: 'desc' },
        include: {
          versions: {
            orderBy: { version: 'desc' },
            include: { statusHistory: { orderBy: { createdAt: 'desc' } } },
          },
        },
      }),
      prisma.organization.findMany({ select: { id: true, name: true, customerType: true } }),
      prisma.user.findMany({ select: { id: true, name: true, email: true } }),
    ]);

    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const userById = new Map(users.map((u) => [u.id, u.name || u.email]));

    const DECIDED: Status[] = ['ACCEPTED', 'REJECTED', 'EXPIRED'];
    // Archived proposals are out of every figure below: they were withdrawn, not lost,
    // and counting them as losses understates the win rate. They come back at the end as
    // their own line so the number is visible rather than silently missing.
    const archived = proposals.filter((p) => p.archivedAt && p.versions.length > 0);
    const shaped: AnalyticsProposal[] = proposals
      .filter((p) => !p.archivedAt && p.versions.length > 0)
      .map((p) => {
        const v = p.versions[0]!;
        const decision = v.statusHistory.find((e) => DECIDED.includes(e.toStatus as Status));
        const org = orgById.get(p.organizationId);
        return {
          id: p.id,
          number: p.number,
          title: p.title,
          organizationId: p.organizationId,
          organizationName: org?.name ?? null,
          customerType: org?.customerType ?? null,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          createdById: p.createdById,
          preparedBy: userById.get(p.createdById) ?? null,
          versionCount: p.versions.length,
          latest: {
            id: v.id,
            version: v.version,
            status: v.status as Status,
            sections: v.sections,
            items: v.items,
            expirationDate: v.expirationDate,
            releasedAt: v.releasedAt,
            createdAt: v.createdAt,
            updatedAt: v.updatedAt,
            createdById: v.createdById,
            decidedAt: decision?.createdAt ?? null,
          },
        };
      });

    const report = buildReport(shaped, { from, to });
    report.summary.archivedCount = archived.length;
    report.summary.archivedValue = archived.reduce((sum, p) => {
      const v = p.versions[0]!;
      return sum + versionTotals(v.items, v.sections).total;
    }, 0);
    return report;
  });
}
