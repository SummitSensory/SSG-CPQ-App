import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';

/**
 * The change history for one record, or for one area of the system.
 *
 * Every screen in this application already writes an audit row on every change. What
 * was missing was anywhere to READ them: the only reader was Administration's global
 * list, capped at the most recent 200 rows across the whole system, so a category
 * renamed last month was recorded and effectively unfindable. That is why the audit
 * trail felt as though it did not exist.
 *
 * Two sources are merged here, because they answer different questions:
 *
 *   AuditLog        who did what, when — everywhere, always.
 *   EntityRevision  what the value was BEFORE — kept only where the previous value
 *                   is worth having (catalog pricing, bundle components).
 *
 * Merged rather than shown separately: to the person reading it, both are just
 * "what happened to this part", and making them choose a tab first is an interface
 * asking the reader to know how it was implemented.
 */

/** Which audit actions belong to which screen, so a tab can ask for its own history. */
const AREA_PREFIXES: Record<string, string[]> = {
  catalog: ['catalog.product', 'catalog.item', 'catalog.import', 'sku.'],
  tree: ['catalog.category', 'catalog.family', 'catalog.tree', 'catalog.product.reorder'],
  manufacturers: ['manufacturer.', 'vendorColor.', 'powder.'],
  bundles: ['catalog.bundle'],
  bom: ['bom.', 'handoff.'],
  notes: ['note.', 'standardNote.', 'introTemplate.', 'legalDocument.'],
  formulas: ['formula.'],
  crossborder: ['crossborder.'],
};

interface Row {
  id: string;
  source: 'audit' | 'revision';
  action: string;
  entity: string | null;
  entityId: string | null;
  label: string | null;
  actorId: string;
  actorName: string | null;
  createdAt: Date;
  details: unknown;
  before: unknown;
  after: unknown;
  changed: string[];
}

export function registerHistoryRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.HISTORY_READ) };

  /**
   * GET /history?entity=Sku&entityId=6820H-LP
   * GET /history?area=catalog&limit=200
   * GET /history?q=goldberg
   *
   * `entity`+`entityId` is the per-record history behind a History button. `area` is
   * the whole screen's history. `q` matches the label, the action or the actor.
   */
  app.get('/history', read, async (req) => {
    const q = req.query as {
      entity?: string;
      entityId?: string;
      area?: string;
      q?: string;
      limit?: string;
    };
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000);
    const term = (q.q ?? '').trim().toLowerCase();

    const auditWhere: Record<string, unknown> = {};
    const revWhere: Record<string, unknown> = {};
    if (q.entity) {
      auditWhere.entity = q.entity;
      revWhere.entity = q.entity;
    }
    if (q.entityId) {
      auditWhere.entityId = q.entityId;
      revWhere.entityId = q.entityId;
    }
    // An area is a set of action prefixes. Postgres has no "starts with any of", so
    // this is an OR of startsWith — short lists, and it keeps the index usable.
    const prefixes = q.area ? (AREA_PREFIXES[q.area] ?? []) : [];
    if (prefixes.length) {
      auditWhere.OR = prefixes.map((p) => ({ action: { startsWith: p } }));
    }

    const [audits, revisions] = await Promise.all([
      prisma.auditLog.findMany({
        where: auditWhere,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      // Revisions only exist for a few entities, so an area query that names none of
      // them simply returns nothing rather than scanning the table.
      q.area && !['catalog', 'bundles'].includes(q.area)
        ? Promise.resolve([])
        : prisma.entityRevision.findMany({
            where: revWhere,
            orderBy: { createdAt: 'desc' },
            take: limit,
          }),
    ]);

    const actorIds = [
      ...new Set([...audits.map((a) => a.actorId), ...revisions.map((r) => r.actorId)]),
    ].filter(Boolean);
    const users = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.name || u.email]));

    const rows: Row[] = [
      ...audits.map((a) => ({
        id: a.id,
        source: 'audit' as const,
        action: a.action,
        entity: a.entity,
        entityId: a.entityId,
        label: null,
        actorId: a.actorId,
        actorName: nameById.get(a.actorId) ?? null,
        createdAt: a.createdAt,
        details: a.details ?? null,
        before: null,
        after: null,
        changed: [],
      })),
      ...revisions.map((r) => ({
        id: r.id,
        source: 'revision' as const,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        label: r.label,
        actorId: r.actorId,
        actorName: nameById.get(r.actorId) ?? null,
        createdAt: r.createdAt,
        details: null,
        before: r.before ?? null,
        after: r.after ?? null,
        changed: Array.isArray(r.changed) ? (r.changed as string[]) : [],
      })),
    ]
      .filter((row) => {
        if (!term) return true;
        const hay = [
          row.action,
          row.label,
          row.actorName,
          row.entityId,
          JSON.stringify(row.details ?? ''),
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(term);
      })
      .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
      .slice(0, limit);

    return { rows, areas: Object.keys(AREA_PREFIXES) };
  });
}
