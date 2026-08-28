/**
 * Insights: the signed-deals chart, the report builder, saved reports, and goals.
 *
 * Everything here reads. The only writes are the report definitions and goals
 * somebody types in — nothing in this file can change a proposal, an order, a
 * document or an integration, which is why the read endpoints sit on PROPOSAL_READ
 * rather than on a new permission.
 *
 * Server side:
 *   reporting/dataset.ts     one read of the world, cached for a minute
 *   reporting/query.ts       the report engine (pure)
 *   reporting/signedDeals.ts the monthly milestone series (pure)
 *   reporting/goals.ts       target vs actual, with pace (pure)
 *
 * Client side: public/insights.js and public/goals.js, both self-contained.
 */
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { buildDataset } from '../reporting/dataset.js';
import { runReport, reportVocabulary, type ReportDefinition } from '../reporting/query.js';
import { signedDeals } from '../reporting/signedDeals.js';
import {
  goalProgress,
  type GoalInput,
  type GoalMetric,
  type GoalPeriod,
} from '../reporting/goals.js';

/** BigInt-safe JSON. Same reasoning as crossBorder.ts: minor units are integers. */
function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))) as T;
}

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function jsonDefinition(def: ReportDefinition): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(def)) as Prisma.InputJsonObject;
}

const METRICS: GoalMetric[] = ['REVENUE', 'DEAL_COUNT', 'PRODUCT_UNITS', 'SAVED_REPORT'];
const PERIODS: GoalPeriod[] = ['MONTH', 'QUARTER', 'YEAR'];
const CADENCES = ['NONE', 'WEEKLY', 'MONTHLY'] as const;

/**
 * A report definition off the wire.
 *
 * Validated rather than trusted, but leniently: an unknown dimension or measure is
 * dropped, not a 400. The engine is the authority on what exists, and a definition
 * saved by an older build must keep opening after the vocabulary changes.
 */
function parseDefinition(body: unknown): ReportDefinition {
  const b = (body ?? {}) as Record<string, unknown>;
  const vocab = reportVocabulary();
  const dimIds = new Set(vocab.dimensions.map((d) => d.id));
  const measureIds = new Set(vocab.measures.map((m) => m.id));
  const basisIds = new Set(vocab.bases.map((x) => x.id));

  const asArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  const groupBy = asArray(b.groupBy).filter((g) =>
    dimIds.has(g as never),
  ) as ReportDefinition['groupBy'];
  const measures = asArray(b.measures).filter((m) =>
    measureIds.has(m as never),
  ) as ReportDefinition['measures'];
  const basis =
    typeof b.dateBasis === 'string' && basisIds.has(b.dateBasis as never)
      ? (b.dateBasis as ReportDefinition['dateBasis'])
      : 'CREATED';

  const f = (b.filters ?? {}) as Record<string, unknown>;
  const optional = ['ANY', 'INCLUDED_ONLY', 'OPTIONAL_ONLY'].includes(String(f.optional))
    ? (String(f.optional) as 'ANY' | 'INCLUDED_ONLY' | 'OPTIONAL_ONLY')
    : 'ANY';
  const financing = ['ANY', 'FINANCED', 'CASH'].includes(String(f.financing))
    ? (String(f.financing) as 'ANY' | 'FINANCED' | 'CASH')
    : 'ANY';

  const sort = (b.sort ?? null) as { key?: unknown; dir?: unknown } | null;

  return {
    dateBasis: basis,
    from: str(b.from),
    to: str(b.to),
    groupBy: groupBy.length ? groupBy : ['MONTH'],
    measures: measures.length ? measures : ['PROPOSALS', 'PROPOSAL_VALUE'],
    filters: {
      status: asArray(f.status),
      repIds: asArray(f.repIds),
      customerIds: asArray(f.customerIds),
      customerTypes: asArray(f.customerTypes),
      regions: asArray(f.regions),
      countries: asArray(f.countries),
      categories: asArray(f.categories),
      manufacturers: asArray(f.manufacturers),
      proposalGroups: asArray(f.proposalGroups),
      productLike: str(f.productLike) ?? undefined,
      optional,
      financing,
      discountPctMin: num(f.discountPctMin),
      discountPctMax: num(f.discountPctMax),
      marginPctMin: num(f.marginPctMin),
      marginPctMax: num(f.marginPctMax),
    },
    sort:
      sort && typeof sort.key === 'string'
        ? { key: sort.key, dir: sort.dir === 'asc' ? 'asc' : 'desc' }
        : null,
    limit: num(b.limit) ?? 500,
  };
}

export function registerInsightRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const manage = { preHandler: requirePermission(Permission.GOALS_MANAGE) };

  /* ── Vocabulary ─────────────────────────────────────────────────────────── */

  /**
   * What can be grouped, filtered and measured, plus the actual values present in
   * the data (reps, customers, categories). The builder draws its controls from
   * this, so a dimension added to the engine appears on screen without a client
   * change.
   */
  app.get('/insights/vocabulary', read, async () => {
    const data = await buildDataset();
    return {
      ...reportVocabulary(),
      reps: data.reps,
      customers: data.customers,
      categories: data.categories,
      manufacturers: data.manufacturers,
      proposalGroups: data.proposalGroups,
      regions: data.regions,
      statuses: ['DRAFT', 'INTERNAL_REVIEW', 'RELEASED', 'ACCEPTED', 'REJECTED', 'EXPIRED'],
      builtAt: data.builtAt,
    };
  });

  /* ── Signed deals ───────────────────────────────────────────────────────── */

  app.get('/insights/signed-deals', read, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const data = await buildDataset();
    return jsonSafe(signedDeals(data, { from: q.from ?? null, to: q.to ?? null }));
  });

  /* ── Ad-hoc report ──────────────────────────────────────────────────────── */

  /**
   * Run a definition. POST because a report definition is a document, not a query
   * string — the filter set alone would blow past a sane URL length.
   */
  app.post('/insights/query', read, async (req) => {
    const def = parseDefinition(req.body);
    const data = await buildDataset();
    return jsonSafe(runReport(data, def));
  });

  /* ── Saved reports ──────────────────────────────────────────────────────── */

  /**
   * Shared reports, plus the caller's own private ones. A private report is the
   * exception — someone's working draft — so it is filtered here rather than being
   * a permission.
   */
  app.get('/insights/reports', read, async (req) => {
    const me = req.user!.sub;
    const rows = await prisma.savedReport.findMany({
      where: { OR: [{ shared: true }, { createdById: me }] },
      orderBy: { name: 'asc' },
    });
    const users = await prisma.user.findMany({ select: { id: true, name: true, email: true } });
    const byId = new Map(users.map((u) => [u.id, u.name || u.email]));
    return jsonSafe(
      rows.map((r) => ({
        ...r,
        createdByName: byId.get(r.createdById) ?? null,
        sendAsName: r.sendAsId ? (byId.get(r.sendAsId) ?? null) : null,
        mine: r.createdById === me,
      })),
    );
  });

  app.post('/insights/reports', read, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b.name);
    if (!name) throw new ValidationError('Give the report a name.');
    const cadence = CADENCES.includes(String(b.cadence) as never)
      ? (String(b.cadence) as (typeof CADENCES)[number])
      : 'NONE';
    const recipients = str(b.recipients);
    if (cadence !== 'NONE' && !recipients) {
      throw new ValidationError('A scheduled report needs at least one recipient address.');
    }

    const created = await prisma.savedReport.create({
      data: {
        name,
        description: str(b.description),
        definition: jsonDefinition(parseDefinition(b.definition)),
        shared: b.shared === false ? false : true,
        cadence,
        scheduleDay: num(b.scheduleDay),
        recipients,
        // The schedule sends from a real mailbox. Defaults to whoever saved it,
        // because that is the person who can be asked why it arrived.
        sendAsId: str(b.sendAsId) ?? req.user!.sub,
        createdById: req.user!.sub,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'insights.report.create',
      entity: 'SavedReport',
      entityId: created.id,
      details: { name, cadence },
    });
    return jsonSafe(created);
  });

  app.patch('/insights/reports/:id', read, async (req) => {
    const id = (req.params as { id: string }).id;
    const existing = await prisma.savedReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Report not found');
    // A shared report can be edited by anyone who can read reports; a private one
    // only by its owner. Anything stricter and a rep's saved view becomes a ticket.
    if (!existing.shared && existing.createdById !== req.user!.sub) {
      throw new NotFoundError('Report not found');
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cadence = CADENCES.includes(String(b.cadence) as never)
      ? (String(b.cadence) as (typeof CADENCES)[number])
      : existing.cadence;
    const recipients = b.recipients === undefined ? existing.recipients : str(b.recipients);
    if (cadence !== 'NONE' && !recipients) {
      throw new ValidationError('A scheduled report needs at least one recipient address.');
    }
    const updated = await prisma.savedReport.update({
      where: { id },
      data: {
        name: b.name === undefined ? existing.name : (str(b.name) ?? existing.name),
        description: b.description === undefined ? existing.description : str(b.description),
        definition:
          b.definition === undefined
            ? jsonDefinition(parseDefinition(existing.definition))
            : jsonDefinition(parseDefinition(b.definition)),
        shared: b.shared === undefined ? existing.shared : !!b.shared,
        cadence,
        scheduleDay: b.scheduleDay === undefined ? existing.scheduleDay : num(b.scheduleDay),
        recipients,
        sendAsId: b.sendAsId === undefined ? existing.sendAsId : str(b.sendAsId),
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'insights.report.update',
      entity: 'SavedReport',
      entityId: id,
      details: { name: updated.name, cadence: updated.cadence },
    });
    return jsonSafe(updated);
  });

  app.delete('/insights/reports/:id', read, async (req) => {
    const id = (req.params as { id: string }).id;
    const existing = await prisma.savedReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Report not found');
    if (!existing.shared && existing.createdById !== req.user!.sub) {
      throw new NotFoundError('Report not found');
    }
    await prisma.savedReport.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'insights.report.delete',
      entity: 'SavedReport',
      entityId: id,
      details: { name: existing.name },
    });
    return { ok: true };
  });

  /** Run a saved report as saved, optionally over a different window. */
  app.get('/insights/reports/:id/run', read, async (req) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { from?: string; to?: string };
    const row = await prisma.savedReport.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('Report not found');
    const def = parseDefinition(row.definition);
    const data = await buildDataset();
    return jsonSafe(
      runReport(data, {
        ...def,
        from: q.from ?? def.from ?? null,
        to: q.to ?? def.to ?? null,
      }),
    );
  });

  /* ── Goals ──────────────────────────────────────────────────────────────── */

  async function goalInputs(where?: Prisma.SalesGoalWhereInput): Promise<GoalInput[]> {
    const [rows, users] = await Promise.all([
      prisma.salesGoal.findMany({
        where,
        orderBy: [{ periodStart: 'desc' }, { name: 'asc' }],
        include: { savedReport: { select: { definition: true } } },
      }),
      prisma.user.findMany({ select: { id: true, name: true, email: true } }),
    ]);
    const byId = new Map(users.map((u) => [u.id, u.name || u.email]));
    return rows.map((g) => ({
      id: g.id,
      name: g.name,
      metric: g.metric as GoalMetric,
      period: g.period as GoalPeriod,
      periodStart: g.periodStart,
      targetMinor: Number(g.targetMinor),
      targetCount: g.targetCount,
      ownerId: g.ownerId,
      ownerName: g.ownerId ? (byId.get(g.ownerId) ?? null) : null,
      skuMatch: g.skuMatch,
      savedReportId: g.savedReportId,
      savedReportDefinition: g.savedReport ? parseDefinition(g.savedReport.definition) : null,
      active: g.active,
    }));
  }

  /**
   * Every active goal with its progress. One dataset read for all of them, which is
   * why this is a single endpoint rather than one call per glass.
   */
  app.get('/insights/goals', read, async (req) => {
    const q = req.query as { all?: string };
    const goals = await goalInputs(q.all ? undefined : { active: true });
    const data = await buildDataset();
    const now = new Date();
    return jsonSafe({
      goals: goals.map((g) => ({ ...goalProgress(data, g, now), active: g.active })),
      generatedAt: now.toISOString(),
    });
  });

  app.post('/insights/goals', manage, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b.name);
    if (!name) throw new ValidationError('Give the goal a name.');
    const metric = METRICS.includes(String(b.metric) as GoalMetric)
      ? (String(b.metric) as GoalMetric)
      : 'REVENUE';
    const period = PERIODS.includes(String(b.period) as GoalPeriod)
      ? (String(b.period) as GoalPeriod)
      : 'MONTH';
    const startRaw = str(b.periodStart);
    const periodStart = startRaw ? new Date(`${startRaw.slice(0, 10)}T00:00:00Z`) : new Date();
    if (Number.isNaN(periodStart.getTime()))
      throw new ValidationError('That period start is not a date.');

    const targetMinor = metric === 'REVENUE' ? Math.round(num(b.targetMinor) ?? 0) : 0;
    const targetCount = metric === 'REVENUE' ? null : Math.round(num(b.targetCount) ?? 0);
    if (metric === 'REVENUE' && targetMinor <= 0)
      throw new ValidationError('Set a dollar target above zero.');
    if (metric !== 'REVENUE' && !targetCount) throw new ValidationError('Set a target above zero.');
    if (metric === 'PRODUCT_UNITS' && !str(b.skuMatch)) {
      throw new ValidationError(
        'Say which part the units goal counts — a part number or a fragment of one.',
      );
    }
    if (metric === 'SAVED_REPORT' && !str(b.savedReportId)) {
      throw new ValidationError('Pick the saved report this goal reads.');
    }

    const created = await prisma.salesGoal.create({
      data: {
        name,
        metric,
        period,
        periodStart,
        targetMinor: BigInt(targetMinor),
        targetCount,
        ownerId: str(b.ownerId),
        skuMatch: str(b.skuMatch),
        savedReportId: str(b.savedReportId),
        createdById: req.user!.sub,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'insights.goal.create',
      entity: 'SalesGoal',
      entityId: created.id,
      details: { name, metric, period, targetMinor, targetCount },
    });
    return jsonSafe(created);
  });

  app.patch('/insights/goals/:id', manage, async (req) => {
    const id = (req.params as { id: string }).id;
    const existing = await prisma.salesGoal.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Goal not found');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const startRaw = str(b.periodStart);
    const updated = await prisma.salesGoal.update({
      where: { id },
      data: {
        name: b.name === undefined ? existing.name : (str(b.name) ?? existing.name),
        targetMinor:
          b.targetMinor === undefined
            ? existing.targetMinor
            : BigInt(Math.max(0, Math.round(num(b.targetMinor) ?? 0))),
        targetCount:
          b.targetCount === undefined ? existing.targetCount : Math.round(num(b.targetCount) ?? 0),
        periodStart: startRaw
          ? new Date(`${startRaw.slice(0, 10)}T00:00:00Z`)
          : existing.periodStart,
        ownerId: b.ownerId === undefined ? existing.ownerId : str(b.ownerId),
        skuMatch: b.skuMatch === undefined ? existing.skuMatch : str(b.skuMatch),
        active: b.active === undefined ? existing.active : !!b.active,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'insights.goal.update',
      entity: 'SalesGoal',
      entityId: id,
      details: { name: updated.name, active: updated.active },
    });
    return jsonSafe(updated);
  });

  app.delete('/insights/goals/:id', manage, async (req) => {
    const id = (req.params as { id: string }).id;
    const existing = await prisma.salesGoal.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Goal not found');
    await prisma.salesGoal.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'insights.goal.delete',
      entity: 'SalesGoal',
      entityId: id,
      details: { name: existing.name },
    });
    return { ok: true };
  });
}
