/**
 * Signed deals over time.
 *
 * Monthly counts and dollars for the four milestones a deal passes through, from one
 * pass over the dataset. The chart draws count against the left axis and dollars
 * against the right, which is why both are returned per month rather than as two
 * separate series requests.
 *
 * The four are reported side by side rather than collapsed into one "signed" figure
 * because the gaps between them are the interesting part: eleven accepted, nine
 * ordered, six with a deposit in the bank is a story about the last two weeks of the
 * month, and a single number tells none of it.
 */
import type { Dataset, Fact } from './dataset.js';

export type Milestone = 'ACCEPTED' | 'ORDERED' | 'DEPOSIT_PAID' | 'PAID';

export const MILESTONE_LABEL: Record<Milestone, string> = {
  ACCEPTED: 'Accepted / signed',
  ORDERED: 'Order created',
  DEPOSIT_PAID: 'First payment received',
  PAID: 'Paid in full',
};

const FIELD: Record<Milestone, keyof Fact> = {
  ACCEPTED: 'acceptedAt',
  ORDERED: 'orderedAt',
  DEPOSIT_PAID: 'depositPaidAt',
  PAID: 'paidInFullAt',
};

export interface SignedDealsPoint {
  month: string;
  label: string;
  count: number;
  valueMinor: number;
}

export interface SignedDealsSeries {
  milestone: Milestone;
  label: string;
  points: SignedDealsPoint[];
  totalCount: number;
  totalValueMinor: number;
  /** Cumulative dollars, so the same payload can draw a running-total line. */
  cumulativeMinor: number[];
}

export interface SignedDealsReport {
  from: string | null;
  to: string | null;
  months: { key: string; label: string }[];
  series: SignedDealsSeries[];
  /** Deals accepted but with no order, and ordered with no payment, right now. */
  gaps: { acceptedNotOrdered: number; orderedNotPaid: number; openBalanceMinor: number };
  generatedAt: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  const i = Number(m) - 1;
  return MONTHS[i] ? `${MONTHS[i]} ${String(y).slice(2)}` : key;
}

/** Every month from `from` to `to` inclusive, so a month with no deals still shows. */
function monthSpan(from: Date, to: Date): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1);
  while (d.getTime() <= end) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
    if (out.length > 120) break; // ten years is plenty; a runaway loop is not
  }
  return out;
}

export function signedDeals(
  data: Dataset,
  opts: { from?: string | null; to?: string | null } = {},
): SignedDealsReport {
  const now = new Date();
  const to = opts.to ? new Date(`${opts.to.slice(0, 10)}T23:59:59.999Z`) : now;
  const from = opts.from
    ? new Date(`${opts.from.slice(0, 10)}T00:00:00.000Z`)
    : new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth() + 1, 1));

  const months = monthSpan(from, to);
  const index = new Map(months.map((m, i) => [m, i]));

  const series: SignedDealsSeries[] = (Object.keys(FIELD) as Milestone[]).map((milestone) => {
    const counts = months.map(() => 0);
    const values = months.map(() => 0);
    for (const f of data.facts) {
      const at = (f[FIELD[milestone]] as string | null) ?? null;
      if (!at) continue;
      const t = new Date(at).getTime();
      if (t < from.getTime() || t > to.getTime()) continue;
      const i = index.get(at.slice(0, 7));
      if (i == null) continue;
      counts[i] = (counts[i] ?? 0) + 1;
      values[i] = (values[i] ?? 0) + f.totalMinor;
    }
    let running = 0;
    const cumulative = values.map((v) => (running += v));
    return {
      milestone,
      label: MILESTONE_LABEL[milestone],
      points: months.map((m, i) => ({
        month: m,
        label: monthLabel(m),
        count: counts[i]!,
        valueMinor: values[i]!,
      })),
      totalCount: counts.reduce((a, b) => a + b, 0),
      totalValueMinor: values.reduce((a, b) => a + b, 0),
      cumulativeMinor: cumulative,
    };
  });

  // The gaps are deliberately "as of now" rather than filtered to the window: a deal
  // accepted in March with no order is still missing an order in September, and a
  // date filter would hide exactly the ones worth chasing.
  let acceptedNotOrdered = 0;
  let orderedNotPaid = 0;
  let openBalanceMinor = 0;
  for (const f of data.facts) {
    if (f.acceptedAt && !f.orderedAt) acceptedNotOrdered++;
    if (f.orderedAt && !f.depositPaidAt) {
      orderedNotPaid++;
      openBalanceMinor += f.totalMinor;
    }
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    months: months.map((k) => ({ key: k, label: monthLabel(k) })),
    series,
    gaps: { acceptedNotOrdered, orderedNotPaid, openBalanceMinor },
    generatedAt: new Date().toISOString(),
  };
}
