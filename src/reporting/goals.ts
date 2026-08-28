/**
 * Goals: a target, a period, and how full the glass is.
 *
 * Progress is measured against ACCEPTED proposals dated by their acceptance — the
 * moment the customer said yes. That was a deliberate choice over invoiced or
 * collected dollars: a sales goal is about closing, and tying it to QuickBooks would
 * make a rep's number move when accounting raises a document. Payment milestones are
 * still in the dataset and the signed-deals chart shows them, so the cash view is a
 * chart away.
 *
 * Pace is included because a bare percentage answers the wrong question in the middle
 * of a month. 40% on the tenth of a thirty-day month is ahead; on the twenty-eighth it
 * is not, and the glass says so.
 */
import type { Dataset } from './dataset.js';
import { runReport, type ReportDefinition } from './query.js';

export type GoalMetric = 'REVENUE' | 'DEAL_COUNT' | 'PRODUCT_UNITS' | 'SAVED_REPORT';
export type GoalPeriod = 'MONTH' | 'QUARTER' | 'YEAR';

export interface GoalInput {
  id: string;
  name: string;
  metric: GoalMetric;
  period: GoalPeriod;
  periodStart: Date;
  targetMinor: number;
  targetCount: number | null;
  ownerId: string | null;
  ownerName?: string | null;
  skuMatch: string | null;
  savedReportId: string | null;
  savedReportDefinition?: ReportDefinition | null;
  active: boolean;
}

export interface GoalProgress {
  id: string;
  name: string;
  metric: GoalMetric;
  period: GoalPeriod;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  ownerId: string | null;
  ownerName: string | null;
  skuMatch: string | null;
  savedReportId: string | null;
  /** Money in minor units for REVENUE, otherwise a plain count. */
  target: number;
  actual: number;
  unit: 'money' | 'count';
  /** 0–1, uncapped in `ratio` and capped in `fill` for drawing. */
  ratio: number;
  fill: number;
  remaining: number;
  /** Where the goal should be by now if it were tracking evenly. */
  paceTarget: number;
  /** actual − paceTarget. Positive is ahead. */
  paceDelta: number;
  elapsedFraction: number;
  daysLeft: number;
  hit: boolean;
  /** The deals that made up the figure, newest first. Empty for SAVED_REPORT. */
  contributors: {
    proposalId: string;
    number: string;
    customer: string;
    at: string;
    amountMinor: number;
    units: number;
  }[];
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function periodBounds(
  period: GoalPeriod,
  start: Date,
): { from: Date; to: Date; label: string } {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  if (period === 'MONTH') {
    return {
      from: new Date(Date.UTC(y, m, 1)),
      to: new Date(Date.UTC(y, m + 1, 1) - 1),
      label: `${MONTHS[m]} ${y}`,
    };
  }
  if (period === 'QUARTER') {
    const q0 = Math.floor(m / 3) * 3;
    return {
      from: new Date(Date.UTC(y, q0, 1)),
      to: new Date(Date.UTC(y, q0 + 3, 1) - 1),
      label: `Q${Math.floor(q0 / 3) + 1} ${y}`,
    };
  }
  return {
    from: new Date(Date.UTC(y, 0, 1)),
    to: new Date(Date.UTC(y + 1, 0, 1) - 1),
    label: String(y),
  };
}

const DAY = 86_400_000;

export function goalProgress(data: Dataset, goal: GoalInput, now = new Date()): GoalProgress {
  const { from, to, label } = periodBounds(goal.period, goal.periodStart);
  const span = Math.max(1, to.getTime() - from.getTime());
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - from.getTime()) / span));
  const unit: 'money' | 'count' = goal.metric === 'REVENUE' ? 'money' : 'count';
  const target =
    goal.metric === 'REVENUE' ? Number(goal.targetMinor) || 0 : Number(goal.targetCount) || 0;

  let actual = 0;
  const contributors: GoalProgress['contributors'] = [];

  if (goal.metric === 'SAVED_REPORT') {
    // Any saved report can be a goal: the first numeric total is the figure. The
    // report's own date filter is replaced by the goal's period, so "units of X" set
    // as a monthly goal measures the month rather than whatever window the report
    // was saved with.
    const def = goal.savedReportDefinition;
    if (def) {
      const res = runReport(data, {
        ...def,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
      });
      const first = res.definition.measures[0];
      actual = first ? Number(res.totals[first]) || 0 : 0;
    }
  } else {
    for (const f of data.facts) {
      if (!f.acceptedAt) continue;
      const t = new Date(f.acceptedAt).getTime();
      if (t < from.getTime() || t > to.getTime()) continue;
      if (goal.ownerId && f.repId !== goal.ownerId) continue;

      if (goal.metric === 'REVENUE') {
        actual += f.totalMinor;
        contributors.push({
          proposalId: f.proposalId,
          number: f.number,
          customer: f.customer,
          at: f.acceptedAt,
          amountMinor: f.totalMinor,
          units: 0,
        });
      } else if (goal.metric === 'DEAL_COUNT') {
        actual += 1;
        contributors.push({
          proposalId: f.proposalId,
          number: f.number,
          customer: f.customer,
          at: f.acceptedAt,
          amountMinor: f.totalMinor,
          units: 0,
        });
      } else {
        // PRODUCT_UNITS. The match is a fragment, so "SOAR" counts the series and
        // "K-4002" counts one part. Optional lines are excluded: nobody bought them.
        const needle = (goal.skuMatch ?? '').trim().toLowerCase();
        if (!needle) continue;
        let units = 0;
        let amount = 0;
        for (const l of f.lines) {
          if (l.optional) continue;
          if (!`${l.sku} ${l.name}`.toLowerCase().includes(needle)) continue;
          units += l.qty;
          amount += l.amountMinor;
        }
        if (!units) continue;
        actual += units;
        contributors.push({
          proposalId: f.proposalId,
          number: f.number,
          customer: f.customer,
          at: f.acceptedAt,
          amountMinor: amount,
          units,
        });
      }
    }
  }

  contributors.sort((a, b) => b.at.localeCompare(a.at));
  const ratio = target > 0 ? actual / target : 0;
  const paceTarget = Math.round(target * elapsed);

  return {
    id: goal.id,
    name: goal.name,
    metric: goal.metric,
    period: goal.period,
    periodStart: from.toISOString(),
    periodEnd: to.toISOString(),
    periodLabel: label,
    ownerId: goal.ownerId,
    ownerName: goal.ownerName ?? null,
    skuMatch: goal.skuMatch,
    savedReportId: goal.savedReportId,
    target,
    actual: Math.round(actual * 100) / 100,
    unit,
    ratio,
    fill: Math.max(0, Math.min(1, ratio)),
    remaining: Math.max(0, target - actual),
    paceTarget,
    paceDelta: Math.round(actual - paceTarget),
    elapsedFraction: elapsed,
    daysLeft: Math.max(0, Math.ceil((to.getTime() - now.getTime()) / DAY)),
    hit: target > 0 && actual >= target,
    contributors: contributors.slice(0, 50),
  };
}
