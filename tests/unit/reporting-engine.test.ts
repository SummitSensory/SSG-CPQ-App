import { describe, it, expect } from 'vitest';
import type { Dataset, Fact, FactLine } from '../../src/reporting/dataset.js';
import { runReport } from '../../src/reporting/query.js';
import { signedDeals } from '../../src/reporting/signedDeals.js';
import { goalProgress, periodBounds, type GoalInput } from '../../src/reporting/goals.js';

/**
 * The reporting engine.
 *
 * Three pure functions, all of which produce numbers people will make decisions with,
 * and one of which (runReport) has a subtlety that will otherwise look like a bug:
 * when a report is grouped by anything per-line, "Proposals" counts the proposals
 * CONTAINING that line and "Proposal value" is the value of those whole proposals, so
 * the column deliberately does not sum to the company total. That behaviour is
 * asserted here so it cannot be "fixed" by accident.
 */

const factDefaults: Fact = {
  proposalId: 'p0',
  number: 'P-0000',
  title: 'Untitled',
  status: 'DRAFT',
  version: 1,
  customerId: 'c0',
  customer: 'Customer',
  customerType: 'SCHOOL',
  region: 'CO',
  country: 'US',
  repId: 'u0',
  rep: 'Rep',
  createdAt: '2026-01-15T00:00:00.000Z',
  releasedAt: null,
  decidedAt: null,
  acceptedAt: null,
  orderedAt: null,
  depositPaidAt: null,
  paidInFullAt: null,
  totalMinor: 0,
  revenueMinor: 0,
  cogsMinor: 0,
  marginMinor: 0,
  marginPct: 0,
  discountPct: 0,
  financed: false,
  lines: [],
};

const lineDefaults: FactLine = {
  sku: 'X-1',
  name: 'Thing',
  category: 'OTHER',
  manufacturer: 'Summit Sensory Gym',
  proposalGroup: 'Unfiled',
  optional: false,
  qty: 1,
  rateMinor: 0,
  amountMinor: 0,
  costMinor: 0,
};

const fact = (over: Partial<Fact>): Fact => ({ ...factDefaults, ...over });
const ln = (over: Partial<FactLine>): FactLine => ({ ...lineDefaults, ...over });

function dataset(facts: Fact[]): Dataset {
  return {
    facts,
    builtAt: '2026-08-28T00:00:00.000Z',
    reps: [],
    customers: [],
    categories: [],
    manufacturers: [],
    proposalGroups: [],
    regions: [],
  };
}

/* ------------------------------------------------------------------ runReport */

describe('runReport — grain', () => {
  const data = dataset([
    fact({
      proposalId: 'p1',
      status: 'ACCEPTED',
      acceptedAt: '2026-03-04T00:00:00.000Z',
      totalMinor: 1_000_000,
      lines: [
        ln({ sku: 'K-4002', name: 'Summit Soar S2', qty: 2, amountMinor: 800_000 }),
        ln({ sku: 'SSM80100', name: 'Soar Floor Mat', qty: 1, amountMinor: 200_000 }),
      ],
    }),
    fact({
      proposalId: 'p2',
      status: 'ACCEPTED',
      acceptedAt: '2026-03-20T00:00:00.000Z',
      totalMinor: 400_000,
      lines: [ln({ sku: 'K-4002', name: 'Summit Soar S2', qty: 1, amountMinor: 400_000 })],
    }),
  ]);

  it('groups per proposal when nothing needs a line', () => {
    const r = runReport(data, {
      dateBasis: 'ACCEPTED',
      groupBy: ['MONTH'],
      measures: ['PROPOSALS', 'PROPOSAL_VALUE'],
    });
    expect(r.meta.grain).toBe('PROPOSAL');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.PROPOSALS).toBe(2);
    expect(r.rows[0]!.PROPOSAL_VALUE).toBe(1_400_000);
  });

  it('switches to line grain when a line dimension is grouped', () => {
    const r = runReport(data, {
      dateBasis: 'ACCEPTED',
      groupBy: ['SKU'],
      measures: ['UNITS', 'LINE_VALUE', 'PROPOSALS'],
    });
    expect(r.meta.grain).toBe('LINE');
    const soar = r.rows.find((x) => x.d0 === 'K-4002')!;
    expect(soar.UNITS).toBe(3);
    expect(soar.LINE_VALUE).toBe(1_200_000);
    expect(soar.PROPOSALS).toBe(2);
  });

  it('switches to line grain on a product filter alone', () => {
    const r = runReport(data, {
      dateBasis: 'ACCEPTED',
      groupBy: ['MONTH'],
      measures: ['UNITS'],
      filters: { productLike: 'soar floor' },
    });
    expect(r.meta.grain).toBe('LINE');
    expect(r.rows[0]!.UNITS).toBe(1);
  });

  it('counts a proposal once per group, not once per line', () => {
    // p1 carries two lines. Grouped by month at line grain, PROPOSALS must still be
    // 2 (p1 and p2), and PROPOSAL_VALUE must not count p1 twice.
    const r = runReport(data, {
      dateBasis: 'ACCEPTED',
      groupBy: ['YEAR'],
      measures: ['PROPOSALS', 'PROPOSAL_VALUE', 'LINES'],
      filters: { productLike: 'soar' },
    });
    expect(r.rows[0]!.PROPOSALS).toBe(2);
    expect(r.rows[0]!.PROPOSAL_VALUE).toBe(1_400_000);
    expect(r.rows[0]!.LINES).toBe(3);
  });

  it('warns when proposal value is shown at line grain', () => {
    const r = runReport(data, {
      dateBasis: 'ACCEPTED',
      groupBy: ['SKU'],
      measures: ['PROPOSAL_VALUE'],
    });
    expect(r.meta.notes.join(' ')).toMatch(/does not sum to the company total/i);
  });
});

describe('runReport — dates and filters', () => {
  const data = dataset([
    fact({ proposalId: 'a', createdAt: '2026-01-05T00:00:00.000Z', totalMinor: 100 }),
    fact({ proposalId: 'b', createdAt: '2026-06-05T00:00:00.000Z', totalMinor: 200 }),
    fact({
      proposalId: 'c',
      createdAt: '2026-06-06T00:00:00.000Z',
      acceptedAt: '2026-07-01T00:00:00.000Z',
      status: 'ACCEPTED',
      totalMinor: 400,
    }),
  ]);

  it('excludes proposals with no date for the chosen milestone', () => {
    // The whole point of the basis: a report on "accepted in July" must not date a
    // never-accepted proposal by something else.
    const r = runReport(data, {
      dateBasis: 'ACCEPTED',
      groupBy: ['MONTH'],
      measures: ['PROPOSALS'],
    });
    expect(r.meta.proposalsMatched).toBe(1);
    expect(r.totals.PROPOSALS).toBe(1);
  });

  it('applies from and to inclusively, by calendar date', () => {
    const r = runReport(data, {
      dateBasis: 'CREATED',
      from: '2026-06-05',
      to: '2026-06-06',
      groupBy: ['MONTH'],
      measures: ['PROPOSALS'],
    });
    expect(r.totals.PROPOSALS).toBe(2);
  });

  it('orders date groupings chronologically and rankings by size', () => {
    const byMonth = runReport(data, {
      dateBasis: 'CREATED',
      groupBy: ['MONTH'],
      measures: ['PROPOSAL_VALUE'],
    });
    expect(byMonth.rows.map((r) => r.d0)).toEqual(['Jan 2026', 'Jun 2026']);

    const byCustomer = runReport(
      dataset([
        fact({ proposalId: 'x', customerId: 'c1', customer: 'Small', totalMinor: 100 }),
        fact({ proposalId: 'y', customerId: 'c2', customer: 'Large', totalMinor: 900 }),
      ]),
      {
        dateBasis: 'CREATED',
        groupBy: ['CUSTOMER'],
        measures: ['PROPOSAL_VALUE'],
      },
    );
    expect(byCustomer.rows[0]!.d0).toBe('Large');
  });
});

describe('runReport — rate measures', () => {
  it('recomputes win rate from components rather than averaging percentages', () => {
    const data = dataset([
      fact({ proposalId: 'w1', status: 'ACCEPTED', repId: 'u1', rep: 'A', totalMinor: 100 }),
      fact({ proposalId: 'w2', status: 'ACCEPTED', repId: 'u1', rep: 'A', totalMinor: 100 }),
      fact({ proposalId: 'l1', status: 'REJECTED', repId: 'u1', rep: 'A', totalMinor: 100 }),
      fact({ proposalId: 'l2', status: 'REJECTED', repId: 'u2', rep: 'B', totalMinor: 100 }),
    ]);
    const r = runReport(data, {
      dateBasis: 'CREATED',
      groupBy: ['REP'],
      measures: ['WIN_RATE'],
    });
    const a = r.rows.find((x) => x.d0 === 'A')!;
    expect(a.WIN_RATE).toBe(66.7);
    // Averaging the two rows' rates would give 33.35. The real figure is 2 of 4.
    expect(r.totals.WIN_RATE).toBe(50);
  });

  it('ignores undecided proposals in the win rate', () => {
    const data = dataset([
      fact({ proposalId: 'd1', status: 'DRAFT' }),
      fact({ proposalId: 'a1', status: 'ACCEPTED' }),
    ]);
    const r = runReport(data, { dateBasis: 'CREATED', groupBy: ['YEAR'], measures: ['WIN_RATE'] });
    expect(r.rows[0]!.WIN_RATE).toBe(100);
  });
});

/* --------------------------------------------------------------- signedDeals */

describe('signedDeals', () => {
  const data = dataset([
    fact({
      proposalId: 's1',
      acceptedAt: '2026-06-10T00:00:00.000Z',
      orderedAt: '2026-06-12T00:00:00.000Z',
      depositPaidAt: '2026-07-02T00:00:00.000Z',
      totalMinor: 1_000_000,
    }),
    fact({
      proposalId: 's2',
      acceptedAt: '2026-06-25T00:00:00.000Z',
      totalMinor: 500_000,
    }),
  ]);

  const report = signedDeals(data, { from: '2026-05-01', to: '2026-07-31' });

  it('returns every month in range, including empty ones', () => {
    expect(report.months.map((m) => m.key)).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  it('dates each milestone by its own date', () => {
    const accepted = report.series.find((s) => s.milestone === 'ACCEPTED')!;
    const deposit = report.series.find((s) => s.milestone === 'DEPOSIT_PAID')!;
    expect(accepted.points.map((p) => p.count)).toEqual([0, 2, 0]);
    expect(deposit.points.map((p) => p.count)).toEqual([0, 0, 1]);
    expect(accepted.totalValueMinor).toBe(1_500_000);
  });

  it('accumulates a running total', () => {
    const accepted = report.series.find((s) => s.milestone === 'ACCEPTED')!;
    expect(accepted.cumulativeMinor).toEqual([0, 1_500_000, 1_500_000]);
  });

  it('reports gaps as of now, not filtered to the window', () => {
    // s2 was accepted and never ordered; s1 was ordered and paid. A date filter would
    // hide exactly the deal worth chasing.
    expect(report.gaps.acceptedNotOrdered).toBe(1);
    expect(report.gaps.orderedNotPaid).toBe(0);
  });
});

/* ---------------------------------------------------------------------- goals */

describe('periodBounds', () => {
  it('snaps a mid-period date to the whole month, quarter and year', () => {
    const d = new Date('2026-08-17T13:45:00Z');
    expect(periodBounds('MONTH', d).from.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(periodBounds('MONTH', d).to.toISOString().slice(0, 10)).toBe('2026-08-31');
    expect(periodBounds('QUARTER', d).label).toBe('Q3 2026');
    expect(periodBounds('QUARTER', d).from.toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(periodBounds('YEAR', d).to.toISOString().slice(0, 10)).toBe('2026-12-31');
  });

  it('handles a December month without rolling the year wrong', () => {
    const b = periodBounds('MONTH', new Date('2026-12-09T00:00:00Z'));
    expect(b.to.toISOString().slice(0, 10)).toBe('2026-12-31');
    expect(b.label).toBe('December 2026');
  });
});

describe('goalProgress', () => {
  const data = dataset([
    fact({
      proposalId: 'g1',
      status: 'ACCEPTED',
      acceptedAt: '2026-08-05T00:00:00.000Z',
      repId: 'u1',
      rep: 'Bryan',
      totalMinor: 1_000_000,
      lines: [ln({ sku: 'K-4002', name: 'Summit Soar S2', qty: 2, amountMinor: 800_000 })],
    }),
    fact({
      proposalId: 'g2',
      status: 'ACCEPTED',
      acceptedAt: '2026-08-20T00:00:00.000Z',
      repId: 'u2',
      rep: 'Dana',
      totalMinor: 500_000,
      lines: [
        ln({ sku: 'K-4002', name: 'Summit Soar S2', qty: 1, amountMinor: 400_000 }),
        ln({
          sku: 'K-4002-OPT',
          name: 'Summit Soar spare',
          qty: 9,
          amountMinor: 0,
          optional: true,
        }),
      ],
    }),
    fact({
      proposalId: 'g3',
      status: 'ACCEPTED',
      acceptedAt: '2026-07-31T23:00:00.000Z', // previous month — must not count
      totalMinor: 9_000_000,
    }),
  ]);

  const base: GoalInput = {
    id: 'goal',
    name: 'August revenue',
    metric: 'REVENUE',
    period: 'MONTH',
    periodStart: new Date('2026-08-01T00:00:00Z'),
    targetMinor: 3_000_000,
    targetCount: null,
    ownerId: null,
    skuMatch: null,
    savedReportId: null,
    active: true,
  };

  const halfway = new Date('2026-08-16T12:00:00Z'); // ~half the month elapsed

  it('sums accepted proposals inside the period only', () => {
    const p = goalProgress(data, base, halfway);
    expect(p.actual).toBe(1_500_000);
    expect(p.target).toBe(3_000_000);
    expect(p.fill).toBeCloseTo(0.5, 2);
    expect(p.remaining).toBe(1_500_000);
    expect(p.hit).toBe(false);
  });

  it('narrows to one rep when the goal has an owner', () => {
    const p = goalProgress(data, { ...base, ownerId: 'u1' }, halfway);
    expect(p.actual).toBe(1_000_000);
    expect(p.contributors).toHaveLength(1);
    expect(p.contributors[0]!.number).toBe('P-0000');
  });

  it('counts deals rather than dollars for DEAL_COUNT', () => {
    const p = goalProgress(
      data,
      { ...base, metric: 'DEAL_COUNT', targetMinor: 0, targetCount: 4 },
      halfway,
    );
    expect(p.unit).toBe('count');
    expect(p.actual).toBe(2);
    expect(p.target).toBe(4);
  });

  it('counts product units by fragment, excluding optional lines', () => {
    const p = goalProgress(
      data,
      { ...base, metric: 'PRODUCT_UNITS', targetMinor: 0, targetCount: 10, skuMatch: 'soar' },
      halfway,
    );
    // 2 + 1 included; the 9 optional spares are not counted — nobody bought them.
    expect(p.actual).toBe(3);
  });

  it('reports pace against elapsed time, and marks a hit past the target', () => {
    const p = goalProgress(data, base, halfway);
    expect(p.paceTarget).toBeGreaterThan(1_400_000);
    expect(p.paceTarget).toBeLessThan(1_600_000);

    const met = goalProgress(data, { ...base, targetMinor: 1_000_000 }, halfway);
    expect(met.hit).toBe(true);
    expect(met.fill).toBe(1); // capped for drawing
    expect(met.ratio).toBeGreaterThan(1); // uncapped for the caption
    expect(met.remaining).toBe(0);
  });

  it('does not divide by zero when no target is set', () => {
    const p = goalProgress(data, { ...base, targetMinor: 0 }, halfway);
    expect(p.ratio).toBe(0);
    expect(p.hit).toBe(false);
  });

  it('reports no days left once the period has passed', () => {
    const p = goalProgress(data, base, new Date('2026-09-15T00:00:00Z'));
    expect(p.daysLeft).toBe(0);
    expect(p.elapsedFraction).toBe(1);
  });
});
