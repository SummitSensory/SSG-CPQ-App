/**
 * Proposal analytics: pure functions that turn stored proposal JSON (sections +
 * items) into money totals, then roll a list of versions up into the report
 * bundle the Reports module renders. No Prisma here — keeps it unit-testable.
 */

export interface RawItem {
  lineType?: string;
  name?: string;
  sku?: string;
  productId?: string | null;
  quantity?: number;
  rateMinor?: number;
  costEach?: number;
  weightEach?: number;
  tpFreightMinor?: number;
}

export interface RawMeta {
  discountPct?: number;
  taxAmountMinor?: number;
  structureFreightMinor?: number;
  matsFreightMinor?: number;
  freightMinor?: number;
  tbdTax?: string;
  tbdStructureFreight?: string;
  tbdMatsFreight?: string;
  expiration?: string;
  contactName?: string;
  projectId?: string;
}

export interface Totals {
  subtotal: number;
  discount: number;
  tpFreight: number;
  tax: number;
  structureFreight: number;
  matsFreight: number;
  total: number;
  cogs: number;
  revenue: number;
  margin: number;
  marginPct: number;
  weight: number;
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/**
 * The "prints instead of TBD" field takes wording, but it sits beside the amount box
 * and people type the figure into it. A plain number there is money, so it counts
 * toward the total; anything else is wording and contributes nothing.
 */
const overrideMinor = (text: unknown): number => {
  if (text == null) return 0;
  const s = String(text).trim().replace(/^\$/, '').replace(/,/g, '');
  return /^-?\d+(?:\.\d+)?$/.test(s) ? Math.round(parseFloat(s) * 100) : 0;
};

/** The amount field if it carries a figure, otherwise a numeric TBD override. */
const metaAmount = (minor: unknown, override: unknown): number => n(minor) || overrideMinor(override);

export function metaOf(sections: unknown): RawMeta {
  if (!Array.isArray(sections)) return {};
  const meta = sections.find((s) => s && typeof s === 'object' && (s as { id?: string }).id === 'meta');
  const data = meta && typeof meta === 'object' ? (meta as { data?: unknown }).data : undefined;
  return data && typeof data === 'object' ? (data as RawMeta) : {};
}

export function itemsOf(items: unknown): RawItem[] {
  return Array.isArray(items) ? (items.filter((i) => i && typeof i === 'object') as RawItem[]) : [];
}

/** Mirrors the builder's math exactly so reports and the printed proposal agree. */
export function versionTotals(items: unknown, sections: unknown): Totals {
  const lines = itemsOf(items);
  const meta = metaOf(sections);
  let subtotal = 0, cogs = 0, tpFreight = 0, weight = 0;
  for (const l of lines) {
    if ((l.lineType ?? 'PRODUCT') !== 'PRODUCT') continue;
    const qty = n(l.quantity);
    subtotal += qty * n(l.rateMinor);
    cogs += qty * n(l.costEach);
    weight += qty * n(l.weightEach);
    tpFreight += n(l.tpFreightMinor);
  }
  const discountPct = n(meta.discountPct);
  const discount = Math.round((subtotal * discountPct) / 100);
  const tax = metaAmount(meta.taxAmountMinor, meta.tbdTax);
  const structureFreight = metaAmount(
    meta.structureFreightMinor != null ? meta.structureFreightMinor : meta.freightMinor,
    meta.tbdStructureFreight,
  );
  const matsFreight = metaAmount(meta.matsFreightMinor, meta.tbdMatsFreight);
  const total = subtotal - discount + tpFreight + tax + structureFreight + matsFreight;
  const revenue = subtotal - discount + tpFreight;
  const margin = revenue - cogs;
  return {
    subtotal, discount, tpFreight, tax, structureFreight, matsFreight, total,
    cogs, revenue, margin,
    marginPct: revenue ? Math.round((margin / revenue) * 1000) / 10 : 0,
    weight,
  };
}

export type Status = 'DRAFT' | 'INTERNAL_REVIEW' | 'RELEASED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';

export interface AnalyticsVersion {
  id: string;
  version: number;
  status: Status;
  sections: unknown;
  items: unknown;
  expirationDate: Date | null;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string;
  decidedAt?: Date | null;
}

export interface AnalyticsProposal {
  id: string;
  number: string;
  title: string;
  organizationId: string;
  organizationName: string | null;
  customerType: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string;
  preparedBy: string | null;
  latest: AnalyticsVersion;
  versionCount: number;
}

export interface ReportRow {
  id: string;
  number: string;
  title: string;
  customer: string;
  customerType: string | null;
  preparedBy: string | null;
  status: Status;
  version: number;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
  releasedAt: string | null;
  decidedAt: string | null;
  expiration: string | null;
  expired: boolean;
  daysOpen: number;
  daysToDecision: number | null;
  total: number;
  revenue: number;
  cogs: number;
  margin: number;
  marginPct: number;
  lineCount: number;
}

const OPEN: Status[] = ['DRAFT', 'INTERNAL_REVIEW', 'RELEASED'];
const DAY = 86_400_000;
const days = (a: Date, b: Date): number => Math.max(0, Math.round((b.getTime() - a.getTime()) / DAY));
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const pct = (num: number, den: number): number => (den ? Math.round((num / den) * 1000) / 10 : 0);
const avg = (xs: number[]): number => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

export interface ReportBundle {
  generatedAt: string;
  range: { from: string | null; to: string | null };
  summary: Record<string, number>;
  pipeline: { status: Status; label: string; count: number; value: number }[];
  aging: { bucket: string; count: number; value: number }[];
  oldestOpen: ReportRow[];
  expiringSoon: ReportRow[];
  expiredOpen: ReportRow[];
  winLossByMonth: { month: string; won: number; lost: number; expired: number; wonValue: number; lostValue: number }[];
  byCustomer: { customer: string; count: number; value: number; won: number; wonValue: number; lost: number; winRate: number }[];
  byPreparer: { preparedBy: string; count: number; value: number; won: number; wonValue: number; winRate: number; avgMarginPct: number }[];
  byCustomerType: { customerType: string; count: number; value: number; won: number; wonValue: number }[];
  products: {
    sku: string;
    name: string;
    proposals: number;
    qty: number;
    proposedValue: number;
    wonProposals: number;
    wonQty: number;
    wonValue: number;
    attachRate: number;
    avgRate: number;
  }[];
  rows: ReportRow[];
}

const STATUS_LABEL: Record<Status, string> = {
  DRAFT: 'Draft',
  INTERNAL_REVIEW: 'Internal review',
  RELEASED: 'Released / out with customer',
  ACCEPTED: 'Accepted (won)',
  REJECTED: 'Rejected (lost)',
  EXPIRED: 'Expired / inactive',
};

export function buildReport(
  proposals: AnalyticsProposal[],
  opts: { from?: Date | null; to?: Date | null; now?: Date } = {},
): ReportBundle {
  const now = opts.now ?? new Date();
  const rows: ReportRow[] = proposals.map((p) => {
    const v = p.latest;
    const t = versionTotals(v.items, v.sections);
    const metaExp = metaOf(v.sections).expiration;
    const exp = v.expirationDate ?? (metaExp ? new Date(metaExp) : null);
    const expValid = exp && !Number.isNaN(exp.getTime()) ? exp : null;
    const decided = v.decidedAt ?? null;
    return {
      id: p.id,
      number: p.number,
      title: p.title,
      customer: p.organizationName ?? '—',
      customerType: p.customerType,
      preparedBy: p.preparedBy,
      status: v.status,
      version: v.version,
      versionCount: p.versionCount,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      releasedAt: iso(v.releasedAt),
      decidedAt: iso(decided),
      expiration: iso(expValid),
      expired: !!expValid && expValid.getTime() < now.getTime() && OPEN.includes(v.status),
      daysOpen: days(p.createdAt, decided ?? now),
      daysToDecision: decided ? days(v.releasedAt ?? p.createdAt, decided) : null,
      total: t.total,
      revenue: t.revenue,
      cogs: t.cogs,
      margin: t.margin,
      marginPct: t.marginPct,
      lineCount: itemsOf(v.items).filter((l) => (l.lineType ?? 'PRODUCT') === 'PRODUCT').length,
    };
  });

  const inRange = rows.filter((r) => {
    const d = new Date(r.createdAt).getTime();
    if (opts.from && d < opts.from.getTime()) return false;
    if (opts.to && d > opts.to.getTime()) return false;
    return true;
  });

  const by = (s: Status): ReportRow[] => inRange.filter((r) => r.status === s);
  const value = (xs: ReportRow[]): number => xs.reduce((a, r) => a + r.total, 0);
  const won = by('ACCEPTED'), lost = by('REJECTED'), expired = by('EXPIRED');
  const released = by('RELEASED');
  const open = inRange.filter((r) => OPEN.includes(r.status));
  // A proposal only counts toward conversion once it has actually gone out.
  const sent = [...released, ...won, ...lost, ...expired];
  const decidedRows = inRange.filter((r) => r.daysToDecision != null);

  const summary: Record<string, number> = {
    total: inRange.length,
    totalValue: value(inRange),
    avgValue: inRange.length ? Math.round(value(inRange) / inRange.length) : 0,
    open: open.length,
    openValue: value(open),
    sent: sent.length,
    sentValue: value(sent),
    won: won.length,
    wonValue: value(won),
    lost: lost.length,
    lostValue: value(lost),
    expired: expired.length,
    expiredValue: value(expired),
    draft: by('DRAFT').length,
    inReview: by('INTERNAL_REVIEW').length,
    released: released.length,
    conversionRate: pct(won.length, sent.length),
    conversionRateByValue: pct(value(won), value(sent)),
    winRate: pct(won.length, won.length + lost.length),
    lossRate: pct(lost.length, won.length + lost.length),
    expiryRate: pct(expired.length, sent.length),
    avgDaysToDecision: avg(decidedRows.map((r) => r.daysToDecision as number)),
    avgDaysOpen: avg(open.map((r) => r.daysOpen)),
    avgMarginPct: inRange.length
      ? Math.round((inRange.reduce((a, r) => a + r.marginPct, 0) / inRange.length) * 10) / 10
      : 0,
    wonMarginPct: won.length ? Math.round((won.reduce((a, r) => a + r.marginPct, 0) / won.length) * 10) / 10 : 0,
    expiredFlagged: inRange.filter((r) => r.expired).length,
  };

  const pipeline = (Object.keys(STATUS_LABEL) as Status[]).map((s) => ({
    status: s,
    label: STATUS_LABEL[s],
    count: by(s).length,
    value: value(by(s)),
  }));

  const BUCKETS: [string, number, number][] = [
    ['0–7 days', 0, 7],
    ['8–14 days', 8, 14],
    ['15–30 days', 15, 30],
    ['31–60 days', 31, 60],
    ['61–90 days', 61, 90],
    ['90+ days', 91, Infinity],
  ];
  const aging = BUCKETS.map(([bucket, lo, hi]) => {
    const xs = open.filter((r) => r.daysOpen >= lo && r.daysOpen <= hi);
    return { bucket, count: xs.length, value: value(xs) };
  });

  const monthKey = (s: string): string => s.slice(0, 7);
  const months = new Map<string, { month: string; won: number; lost: number; expired: number; wonValue: number; lostValue: number }>();
  const bump = (key: string): { month: string; won: number; lost: number; expired: number; wonValue: number; lostValue: number } => {
    let m = months.get(key);
    if (!m) { m = { month: key, won: 0, lost: 0, expired: 0, wonValue: 0, lostValue: 0 }; months.set(key, m); }
    return m;
  };
  for (const r of won) { const m = bump(monthKey(r.decidedAt ?? r.updatedAt)); m.won++; m.wonValue += r.total; }
  for (const r of lost) { const m = bump(monthKey(r.decidedAt ?? r.updatedAt)); m.lost++; m.lostValue += r.total; }
  for (const r of expired) { bump(monthKey(r.decidedAt ?? r.updatedAt)).expired++; }

  function group<T extends string>(keyOf: (r: ReportRow) => T) {
    const m = new Map<T, { key: T; count: number; value: number; won: number; wonValue: number; lost: number; marginSum: number }>();
    for (const r of inRange) {
      const k = keyOf(r);
      let g = m.get(k);
      if (!g) { g = { key: k, count: 0, value: 0, won: 0, wonValue: 0, lost: 0, marginSum: 0 }; m.set(k, g); }
      g.count++; g.value += r.total; g.marginSum += r.marginPct;
      if (r.status === 'ACCEPTED') { g.won++; g.wonValue += r.total; }
      if (r.status === 'REJECTED') g.lost++;
    }
    return [...m.values()];
  }

  const byCustomer = group((r) => r.customer)
    .map((g) => ({ customer: g.key, count: g.count, value: g.value, won: g.won, wonValue: g.wonValue, lost: g.lost, winRate: pct(g.won, g.won + g.lost) }))
    .sort((a, b) => b.value - a.value);

  const byPreparer = group((r) => r.preparedBy ?? '—')
    .map((g) => ({
      preparedBy: g.key, count: g.count, value: g.value, won: g.won, wonValue: g.wonValue,
      winRate: pct(g.won, g.won + g.lost),
      avgMarginPct: g.count ? Math.round((g.marginSum / g.count) * 10) / 10 : 0,
    }))
    .sort((a, b) => b.value - a.value);

  const byCustomerType = group((r) => r.customerType ?? 'Unspecified')
    .map((g) => ({ customerType: g.key, count: g.count, value: g.value, won: g.won, wonValue: g.wonValue }))
    .sort((a, b) => b.value - a.value);

  // Product performance: what is actually being put in front of customers, and
  // what of that closes. Keyed by SKU when present, otherwise by line name.
  const prod = new Map<string, ReportBundle['products'][number] & { rateSum: number; rateCount: number }>();
  const idsIn = new Set(inRange.map((r) => r.id));
  for (const p of proposals) {
    if (!idsIn.has(p.id)) continue;
    const row = inRange.find((r) => r.id === p.id)!;
    const isWon = row.status === 'ACCEPTED';
    const seen = new Set<string>();
    for (const l of itemsOf(p.latest.items)) {
      if ((l.lineType ?? 'PRODUCT') !== 'PRODUCT') continue;
      const key = (l.sku || l.name || 'Unnamed').trim();
      if (!key) continue;
      let e = prod.get(key);
      if (!e) {
        e = { sku: l.sku || '—', name: l.name || key, proposals: 0, qty: 0, proposedValue: 0, wonProposals: 0, wonQty: 0, wonValue: 0, attachRate: 0, avgRate: 0, rateSum: 0, rateCount: 0 };
        prod.set(key, e);
      }
      const qty = n(l.quantity);
      const amt = qty * n(l.rateMinor);
      if (!seen.has(key)) { e.proposals++; if (isWon) e.wonProposals++; seen.add(key); }
      e.qty += qty; e.proposedValue += amt;
      if (isWon) { e.wonQty += qty; e.wonValue += amt; }
      if (n(l.rateMinor) > 0) { e.rateSum += n(l.rateMinor); e.rateCount++; }
    }
  }
  const products = [...prod.values()]
    .map((e) => ({
      sku: e.sku, name: e.name, proposals: e.proposals, qty: e.qty, proposedValue: e.proposedValue,
      wonProposals: e.wonProposals, wonQty: e.wonQty, wonValue: e.wonValue,
      attachRate: pct(e.proposals, inRange.length),
      avgRate: e.rateCount ? Math.round(e.rateSum / e.rateCount) : 0,
    }))
    .sort((a, b) => b.proposedValue - a.proposedValue);

  const soon = now.getTime() + 14 * DAY;
  return {
    generatedAt: now.toISOString(),
    range: { from: opts.from ? opts.from.toISOString() : null, to: opts.to ? opts.to.toISOString() : null },
    summary,
    pipeline,
    aging,
    oldestOpen: [...open].sort((a, b) => b.daysOpen - a.daysOpen).slice(0, 10),
    expiringSoon: open
      .filter((r) => r.expiration && !r.expired && new Date(r.expiration).getTime() <= soon)
      .sort((a, b) => (a.expiration ?? '').localeCompare(b.expiration ?? '')),
    expiredOpen: open.filter((r) => r.expired).sort((a, b) => (a.expiration ?? '').localeCompare(b.expiration ?? '')),
    winLossByMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    byCustomer,
    byPreparer,
    byCustomerType,
    products,
    rows: inRange.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
}
