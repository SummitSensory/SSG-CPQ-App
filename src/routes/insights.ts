/**
 * Insights: the signed-deals chart, the report builder, saved reports, and goals.
 *
 * Everything here reads. The only writes are the report definitions and goals
 * somebody types in — nothing in this file can change a proposal, an order, a
 * document or an integration, which is why the read endpoints sit on PROPOSAL_READ
 * rather than on a new permission. Saved-report writes need INSIGHTS_WRITE, because a
 * saved report can carry an email schedule; goals need GOALS_MANAGE.
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
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { can, type Role } from '../authz/rbac.js';
import { recordAudit } from '../lib/audit.js';
import { buildDataset } from '../reporting/dataset.js';
import { runReport, reportVocabulary, type ReportDefinition } from '../reporting/query.js';
import { signedDeals } from '../reporting/signedDeals.js';
import { businessToday } from '../lib/businessTime.js';
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

/**
 * Who may act on any saved report regardless of who owns it — choose another user's
 * mailbox to send from, re-point someone else's schedule. USERS_MANAGE, i.e. a
 * system admin: sending as someone else is an act on that person's account.
 */
function isReportAdmin(role: Role): boolean {
  return can(role, Permission.USERS_MANAGE);
}

/**
 * The mailbox a scheduled report sends from. Only the caller's own, unless the caller
 * is an admin: the cron sends from that user's connected Outlook, so naming someone
 * else would put mail in their Sent folder, under their name, that they never wrote.
 */
function checkSendAs(sendAsId: string | null, user: { sub: string; role: Role }): void {
  if (sendAsId && sendAsId !== user.sub && !isReportAdmin(user.role)) {
    throw new ForbiddenError('A scheduled report can only be sent from your own mailbox.');
  }
}

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
  // Saving, editing and deleting report definitions (and their email schedule).
  const write = { preHandler: requirePermission(Permission.INSIGHTS_WRITE) };

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

  app.post('/insights/reports', write, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sendAsId = str(b.sendAsId) ?? req.user!.sub;
    checkSendAs(sendAsId, req.user!);
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
        sendAsId,
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

  app.patch('/insights/reports/:id', write, async (req) => {
    const id = (req.params as { id: string }).id;
    const existing = await prisma.savedReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Report not found');
    const owner = existing.createdById === req.user!.sub || isReportAdmin(req.user!.role);
    // A shared report's name, description and definition can be edited by anyone who
    // can write reports; a private one only by its owner. Anything stricter and a
    // rep's saved view becomes a ticket.
    if (!existing.shared && !owner) {
      throw new NotFoundError('Report not found');
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    // Where it goes, how often, from whose mailbox, and who can see it are the
    // owner's (or an admin's) to change. Otherwise anyone could re-point a shared
    // scheduled report at an outside address and have it sent from its owner's
    // mailbox. Changing WHAT a scheduled report contains is the same act — it
    // changes what lands in those recipients' inboxes — so that is held back too.
    if (!owner) {
      const scheduleFields = ['cadence', 'scheduleDay', 'recipients', 'sendAsId', 'shared'];
      if (scheduleFields.some((k) => b[k] !== undefined)) {
        throw new ForbiddenError(
          'Only the person who saved this report can change its schedule, recipients or sharing.',
        );
      }
      if (existing.cadence !== 'NONE' && b.definition !== undefined) {
        throw new ForbiddenError(
          'This report is emailed on a schedule, so only the person who saved it can change what it contains.',
        );
      }
    }
    if (b.sendAsId !== undefined) checkSendAs(str(b.sendAsId), req.user!);
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

  app.delete('/insights/reports/:id', write, async (req) => {
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
    // Same visibility as the list: someone else's private report does not exist.
    if (!row.shared && row.createdById !== req.user!.sub && !isReportAdmin(req.user!.role)) {
      throw new NotFoundError('Report not found');
    }
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

  /**
   * A goal's fields from a request body, validated the same way for create and edit.
   *
   * On edit (`existing` given) a field the body leaves out keeps its saved value; one
   * it sends is validated as on create. Only the target that belongs to the metric is
   * read — a revenue goal has no count target and a count goal no dollar target — so
   * a client sending `targetMinor: 0` beside a count target cannot zero anything.
   */
  async function resolveGoal(
    b: Record<string, unknown>,
    existing: {
      name: string;
      metric: string;
      period: string;
      periodStart: Date;
      targetMinor: bigint;
      targetCount: number | null;
      ownerId: string | null;
      skuMatch: string | null;
      savedReportId: string | null;
    } | null,
  ): Promise<{
    name: string;
    metric: GoalMetric;
    period: GoalPeriod;
    periodStart: Date;
    targetMinor: number;
    targetCount: number | null;
    ownerId: string | null;
    skuMatch: string | null;
    savedReportId: string | null;
  }> {
    const has = (k: string): boolean => b[k] !== undefined;
    const name = has('name') || !existing ? str(b.name) : existing.name;
    if (!name) throw new ValidationError('Give the goal a name.');

    let metric: GoalMetric;
    if (has('metric') && b.metric !== null) {
      if (!METRICS.includes(String(b.metric) as GoalMetric))
        throw new ValidationError('That is not a goal metric.');
      metric = String(b.metric) as GoalMetric;
    } else metric = existing ? (existing.metric as GoalMetric) : 'REVENUE';

    let period: GoalPeriod;
    if (has('period') && b.period !== null) {
      if (!PERIODS.includes(String(b.period) as GoalPeriod))
        throw new ValidationError('That is not a goal period.');
      period = String(b.period) as GoalPeriod;
    } else period = existing ? (existing.period as GoalPeriod) : 'MONTH';

    const startRaw = str(b.periodStart);
    // Default: the period containing Summit's today (America/Denver), not UTC's — a
    // goal set at 7 pm Mountain on the 31st is for this month, not next.
    const periodStart = startRaw
      ? new Date(`${startRaw.slice(0, 10)}T00:00:00Z`)
      : existing
        ? existing.periodStart
        : new Date(`${businessToday()}T00:00:00Z`);
    if (Number.isNaN(periodStart.getTime()))
      throw new ValidationError('That period start is not a date.');

    function pick<T>(key: string, fallback: T | null, read: (v: unknown) => T | null): T | null {
      return has(key) || !existing ? read(b[key]) : fallback;
    }

    const targetMinor =
      metric === 'REVENUE'
        ? Math.round(pick('targetMinor', existing ? Number(existing.targetMinor) : null, num) ?? 0)
        : 0;
    const targetCount =
      metric === 'REVENUE'
        ? null
        : Math.round(pick('targetCount', existing?.targetCount ?? null, num) ?? 0);
    if (metric === 'REVENUE' && targetMinor <= 0)
      throw new ValidationError('Set a dollar target above zero.');
    if (metric !== 'REVENUE' && !(targetCount && targetCount > 0))
      throw new ValidationError('Set a target above zero.');

    const skuMatch = pick('skuMatch', existing?.skuMatch ?? null, str);
    const savedReportId = pick('savedReportId', existing?.savedReportId ?? null, str);
    if (metric === 'PRODUCT_UNITS' && !skuMatch) {
      throw new ValidationError(
        'Say which part the units goal counts — a part number or a fragment of one.',
      );
    }
    if (metric === 'SAVED_REPORT') {
      if (!savedReportId) throw new ValidationError('Pick the saved report this goal reads.');
      const report = await prisma.savedReport.findUnique({
        where: { id: savedReportId },
        select: { id: true },
      });
      if (!report) throw new ValidationError('That saved report no longer exists.');
    }

    return {
      name,
      metric,
      period,
      periodStart,
      targetMinor,
      targetCount,
      ownerId: pick('ownerId', existing?.ownerId ?? null, str),
      // A field that does not apply to the metric is cleared, not left to linger.
      skuMatch: metric === 'PRODUCT_UNITS' ? skuMatch : null,
      savedReportId: metric === 'SAVED_REPORT' ? savedReportId : null,
    };
  }

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
    const g = await resolveGoal(b, null);
    const { name, metric, period, targetMinor, targetCount } = g;

    const created = await prisma.salesGoal.create({
      data: { ...g, targetMinor: BigInt(g.targetMinor), createdById: req.user!.sub },
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
    // The edit form sends metric, period and saved report as well as the target. They
    // were silently ignored here, so switching a revenue goal to a deal count said
    // "saved" and kept REVENUE. The merged goal now passes exactly the checks a new
    // one does.
    const g = await resolveGoal(b, existing);
    const updated = await prisma.salesGoal.update({
      where: { id },
      data: {
        ...g,
        targetMinor: BigInt(g.targetMinor),
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
