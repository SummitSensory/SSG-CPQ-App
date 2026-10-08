import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Dataset, Fact, FactLine } from '../../src/reporting/dataset.js';
import { runReport } from '../../src/reporting/query.js';
import { goalProgress, periodBounds } from '../../src/reporting/goals.js';
import { signedDeals } from '../../src/reporting/signedDeals.js';
import { daysPastDue } from '../../src/integrations/quickbooks/receivables.js';
import { money, longDate } from '../../src/email/paymentTemplates.js';
import { canDecide } from '../../src/approvals/policy.js';
import { normalizeOrgName } from '../../src/crm/duplicates.js';

/**
 * Audit: reporting / receivables / approvals pure logic.
 *
 * `it.fails` marks a CONFIRMED bug — the assertion states the correct behaviour and
 * currently fails. When the bug is fixed the `it.fails` turns red and should be
 * flipped to a plain `it`.
 */

function line(over: Partial<FactLine> = {}): FactLine {
  return {
    sku: 'K-1',
    name: 'Part',
    category: 'FRAME',
    manufacturer: 'Acme',
    proposalGroup: 'Frames',
    optional: false,
    qty: 1,
    rateMinor: 1000,
    amountMinor: 1000,
    costMinor: 500,
    ...over,
  };
}

function fact(over: Partial<Fact> = {}): Fact {
  return {
    proposalId: 'p1',
    number: 'P-1',
    title: 'T',
    status: 'ACCEPTED',
    version: 1,
    customerId: 'c1',
    customer: 'Clinic',
    customerType: 'HOSPITAL',
    region: 'CO',
    country: 'US',
    repId: 'r1',
    rep: 'Rep',
    createdAt: '2026-03-10T15:00:00.000Z',
    releasedAt: null,
    decidedAt: null,
    acceptedAt: '2026-03-12T15:00:00.000Z',
    orderedAt: null,
    depositPaidAt: null,
    paidInFullAt: null,
    totalMinor: 10_000,
    revenueMinor: 10_000,
    cogsMinor: 4_000,
    marginMinor: 6_000,
    marginPct: 60,
    discountPct: 0,
    financed: false,
    lines: [line()],
    ...over,
  };
}

function dataset(facts: Fact[]): Dataset {
  return {
    facts,
    builtAt: new Date().toISOString(),
    reps: [],
    customers: [],
    categories: [],
    manufacturers: [],
    proposalGroups: [],
    regions: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('audit: runReport totals reconcile with rows', () => {
  it('proposal-grain PROPOSAL_VALUE total equals the sum of the rows', () => {
    const res = runReport(
      dataset([
        fact({ proposalId: 'a', repId: 'r1', rep: 'A', totalMinor: 100 }),
        fact({ proposalId: 'b', repId: 'r2', rep: 'B', totalMinor: 250 }),
        fact({ proposalId: 'c', repId: 'r2', rep: 'B', totalMinor: 50 }),
      ]),
      { dateBasis: 'CREATED', groupBy: ['REP'], measures: ['PROPOSALS', 'PROPOSAL_VALUE'] },
    );
    const sum = res.rows.reduce((a, r) => a + Number(r.PROPOSAL_VALUE), 0);
    expect(res.totals.PROPOSAL_VALUE).toBe(sum);
    expect(res.totals.PROPOSAL_VALUE).toBe(400);
    expect(res.totals.PROPOSALS).toBe(3);
  });

  it('line-grain PROPOSALS total counts each proposal once', () => {
    const res = runReport(
      dataset([
        fact({
          proposalId: 'a',
          lines: [line({ sku: 'X' }), line({ sku: 'Y' })],
        }),
      ]),
      { dateBasis: 'CREATED', groupBy: ['SKU'], measures: ['PROPOSALS', 'LINE_VALUE'] },
    );
    expect(res.rows).toHaveLength(2);
    expect(res.totals.PROPOSALS).toBe(1);
    expect(res.totals.LINE_VALUE).toBe(2000);
  });

  // BUG: query.ts:578-581 — the AVG_PROPOSAL_VALUE total divides the SUM of every
  // bucket's proposalValue (which, at line grain, counts a proposal once per part it
  // carries) by the DE-DUPLICATED proposal count. One $100 proposal with two parts
  // reports an average proposal of $200.
  it.fails('line-grain AVG_PROPOSAL_VALUE total is the true average proposal value', () => {
    const res = runReport(
      dataset([
        fact({
          proposalId: 'a',
          totalMinor: 10_000,
          lines: [line({ sku: 'X' }), line({ sku: 'Y' })],
        }),
      ]),
      { dateBasis: 'CREATED', groupBy: ['SKU'], measures: ['AVG_PROPOSAL_VALUE'] },
    );
    expect(res.totals.AVG_PROPOSAL_VALUE).toBe(10_000);
  });

  // BUG: query.ts:583 — WON_VALUE / PROPOSAL_VALUE / COGS / MARGIN totals at line grain
  // are summed across buckets, so the totals row double-counts a proposal that
  // appears under several SKUs, while the PROPOSALS total beside it is de-duplicated.
  // The totals row then states "1 proposal, $200 won" for a single $100 deal.
  it.fails('line-grain WON_VALUE total does not double count a multi-part proposal', () => {
    const res = runReport(
      dataset([
        fact({
          proposalId: 'a',
          totalMinor: 10_000,
          lines: [line({ sku: 'X' }), line({ sku: 'Y' })],
        }),
      ]),
      { dateBasis: 'CREATED', groupBy: ['SKU'], measures: ['WON_PROPOSALS', 'WON_VALUE'] },
    );
    expect(res.totals.WON_PROPOSALS).toBe(1);
    expect(res.totals.WON_VALUE).toBe(10_000);
  });

  it('chart series mirrors the visible rows', () => {
    const res = runReport(
      dataset([
        fact({ proposalId: 'a', createdAt: '2026-01-15T12:00:00.000Z' }),
        fact({ proposalId: 'b', createdAt: '2026-02-15T12:00:00.000Z' }),
      ]),
      { dateBasis: 'CREATED', groupBy: ['MONTH'], measures: ['PROPOSALS'] },
    );
    expect(res.chart.labels).toEqual(['Jan 2026', 'Feb 2026']);
    expect(res.chart.series[0]!.values).toEqual([1, 1]);
  });

  it('maps every month to the right quarter', () => {
    const facts = Array.from({ length: 12 }, (_, i) =>
      fact({
        proposalId: 'p' + i,
        createdAt: `2026-${String(i + 1).padStart(2, '0')}-15T12:00:00.000Z`,
      }),
    );
    const res = runReport(dataset(facts), {
      dateBasis: 'CREATED',
      groupBy: ['QUARTER'],
      measures: ['PROPOSALS'],
    });
    expect(res.rows.map((r) => [r.d0, r.PROPOSALS])).toEqual([
      ['Q1 2026', 3],
      ['Q2 2026', 3],
      ['Q3 2026', 3],
      ['Q4 2026', 3],
    ]);
  });

  // BUG: query.ts:309-311 — band() starts its first bucket at 0, so a NEGATIVE margin
  // (a loss-making proposal, exactly the one a margin report is run to find) is
  // labelled "0–20%", alongside healthy low-margin deals.
  it.fails('a negative margin is not reported in the 0–20% band', () => {
    const res = runReport(dataset([fact({ marginPct: -15 })]), {
      dateBasis: 'CREATED',
      groupBy: ['MARGIN_BAND'],
      measures: ['PROPOSALS'],
    });
    expect(res.rows[0]!.d0).not.toBe('0–20%');
  });
});

describe('audit: reporting date boundaries (business time zone is America/Denver)', () => {
  // The codebase states Summit's day is America/Denver (src/handoff/bomSections.ts:280,
  // BOM_TIME_ZONE). The report engine buckets by the UTC calendar date
  // (query.ts:233, basisDate.slice(0, 7)), so anything after ~6 pm Mountain on the last
  // day of a month lands in the NEXT month — October's last-evening signings are
  // reported as November.
  it.fails('a deal accepted at 9 pm Mountain on Oct 31 is reported in October', () => {
    const res = runReport(
      dataset([fact({ acceptedAt: '2026-11-01T03:00:00.000Z' })]), // 21:00 MDT Oct 31
      { dateBasis: 'ACCEPTED', groupBy: ['MONTH'], measures: ['PROPOSALS'] },
    );
    expect(res.rows[0]!.d0).toBe('Oct 2026');
  });

  // Same root cause in the goal engine: periodBounds is UTC midnight to UTC midnight.
  it.fails('a deal accepted at 9 pm Mountain on Oct 31 counts toward the October goal', () => {
    const p = goalProgress(
      dataset([fact({ acceptedAt: '2026-11-01T03:00:00.000Z', totalMinor: 500 })]),
      {
        id: 'g',
        name: 'Oct',
        metric: 'REVENUE',
        period: 'MONTH',
        periodStart: new Date('2026-10-01T00:00:00.000Z'),
        targetMinor: 1000,
        targetCount: null,
        ownerId: null,
        skuMatch: null,
        savedReportId: null,
        active: true,
      },
      new Date('2026-11-02T00:00:00.000Z'),
    );
    expect(p.actual).toBe(500);
  });

  it('periodBounds covers whole quarters', () => {
    const q = periodBounds('QUARTER', new Date('2026-05-20T00:00:00.000Z'));
    expect(q.label).toBe('Q2 2026');
    expect(q.from.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(q.to.toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });
});

describe('audit: goals', () => {
  it('PRODUCT_UNITS excludes optional lines and sums matching quantities', () => {
    const p = goalProgress(
      dataset([
        fact({
          lines: [
            line({ sku: 'SOAR-1', qty: 2 }),
            line({ sku: 'SOAR-2', qty: 3, optional: true }),
            line({ sku: 'OTHER', qty: 7 }),
          ],
        }),
      ]),
      {
        id: 'g',
        name: 'Soar',
        metric: 'PRODUCT_UNITS',
        period: 'MONTH',
        periodStart: new Date('2026-03-01T00:00:00.000Z'),
        targetMinor: 0,
        targetCount: 10,
        ownerId: null,
        skuMatch: 'soar',
        savedReportId: null,
        active: true,
      },
      new Date('2026-03-31T00:00:00.000Z'),
    );
    expect(p.actual).toBe(2);
    expect(p.remaining).toBe(8);
    expect(p.hit).toBe(false);
  });
});

describe('audit: signed deals', () => {
  it('series totals equal the sum of their monthly points', () => {
    const r = signedDeals(
      dataset([
        fact({ proposalId: 'a', acceptedAt: '2026-01-10T12:00:00.000Z', totalMinor: 100 }),
        fact({ proposalId: 'b', acceptedAt: '2026-03-10T12:00:00.000Z', totalMinor: 300 }),
      ]),
      { from: '2026-01-01', to: '2026-03-31' },
    );
    const acc = r.series.find((s) => s.milestone === 'ACCEPTED')!;
    expect(acc.points.map((p) => p.count)).toEqual([1, 0, 1]);
    expect(acc.totalValueMinor).toBe(acc.points.reduce((a, p) => a + p.valueMinor, 0));
    expect(acc.cumulativeMinor.at(-1)).toBe(400);
  });
});

describe('audit: receivables aging', () => {
  it('is zero for a paid invoice however old', () => {
    expect(daysPastDue(new Date('2020-01-01T00:00:00Z'), 0n)).toBe(0);
    expect(daysPastDue(new Date('2020-01-01T00:00:00Z'), null)).toBe(0);
  });

  it('counts whole days past the due date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T18:00:00.000Z')); // noon Mountain, Oct 10
    expect(daysPastDue(new Date('2026-10-08T00:00:00Z'), 100n)).toBe(2);
    expect(daysPastDue(new Date('2026-10-10T00:00:00Z'), 100n)).toBe(0);
    expect(daysPastDue(new Date('2026-10-11T00:00:00Z'), 100n)).toBe(0);
  });

  // BUG: integrations/quickbooks/receivables.ts:44-47 — the due date is a calendar
  // date stored as UTC midnight and compared against the UTC clock. From 6 pm Mountain
  // on the due date itself the invoice shows "OVERDUE · 1d" and is added to the
  // ledger's past-due total, a day before it is actually late.
  it.fails('an invoice is not past due on the evening of its due date (Mountain)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T02:00:00.000Z')); // 8 pm MDT, Oct 8
    expect(daysPastDue(new Date('2026-10-08T00:00:00Z'), 100n)).toBe(0);
  });
});

describe('audit: money / date formatting', () => {
  it('formats minor units from bigint, string and number identically', () => {
    expect(money(123456n)).toBe('$1,234.56');
    expect(money('123456')).toBe('$1,234.56');
    expect(money(123456)).toBe('$1,234.56');
    expect(money(-5n)).toBe('-$0.05');
    expect(money(null)).toBe('');
    expect(money(100n, 'CAD')).toBe('CA$1.00');
  });

  it('prints a yyyy-mm-dd date without slipping a day', () => {
    expect(longDate('2026-03-01')).toBe('March 1, 2026');
    expect(longDate(new Date('2026-03-01T00:00:00Z'))).toBe('March 1, 2026');
    expect(longDate('not a date')).toBe('');
  });
});

describe('audit: approval decision guard', () => {
  it('blocks self-approval for discount and release', () => {
    for (const type of ['DISCOUNT', 'PROPOSAL_RELEASE', 'CUSTOM_PRICING'] as const) {
      expect(
        canDecide({ type, requesterId: 'u', deciderId: 'u', deciderHasPermission: true }).allowed,
      ).toBe(false);
    }
  });

  it('blocks a decider with neither the permission nor a delegation', () => {
    expect(
      canDecide({
        type: 'FREIGHT_EXCEPTION',
        requesterId: 'a',
        deciderId: 'b',
        deciderHasPermission: false,
      }).allowed,
    ).toBe(false);
  });

  // Documented, not a failure: policy.ts deliberately allows the requester to approve
  // their own CUSTOM_PRODUCT / PRODUCT_RULE_OVERRIDE / FREIGHT_EXCEPTION /
  // INSTALLATION_EXCEPTION requests. Pinned so a change to that list is a decision.
  it('allows self-approval for the four operational exception types', () => {
    for (const type of [
      'CUSTOM_PRODUCT',
      'PRODUCT_RULE_OVERRIDE',
      'FREIGHT_EXCEPTION',
      'INSTALLATION_EXCEPTION',
    ] as const) {
      expect(
        canDecide({ type, requesterId: 'u', deciderId: 'u', deciderHasPermission: true }).allowed,
      ).toBe(true);
    }
  });
});

describe('audit: CRM organization dedupe', () => {
  it('treats punctuation, case, suffixes and accents as the same name', () => {
    expect(normalizeOrgName('Acme, Inc.')).toBe(normalizeOrgName('ACME inc'));
    expect(normalizeOrgName('The Sensory Co.')).toBe(normalizeOrgName('sensory'));
    expect(normalizeOrgName('Café Kids LLC')).toBe(normalizeOrgName('Cafe Kids'));
  });

  // BUG (low): crm/duplicates.ts:4-11 strips "&" to a space but keeps "and", so
  // "Smith & Jones Therapy" and "Smith and Jones Therapy" are created as two customers
  // without the duplicate warning.
  it.fails('treats "&" and "and" as the same name', () => {
    expect(normalizeOrgName('Smith & Jones Therapy')).toBe(
      normalizeOrgName('Smith and Jones Therapy'),
    );
  });
});
