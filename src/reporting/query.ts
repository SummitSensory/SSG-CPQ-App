/**
 * The report engine.
 *
 * One function, `runReport`, turns a definition — group by these, filter to that,
 * show these numbers — into columns, rows, totals and a chart series. No Prisma, no
 * Fastify: it takes the dataset and gives back a table, which is what makes it
 * testable and what lets the same definition run from the screen, from a saved
 * report and from the goals page.
 *
 * Grain
 * -----
 * Rows are grouped over proposal LINES when the grouping or the measures need a
 * line (SKU, category, units), and over PROPOSALS otherwise. The engine decides;
 * the caller does not have to.
 *
 * One consequence is worth stating because it will otherwise look like a bug: when
 * a report is grouped by SKU, "Proposals" counts the proposals that CONTAIN that
 * part, and "Proposal value" is the value of those whole proposals — not the value
 * of the part's lines. Summing that column down the page therefore exceeds the
 * company total, because one proposal carrying six parts is counted under all six.
 * "Line value" is the per-part figure. Both are offered because both questions get
 * asked, and the column labels say which is which.
 */
import type { Dataset, Fact, FactLine } from './dataset.js';

export type DateBasis =
  'CREATED' | 'RELEASED' | 'DECIDED' | 'ACCEPTED' | 'ORDERED' | 'DEPOSIT_PAID' | 'PAID';

export type Dimension =
  | 'MONTH'
  | 'QUARTER'
  | 'YEAR'
  | 'WEEK'
  | 'STATUS'
  | 'REP'
  | 'CUSTOMER'
  | 'CUSTOMER_TYPE'
  | 'REGION'
  | 'COUNTRY'
  | 'SKU'
  | 'PRODUCT'
  | 'CATEGORY'
  | 'MANUFACTURER'
  | 'PROPOSAL_GROUP'
  | 'OPTIONAL'
  | 'FINANCING'
  | 'DISCOUNT_BAND'
  | 'MARGIN_BAND';

export type Measure =
  | 'PROPOSALS'
  | 'LINES'
  | 'UNITS'
  | 'LINE_VALUE'
  | 'PROPOSAL_VALUE'
  | 'WON_PROPOSALS'
  | 'WON_VALUE'
  | 'COGS'
  | 'MARGIN'
  | 'MARGIN_PCT'
  | 'AVG_PROPOSAL_VALUE'
  | 'WIN_RATE';

export interface ReportFilters {
  status?: string[];
  repIds?: string[];
  customerIds?: string[];
  customerTypes?: string[];
  regions?: string[];
  countries?: string[];
  /** Case-insensitive fragment matched against a line's SKU **or** its name. */
  productLike?: string;
  categories?: string[];
  manufacturers?: string[];
  proposalGroups?: string[];
  optional?: 'ANY' | 'INCLUDED_ONLY' | 'OPTIONAL_ONLY';
  financing?: 'ANY' | 'FINANCED' | 'CASH';
  discountPctMin?: number | null;
  discountPctMax?: number | null;
  marginPctMin?: number | null;
  marginPctMax?: number | null;
}

export interface ReportDefinition {
  dateBasis: DateBasis;
  from?: string | null;
  to?: string | null;
  groupBy: Dimension[];
  measures: Measure[];
  filters?: ReportFilters;
  sort?: { key: string; dir: 'asc' | 'desc' } | null;
  limit?: number | null;
}

export interface ReportColumn {
  key: string;
  label: string;
  kind: 'text' | 'int' | 'money' | 'pct';
  align: 'left' | 'right';
}

export interface ReportResult {
  definition: ReportDefinition;
  columns: ReportColumn[];
  rows: Record<string, string | number>[];
  totals: Record<string, number>;
  chart: {
    labels: string[];
    series: { key: string; label: string; kind: ReportColumn['kind']; values: number[] }[];
  };
  meta: {
    generatedAt: string;
    grain: 'PROPOSAL' | 'LINE';
    proposalsMatched: number;
    truncated: boolean;
    notes: string[];
  };
}

/* ------------------------------------------------------------------ labels */

const BASIS_FIELD: Record<DateBasis, keyof Fact> = {
  CREATED: 'createdAt',
  RELEASED: 'releasedAt',
  DECIDED: 'decidedAt',
  ACCEPTED: 'acceptedAt',
  ORDERED: 'orderedAt',
  DEPOSIT_PAID: 'depositPaidAt',
  PAID: 'paidInFullAt',
};

export const BASIS_LABEL: Record<DateBasis, string> = {
  CREATED: 'Proposal created',
  RELEASED: 'Proposal released',
  DECIDED: 'Decision (won / lost / expired)',
  ACCEPTED: 'Accepted / signed',
  ORDERED: 'Order created',
  DEPOSIT_PAID: 'First payment received',
  PAID: 'Paid in full',
};

const DIM_LABEL: Record<Dimension, string> = {
  MONTH: 'Month',
  QUARTER: 'Quarter',
  YEAR: 'Year',
  WEEK: 'Week beginning',
  STATUS: 'Status',
  REP: 'Prepared by',
  CUSTOMER: 'Customer',
  CUSTOMER_TYPE: 'Customer type',
  REGION: 'State / province',
  COUNTRY: 'Country',
  SKU: 'SKU',
  PRODUCT: 'Product',
  CATEGORY: 'Catalog category',
  MANUFACTURER: 'Manufacturer',
  PROPOSAL_GROUP: 'Tier category',
  OPTIONAL: 'Optional / included',
  FINANCING: 'Financing',
  DISCOUNT_BAND: 'Discount',
  MARGIN_BAND: 'Margin',
};

const MEASURE_DEF: Record<Measure, { label: string; kind: ReportColumn['kind'] }> = {
  PROPOSALS: { label: 'Proposals', kind: 'int' },
  LINES: { label: 'Lines', kind: 'int' },
  UNITS: { label: 'Units', kind: 'int' },
  LINE_VALUE: { label: 'Line value', kind: 'money' },
  PROPOSAL_VALUE: { label: 'Proposal value', kind: 'money' },
  WON_PROPOSALS: { label: 'Won', kind: 'int' },
  WON_VALUE: { label: 'Won value', kind: 'money' },
  COGS: { label: 'Cost of goods', kind: 'money' },
  MARGIN: { label: 'Margin', kind: 'money' },
  MARGIN_PCT: { label: 'Margin %', kind: 'pct' },
  AVG_PROPOSAL_VALUE: { label: 'Avg proposal', kind: 'money' },
  WIN_RATE: { label: 'Win rate', kind: 'pct' },
};

/** Dimensions that describe a line rather than a proposal. */
const LINE_DIMS: Dimension[] = [
  'SKU',
  'PRODUCT',
  'CATEGORY',
  'MANUFACTURER',
  'PROPOSAL_GROUP',
  'OPTIONAL',
];
/** Measures that can only be answered by looking at lines. */
const LINE_MEASURES: Measure[] = ['UNITS', 'LINE_VALUE', 'LINES'];

/* ------------------------------------------------------------- dimensions */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  const idx = Number(m) - 1;
  return MONTHS[idx] ? `${MONTHS[idx]} ${y}` : key;
}

/** Monday of the ISO week the date falls in, as YYYY-MM-DD. */
function weekKey(isoDate: string): string {
  const d = new Date(isoDate);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function band(value: number, edges: number[], unit: string): string {
  for (let i = 0; i < edges.length; i++) {
    const lo = i === 0 ? 0 : edges[i - 1]!;
    if (value <= edges[i]!) return `${lo}–${edges[i]}${unit}`;
  }
  return `${edges[edges.length - 1]}${unit}+`;
}

interface Cell {
  key: string;
  label: string;
  sort: string;
}

function dimensionValue(
  dim: Dimension,
  f: Fact,
  l: FactLine | null,
  basisDate: string | null,
): Cell {
  const noDate = { key: 'undated', label: 'No date', sort: '\uffff' };
  switch (dim) {
    case 'MONTH': {
      if (!basisDate) return noDate;
      const k = basisDate.slice(0, 7);
      return { key: k, label: monthLabel(k), sort: k };
    }
    case 'QUARTER': {
      if (!basisDate) return noDate;
      const y = basisDate.slice(0, 4);
      const q = Math.floor(Number(basisDate.slice(5, 7)) / 3.01) + 1;
      return { key: `${y}-Q${q}`, label: `Q${q} ${y}`, sort: `${y}-${q}` };
    }
    case 'YEAR': {
      if (!basisDate) return noDate;
      const y = basisDate.slice(0, 4);
      return { key: y, label: y, sort: y };
    }
    case 'WEEK': {
      if (!basisDate) return noDate;
      const k = weekKey(basisDate);
      return { key: k, label: `w/c ${k}`, sort: k };
    }
    case 'STATUS':
      return { key: f.status, label: titleCase(f.status), sort: f.status };
    case 'REP':
      return { key: f.repId, label: f.rep, sort: f.rep.toLowerCase() };
    case 'CUSTOMER':
      return { key: f.customerId, label: f.customer, sort: f.customer.toLowerCase() };
    case 'CUSTOMER_TYPE':
      return { key: f.customerType, label: titleCase(f.customerType), sort: f.customerType };
    case 'REGION':
      return { key: f.region, label: f.region, sort: f.region };
    case 'COUNTRY':
      return { key: f.country, label: f.country, sort: f.country };
    case 'SKU':
      return { key: l ? l.sku : '—', label: l ? l.sku : '—', sort: l ? l.sku : '—' };
    case 'PRODUCT':
      return {
        key: l ? l.name : '—',
        label: l ? l.name : '—',
        sort: (l ? l.name : '').toLowerCase(),
      };
    case 'CATEGORY':
      return {
        key: l ? l.category : '—',
        label: l ? titleCase(l.category) : '—',
        sort: l ? l.category : '',
      };
    case 'MANUFACTURER':
      return {
        key: l ? l.manufacturer : '—',
        label: l ? l.manufacturer : '—',
        sort: l ? l.manufacturer : '',
      };
    case 'PROPOSAL_GROUP':
      return {
        key: l ? l.proposalGroup : '—',
        label: l ? l.proposalGroup : '—',
        sort: l ? l.proposalGroup : '',
      };
    case 'OPTIONAL': {
      const opt = !!l?.optional;
      return {
        key: opt ? 'OPTIONAL' : 'INCLUDED',
        label: opt ? 'Optional' : 'Included',
        sort: opt ? '1' : '0',
      };
    }
    case 'FINANCING':
      return {
        key: f.financed ? 'FINANCED' : 'CASH',
        label: f.financed ? 'Financing quoted' : 'No financing',
        sort: f.financed ? '0' : '1',
      };
    case 'DISCOUNT_BAND': {
      const lab =
        f.discountPct <= 0 ? 'No discount' : band(f.discountPct, [5, 10, 15, 20, 25], '%');
      return { key: lab, label: lab, sort: String(f.discountPct).padStart(6, '0') };
    }
    case 'MARGIN_BAND': {
      const lab = band(f.marginPct, [20, 30, 40, 50, 60], '%');
      return { key: lab, label: lab, sort: String(Math.round(f.marginPct)).padStart(6, '0') };
    }
  }
}

function titleCase(v: string): string {
  return String(v || '')
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/* ----------------------------------------------------------------- filters */

function factPasses(f: Fact, d: ReportDefinition, basisDate: string | null): boolean {
  const fl = d.filters ?? {};
  // A report on "accepted in October" must exclude proposals that were never
  // accepted, not date them by something else. No basis date, no row.
  if (!basisDate) return false;
  if (d.from && basisDate.slice(0, 10) < d.from.slice(0, 10)) return false;
  if (d.to && basisDate.slice(0, 10) > d.to.slice(0, 10)) return false;
  if (fl.status?.length && !fl.status.includes(f.status)) return false;
  if (fl.repIds?.length && !fl.repIds.includes(f.repId)) return false;
  if (fl.customerIds?.length && !fl.customerIds.includes(f.customerId)) return false;
  if (fl.customerTypes?.length && !fl.customerTypes.includes(f.customerType)) return false;
  if (fl.regions?.length && !fl.regions.includes(f.region)) return false;
  if (fl.countries?.length && !fl.countries.includes(f.country)) return false;
  if (fl.financing === 'FINANCED' && !f.financed) return false;
  if (fl.financing === 'CASH' && f.financed) return false;
  if (fl.discountPctMin != null && f.discountPct < fl.discountPctMin) return false;
  if (fl.discountPctMax != null && f.discountPct > fl.discountPctMax) return false;
  if (fl.marginPctMin != null && f.marginPct < fl.marginPctMin) return false;
  if (fl.marginPctMax != null && f.marginPct > fl.marginPctMax) return false;
  return true;
}

function linePasses(l: FactLine, fl: ReportFilters): boolean {
  if (fl.optional === 'INCLUDED_ONLY' && l.optional) return false;
  if (fl.optional === 'OPTIONAL_ONLY' && !l.optional) return false;
  if (fl.categories?.length && !fl.categories.includes(l.category)) return false;
  if (fl.manufacturers?.length && !fl.manufacturers.includes(l.manufacturer)) return false;
  if (fl.proposalGroups?.length && !fl.proposalGroups.includes(l.proposalGroup)) return false;
  if (fl.productLike) {
    const needle = fl.productLike.trim().toLowerCase();
    if (needle) {
      const hay = `${l.sku} ${l.name}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
  }
  return true;
}

/** Whether a filter narrows to particular lines, which forces line grain. */
function hasLineFilter(fl: ReportFilters): boolean {
  return !!(
    fl.productLike?.trim() ||
    fl.categories?.length ||
    fl.manufacturers?.length ||
    fl.proposalGroups?.length ||
    (fl.optional && fl.optional !== 'ANY')
  );
}

/* --------------------------------------------------------------- the engine */

interface Bucket {
  cells: Cell[];
  proposals: Set<string>;
  wonProposals: Set<string>;
  lostProposals: Set<string>;
  proposalValue: number;
  wonValue: number;
  cogs: number;
  margin: number;
  units: number;
  lineValue: number;
  lines: number;
}

export function runReport(data: Dataset, def: ReportDefinition): ReportResult {
  const filters = def.filters ?? {};
  const groupBy = (def.groupBy?.length ? def.groupBy : (['MONTH'] as Dimension[])).slice(0, 3);
  const measures = def.measures?.length
    ? def.measures
    : (['PROPOSALS', 'PROPOSAL_VALUE'] as Measure[]);

  const needsLines =
    groupBy.some((g) => LINE_DIMS.includes(g)) ||
    measures.some((m) => LINE_MEASURES.includes(m)) ||
    hasLineFilter(filters);
  const notes: string[] = [];
  if (needsLines && (measures.includes('PROPOSAL_VALUE') || measures.includes('WON_VALUE'))) {
    notes.push(
      'Proposal value counts the whole proposal wherever one of its lines appears, so it does not sum to the company total down a product report. Line value is the per-line figure.',
    );
  }

  const basisField = BASIS_FIELD[def.dateBasis] ?? 'createdAt';
  const buckets = new Map<string, Bucket>();
  // Proposal-level money must land in a bucket once, not once per line.
  const seen = new Map<string, Set<string>>();
  let proposalsMatched = 0;

  for (const f of data.facts) {
    const basisDate = (f[basisField] as string | null) ?? null;
    if (!factPasses(f, def, basisDate)) continue;

    const matching = needsLines ? f.lines.filter((l) => linePasses(l, filters)) : f.lines;
    if (needsLines && !matching.length) continue;
    proposalsMatched++;

    const won = f.status === 'ACCEPTED';
    const lost = f.status === 'REJECTED';

    const addTo = (cells: Cell[], lines: FactLine[]): void => {
      const key = cells.map((c) => c.key).join('\u0000');
      let b = buckets.get(key);
      if (!b) {
        b = {
          cells,
          proposals: new Set(),
          wonProposals: new Set(),
          lostProposals: new Set(),
          proposalValue: 0,
          wonValue: 0,
          cogs: 0,
          margin: 0,
          units: 0,
          lineValue: 0,
          lines: 0,
        };
        buckets.set(key, b);
        seen.set(key, new Set());
      }
      const already = seen.get(key)!;
      if (!already.has(f.proposalId)) {
        already.add(f.proposalId);
        b.proposals.add(f.proposalId);
        b.proposalValue += f.totalMinor;
        b.cogs += f.cogsMinor;
        b.margin += f.marginMinor;
        if (won) {
          b.wonProposals.add(f.proposalId);
          b.wonValue += f.totalMinor;
        }
        if (lost) b.lostProposals.add(f.proposalId);
      }
      for (const l of lines) {
        b.units += l.qty;
        b.lineValue += l.amountMinor;
        b.lines++;
      }
    };

    if (needsLines) {
      // One bucket per line, so a proposal carrying two Soar frames of different
      // parts lands under both parts.
      for (const l of matching) {
        addTo(
          groupBy.map((g) => dimensionValue(g, f, l, basisDate)),
          [l],
        );
      }
    } else {
      addTo(
        groupBy.map((g) => dimensionValue(g, f, null, basisDate)),
        matching,
      );
    }
  }

  const value = (b: Bucket, m: Measure): number => {
    switch (m) {
      case 'PROPOSALS':
        return b.proposals.size;
      case 'LINES':
        return b.lines;
      case 'UNITS':
        return Math.round(b.units * 100) / 100;
      case 'LINE_VALUE':
        return b.lineValue;
      case 'PROPOSAL_VALUE':
        return b.proposalValue;
      case 'WON_PROPOSALS':
        return b.wonProposals.size;
      case 'WON_VALUE':
        return b.wonValue;
      case 'COGS':
        return b.cogs;
      case 'MARGIN':
        return b.margin;
      case 'MARGIN_PCT': {
        const rev = b.proposalValue;
        return rev ? Math.round((b.margin / rev) * 1000) / 10 : 0;
      }
      case 'AVG_PROPOSAL_VALUE':
        return b.proposals.size ? Math.round(b.proposalValue / b.proposals.size) : 0;
      case 'WIN_RATE': {
        const decided = b.wonProposals.size + b.lostProposals.size;
        return decided ? Math.round((b.wonProposals.size / decided) * 1000) / 10 : 0;
      }
    }
  };

  const columns: ReportColumn[] = [
    ...groupBy.map((g, i) => ({
      key: `d${i}`,
      label: DIM_LABEL[g],
      kind: 'text' as const,
      align: 'left' as const,
    })),
    ...measures.map((m) => ({
      key: m,
      label: MEASURE_DEF[m].label,
      kind: MEASURE_DEF[m].kind,
      align: 'right' as const,
    })),
  ];

  let rows = [...buckets.values()].map((b) => {
    const row: Record<string, string | number> = {};
    b.cells.forEach((c, i) => {
      row[`d${i}`] = c.label;
      row[`d${i}_sort`] = c.sort;
    });
    for (const m of measures) row[m] = value(b, m);
    return row;
  });

  // Default order: chronological when the first grouping is a date, otherwise the
  // biggest number first — which is the order someone reads a ranking in.
  const temporal = ['MONTH', 'QUARTER', 'YEAR', 'WEEK'].includes(groupBy[0]!);
  const sort = def.sort ?? {
    key: temporal ? 'd0_sort' : measures[0]!,
    dir: temporal ? ('asc' as const) : ('desc' as const),
  };
  const dir = sort.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
  });

  const truncated = !!def.limit && rows.length > def.limit;
  if (truncated) rows = rows.slice(0, def.limit!);

  const totals: Record<string, number> = {};
  // Totals are computed over the WHOLE result, not the visible page, and the two
  // rate measures are recomputed from their components rather than averaged — an
  // average of percentages is not a percentage of anything.
  const all = [...buckets.values()];
  for (const m of measures) {
    if (m === 'MARGIN_PCT') {
      const rev = all.reduce((a, b) => a + b.proposalValue, 0);
      const mar = all.reduce((a, b) => a + b.margin, 0);
      totals[m] = rev ? Math.round((mar / rev) * 1000) / 10 : 0;
    } else if (m === 'WIN_RATE') {
      const w = new Set(all.flatMap((b) => [...b.wonProposals])).size;
      const l = new Set(all.flatMap((b) => [...b.lostProposals])).size;
      totals[m] = w + l ? Math.round((w / (w + l)) * 1000) / 10 : 0;
    } else if (m === 'PROPOSALS' || m === 'WON_PROPOSALS') {
      const set = new Set(
        all.flatMap((b) => [...(m === 'PROPOSALS' ? b.proposals : b.wonProposals)]),
      );
      totals[m] = set.size;
    } else if (m === 'AVG_PROPOSAL_VALUE') {
      const set = new Set(all.flatMap((b) => [...b.proposals]));
      const v = all.reduce((a, b) => a + b.proposalValue, 0);
      totals[m] = set.size ? Math.round(v / set.size) : 0;
    } else {
      totals[m] = all.reduce((a, b) => a + value(b, m), 0);
    }
  }

  return {
    definition: { ...def, groupBy, measures },
    columns,
    rows,
    totals,
    chart: {
      labels: rows.map((r) => String(r.d0 ?? '')),
      series: measures.map((m) => ({
        key: m,
        label: MEASURE_DEF[m].label,
        kind: MEASURE_DEF[m].kind,
        values: rows.map((r) => Number(r[m]) || 0),
      })),
    },
    meta: {
      generatedAt: new Date().toISOString(),
      grain: needsLines ? 'LINE' : 'PROPOSAL',
      proposalsMatched,
      truncated,
      notes,
    },
  };
}

/** Everything the builder needs to draw its own controls, so the two never drift. */
export function reportVocabulary(): {
  bases: { id: DateBasis; label: string }[];
  dimensions: { id: Dimension; label: string; grain: 'PROPOSAL' | 'LINE' }[];
  measures: { id: Measure; label: string; kind: ReportColumn['kind'] }[];
} {
  return {
    bases: (Object.keys(BASIS_LABEL) as DateBasis[]).map((id) => ({ id, label: BASIS_LABEL[id] })),
    dimensions: (Object.keys(DIM_LABEL) as Dimension[]).map((id) => ({
      id,
      label: DIM_LABEL[id],
      grain: LINE_DIMS.includes(id) ? 'LINE' : 'PROPOSAL',
    })),
    measures: (Object.keys(MEASURE_DEF) as Measure[]).map((id) => ({
      id,
      label: MEASURE_DEF[id].label,
      kind: MEASURE_DEF[id].kind,
    })),
  };
}
