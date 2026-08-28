/**
 * The reporting dataset: one read of the world, shaped for aggregation.
 *
 * Every insights endpoint — the signed-deals chart, the report builder, the goals
 * screen — runs off this one function. That is the point: two endpoints that read
 * the database separately eventually disagree with each other, and a disagreement
 * between two reports is worse than either being slightly out of date.
 *
 * What a fact is
 * --------------
 * One row per proposal (its latest version), carrying the milestone dates and the
 * money, with its product lines nested. The report engine walks lines and rolls
 * them up; nothing else in here knows what a grouping is.
 *
 * Milestones
 * ----------
 * Four, because "signed" means four different things to four people:
 *
 *   acceptedAt      the customer said yes — the ACCEPTED status event
 *   orderedAt       an accepted order exists and is locked
 *   depositPaidAt   the first QuickBooks payment landed against the invoice
 *   paidInFullAt    the last payment on an invoice QuickBooks calls PAID
 *
 * They are read from four different sources on purpose. A proposal marked accepted
 * with no order is a real state, and so is an order whose deposit never arrived; a
 * single "signed date" column would hide both.
 *
 * Money is never recomputed here. versionTotals() in proposals/analytics.ts is the
 * one implementation of proposal arithmetic in this codebase, and it is what the
 * printed document, the price snapshot and QuickBooks all agree with.
 */
import { prisma } from '../lib/prisma.js';
import { itemsOf, metaOf, versionTotals, type RawItem } from '../proposals/analytics.js';

export interface FactLine {
  sku: string;
  name: string;
  /** Sku.category, or 'UNCATEGORISED' when the part is not in the catalog. */
  category: string;
  manufacturer: string;
  /** Sku.proposalGroup — the tier heading the builder files this part under. */
  proposalGroup: string;
  optional: boolean;
  qty: number;
  rateMinor: number;
  amountMinor: number;
  costMinor: number;
}

export interface Fact {
  proposalId: string;
  number: string;
  title: string;
  status: string;
  version: number;

  customerId: string;
  customer: string;
  customerType: string;
  region: string;
  country: string;

  repId: string;
  rep: string;

  /** Milestone dates, ISO or null. See the file comment. */
  createdAt: string;
  releasedAt: string | null;
  decidedAt: string | null;
  acceptedAt: string | null;
  orderedAt: string | null;
  depositPaidAt: string | null;
  paidInFullAt: string | null;

  totalMinor: number;
  revenueMinor: number;
  cogsMinor: number;
  marginMinor: number;
  marginPct: number;
  discountPct: number;
  /** A financing sheet was quoted from a rate card on this version. */
  financed: boolean;

  lines: FactLine[];
}

export interface Dataset {
  facts: Fact[];
  builtAt: string;
  reps: { id: string; name: string }[];
  customers: { id: string; name: string }[];
  categories: string[];
  manufacturers: string[];
  proposalGroups: string[];
  regions: string[];
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * A bundle child ("— Obie Mobile Cart") is not a product anyone ordered — it is a
 * part list under a priced line. Counted as a line it doubles the unit count of
 * every bundle, so it is dropped here, the same way analytics.ts drops it from
 * revenue.
 */
const isBundleChild = (l: RawItem): boolean => /^\u2014\s/.test(String(l.name ?? ''));

/**
 * In-process cache.
 *
 * The report builder is interactive: changing a grouping re-runs the query, and
 * re-reading every proposal for each keystroke would make the screen unusable and
 * the database unhappy. Sixty seconds is short enough that nobody watches a stale
 * figure for long and long enough that a session of tinkering costs one read.
 *
 * Per serverless instance, so it is a cache and not a source of truth. `force`
 * exists for the cron, which should never work from someone else's warm cache.
 */
let cache: { at: number; data: Dataset } | null = null;
const CACHE_MS = 60_000;

export async function buildDataset(force = false): Promise<Dataset> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;

  const [proposals, orgs, addresses, users, skus, orders, txns] = await Promise.all([
    prisma.proposal.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        number: true,
        title: true,
        organizationId: true,
        createdById: true,
        createdAt: true,
        versions: {
          orderBy: { version: 'desc' },
          select: {
            id: true,
            version: true,
            status: true,
            sections: true,
            items: true,
            releasedAt: true,
            financeRateCardId: true,
            createdAt: true,
            statusHistory: {
              orderBy: { createdAt: 'asc' },
              select: { toStatus: true, createdAt: true },
            },
          },
        },
      },
    }),
    prisma.organization.findMany({ select: { id: true, name: true, customerType: true } }),
    prisma.address.findMany({
      where: { type: 'BILLING' },
      orderBy: { id: 'asc' },
      select: { organizationId: true, region: true, country: true },
    }),
    prisma.user.findMany({ select: { id: true, name: true, email: true } }),
    prisma.sku.findMany({
      select: {
        part: true,
        category: true,
        manufacturer: true,
        proposalGroup: true,
      },
    }),
    prisma.acceptedOrder.findMany({
      select: { proposalId: true, acceptedAt: true, createdAt: true },
    }),
    prisma.qboTransaction.findMany({
      where: { type: { in: ['INVOICE', 'DEPOSIT_INVOICE', 'PROGRESS_INVOICE', 'FINAL_INVOICE'] } },
      select: {
        proposalId: true,
        qboStatus: true,
        balanceMinor: true,
        payments: { orderBy: { txnDate: 'asc' }, select: { txnDate: true } },
      },
    }),
  ]);

  const orgById = new Map(orgs.map((o) => [o.id, o]));
  // First billing address per organization, in the same id order the cross-border
  // jurisdiction check uses, so the two never disagree about which address counts.
  const addrByOrg = new Map<string, { region: string | null; country: string | null }>();
  for (const a of addresses)
    if (!addrByOrg.has(a.organizationId)) addrByOrg.set(a.organizationId, a);
  const userById = new Map(users.map((u) => [u.id, u.name || u.email]));
  const skuByPart = new Map(skus.map((s) => [s.part.trim().toUpperCase(), s]));

  const orderedAt = new Map<string, string>();
  for (const o of orders) {
    const at = iso(o.acceptedAt ?? o.createdAt);
    if (!at) continue;
    const prev = orderedAt.get(o.proposalId);
    if (!prev || at < prev) orderedAt.set(o.proposalId, at);
  }

  const depositPaidAt = new Map<string, string>();
  const paidInFullAt = new Map<string, string>();
  for (const t of txns) {
    const dates = t.payments.map((p) => iso(p.txnDate)).filter((d): d is string => !!d);
    if (!dates.length) continue;
    const first = dates[0]!;
    const prev = depositPaidAt.get(t.proposalId);
    if (!prev || first < prev) depositPaidAt.set(t.proposalId, first);

    // Paid in full is QuickBooks' own verdict, not our arithmetic: PAID, or a zero
    // balance where the status column has not been written yet.
    const settled =
      String(t.qboStatus ?? '').toUpperCase() === 'PAID' ||
      (t.balanceMinor != null && Number(t.balanceMinor) === 0);
    if (settled) {
      const last = dates[dates.length - 1]!;
      const cur = paidInFullAt.get(t.proposalId);
      if (!cur || last > cur) paidInFullAt.set(t.proposalId, last);
    }
  }

  const facts: Fact[] = [];
  for (const p of proposals) {
    const v = p.versions[0];
    if (!v) continue;
    const t = versionTotals(v.items, v.sections);
    const meta = metaOf(v.sections) as { discountPct?: number };
    const org = orgById.get(p.organizationId);
    const addr = addrByOrg.get(p.organizationId);

    // The decision event, and specifically the acceptance. Read from history rather
    // than from the status column so a proposal that was accepted and then revised
    // still reports when it was accepted.
    let acceptedAt: string | null = null;
    let decidedAt: string | null = null;
    for (const ver of p.versions) {
      for (const e of ver.statusHistory) {
        const at = iso(e.createdAt);
        if (!at) continue;
        if (e.toStatus === 'ACCEPTED' && (!acceptedAt || at < acceptedAt)) acceptedAt = at;
        if (
          (e.toStatus === 'ACCEPTED' || e.toStatus === 'REJECTED' || e.toStatus === 'EXPIRED') &&
          (!decidedAt || at < decidedAt)
        ) {
          decidedAt = at;
        }
      }
    }

    const lines: FactLine[] = [];
    for (const l of itemsOf(v.items)) {
      if ((l.lineType ?? 'PRODUCT') !== 'PRODUCT') continue;
      if (isBundleChild(l)) continue;
      const part = String(l.sku ?? '').trim();
      const cat = part ? skuByPart.get(part.toUpperCase()) : undefined;
      const qty = n(l.quantity);
      lines.push({
        sku: part || '—',
        name: String(l.name ?? '').trim() || '(unnamed line)',
        category: (cat?.category ?? 'UNCATEGORISED').trim() || 'UNCATEGORISED',
        manufacturer: (cat?.manufacturer ?? '').trim() || 'Unspecified',
        proposalGroup: (cat?.proposalGroup ?? '').trim() || 'Unfiled',
        optional: !!(l as { optional?: boolean }).optional,
        qty,
        rateMinor: n(l.rateMinor),
        amountMinor: Math.round(qty * n(l.rateMinor)),
        costMinor: Math.round(qty * n(l.costEach)),
      });
    }

    facts.push({
      proposalId: p.id,
      number: p.number,
      title: p.title,
      status: String(v.status),
      version: v.version,
      customerId: p.organizationId,
      customer: org?.name ?? '—',
      customerType: String(org?.customerType ?? 'OTHER'),
      region: (addr?.region ?? '').trim() || 'Unknown',
      country: (addr?.country ?? '').trim() || 'Unknown',
      repId: p.createdById,
      rep: userById.get(p.createdById) ?? '—',
      createdAt: iso(p.createdAt)!,
      releasedAt: iso(v.releasedAt),
      decidedAt,
      acceptedAt,
      orderedAt: orderedAt.get(p.id) ?? null,
      depositPaidAt: depositPaidAt.get(p.id) ?? null,
      paidInFullAt: paidInFullAt.get(p.id) ?? null,
      totalMinor: t.total,
      revenueMinor: t.revenue,
      cogsMinor: t.cogs,
      marginMinor: t.margin,
      marginPct: t.marginPct,
      discountPct: n(meta.discountPct),
      financed: !!v.financeRateCardId,
      lines,
    });
  }

  const uniq = (xs: string[]): string[] => [...new Set(xs.filter(Boolean))].sort();
  const data: Dataset = {
    facts,
    builtAt: new Date().toISOString(),
    reps: [...new Set(facts.map((f) => f.repId))]
      .map((id) => ({ id, name: userById.get(id) ?? '—' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    customers: [...new Map(facts.map((f) => [f.customerId, f.customer])).entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    categories: uniq(facts.flatMap((f) => f.lines.map((l) => l.category))),
    manufacturers: uniq(facts.flatMap((f) => f.lines.map((l) => l.manufacturer))),
    proposalGroups: uniq(facts.flatMap((f) => f.lines.map((l) => l.proposalGroup))),
    regions: uniq(facts.map((f) => f.region)),
  };

  cache = { at: Date.now(), data };
  return data;
}

/** Drop the cache. Called after anything that changes proposals materially. */
export function invalidateDataset(): void {
  cache = null;
}
