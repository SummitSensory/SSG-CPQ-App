import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { buildReport, type AnalyticsProposal, type Status } from '../proposals/analytics.js';

/**
 * Company-wide proposal reporting. One aggregate endpoint: the client renders
 * every report view (conversion, aging, pipeline, win/loss, product demand)
 * from a single payload so the numbers can never disagree between tabs.
 */
export function registerReportRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };

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
    const shaped: AnalyticsProposal[] = proposals
      .filter((p) => p.versions.length > 0)
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

    return buildReport(shaped, { from, to });
  });
}
