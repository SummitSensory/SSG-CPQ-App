import { ValidationError } from '../lib/errors.js';
import { versionTotals, metaOf, itemsOf, type Totals, type RawItem } from './analytics.js';

/**
 * Freight true-up — the pure half.
 *
 * SSG frequently sends a proposal before its vendors have quoted freight, and the
 * customer frequently signs it anyway. The freight figures arrive days later, by
 * which time the version is frozen, an operational order may exist, and a
 * QuickBooks invoice may already be out. Something has to be able to put the
 * freight back onto that document without pretending the customer signed a
 * different one.
 *
 * This module holds the money math and the safety property that makes the change
 * defensible: a true-up may move the freight buckets and NOTHING ELSE. Every
 * other component of the total — the product subtotal, the discount, the tax
 * pass-through, mats freight — is compared before and after, and a change in any
 * of them aborts the amendment. That is what stops "add the freight" from
 * becoming a back door into a signed price.
 *
 * Three buckets are in scope, because those are the three that go out blank:
 *
 *   THIRD_PARTY — per product line (`tpFreightMinor`). Third-party freight is a
 *                 property of the part, not the job: Southpaw quotes its own
 *                 shipping, so the figure lands on the lines it belongs to.
 *   STRUCTURE   — one amount on the proposal's meta (`structureFreightMinor`).
 *   STANDARD    — one opt-in amount on the meta (`stdFreightOn` + `stdFreightMinor`).
 *
 * Mats freight and the freight-tax pass-through are deliberately NOT here. They
 * are quoted at build time from the monday freight desk, and a true-up that could
 * reach them would be a general price editor with a freight label on it.
 *
 * No Prisma — the same contract as analytics.ts and priceEntry.ts.
 */

export const FREIGHT_BUCKETS = ['THIRD_PARTY', 'STRUCTURE', 'STANDARD'] as const;
export type FreightBucket = (typeof FREIGHT_BUCKETS)[number];

export const BUCKET_LABEL: Record<FreightBucket, string> = {
  THIRD_PARTY: 'Third-party freight',
  STRUCTURE: 'Structure freight',
  STANDARD: 'Standard freight',
};

const n = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;
const s = (v: unknown): string => (v == null ? '' : String(v));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

/** A line still missing its third-party freight. */
export interface ThirdPartyGapLine {
  ref: string;
  sku: string;
  name: string;
  quantity: number;
  vendor: string | null;
  currentMinor: number;
}

export interface FreightGaps {
  /** Lines from a freight-quoted vendor with no third-party freight on them. */
  thirdParty: ThirdPartyGapLine[];
  /** Structure freight is zero and no figure has been recorded. */
  structureMissing: boolean;
  /** Standard freight is switched on and still zero. */
  standardMissing: boolean;
  /** Wording currently printing in place of an amount, e.g. "TBD". */
  structureTbdText: string;
  buckets: FreightBucket[];
  /** True when anything at all is outstanding. */
  any: boolean;
}

export interface GapContext {
  /**
   * Part numbers whose vendor quotes freight separately — `Manufacturer.freightTbd`,
   * resolved by the caller. Only these lines can be a third-party gap: a part from a
   * vendor who ships freight-included has no missing figure, it has no figure.
   */
  freightTbdSkus?: Set<string>;
}

/**
 * What is still outstanding on a version.
 *
 * A zero is treated as outstanding rather than as an answer, which is the opposite
 * of the rule for line prices. It is the right way round for freight: nobody
 * deliberately quotes $0 of structure freight, and the cost of asking twice is a
 * question, while the cost of not asking is an unrecovered shipping bill.
 * "No freight applies" is recorded explicitly on the true-up instead.
 */
export function freightGaps(items: unknown, sections: unknown, ctx: GapContext = {}): FreightGaps {
  const meta = metaOf(sections);
  const lines = itemsOf(items);
  const tbd = ctx.freightTbdSkus;

  const thirdParty: ThirdPartyGapLine[] = [];
  lines.forEach((l, i) => {
    if ((l.lineType ?? 'PRODUCT') !== 'PRODUCT') return;
    const sku = s(l.sku).trim();
    if (!sku) return;
    if (tbd && !tbd.has(sku.toUpperCase())) return;
    if (n(l.tpFreightMinor) > 0) return;
    thirdParty.push({
      ref: s((l as RawItem & { ref?: string }).ref) || `line-${i}`,
      sku,
      name: s(l.name) || sku,
      quantity: n(l.quantity),
      vendor: null,
      currentMinor: n(l.tpFreightMinor),
    });
  });

  const t = versionTotals(items, sections);
  const structureMissing = t.structureFreight === 0;
  const standardMissing = !!meta.stdFreightOn && t.stdFreight === 0;

  const buckets: FreightBucket[] = [];
  if (thirdParty.length) buckets.push('THIRD_PARTY');
  if (structureMissing) buckets.push('STRUCTURE');
  if (standardMissing) buckets.push('STANDARD');

  return {
    thirdParty,
    structureMissing,
    standardMissing,
    structureTbdText: s(meta.tbdStructureFreight).trim(),
    buckets,
    any: buckets.length > 0,
  };
}

export interface TrueUpAmounts {
  /** Minor units. Undefined or null leaves the bucket alone. */
  structureFreightMinor?: number | null;
  stdFreightMinor?: number | null;
  thirdPartyLines?: Array<{ ref: string; amountMinor: number }>;
}

export interface BucketChange {
  bucket: FreightBucket;
  label: string;
  fromMinor: number;
  toMinor: number;
}

export interface AppliedContent {
  sections: unknown;
  items: unknown;
  before: Totals;
  after: Totals;
  deltaMinor: number;
  changes: BucketChange[];
}

const isMoney = (v: unknown): boolean =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.round(v) === v;

function assertMoney(v: unknown, what: string): number {
  if (!isMoney(v))
    throw new ValidationError(`${what} must be a whole number of cents, not below zero`);
  return v as number;
}

/**
 * Write staged freight onto a version's content and report the money movement.
 *
 * Returns new sections/items rather than mutating: the caller compares the two
 * totals, decides whether the change is legal, and only then writes. Nothing here
 * touches the database, so an amendment can be previewed on screen — with its real
 * before and after totals — before anyone commits to it.
 */
export function applyFreightAmounts(
  sections: unknown,
  items: unknown,
  amounts: TrueUpAmounts,
): AppliedContent {
  const before = versionTotals(items, sections);
  const nextSections = clone(sections) as unknown;
  const nextItems = clone(items) as unknown;

  if (!Array.isArray(nextItems))
    throw new ValidationError('This version has no line items to amend');
  if (!Array.isArray(nextSections))
    throw new ValidationError('This version has no sections to amend');

  const changes: BucketChange[] = [];

  // ---- third-party freight, per line
  const tp = amounts.thirdPartyLines ?? [];
  if (tp.length) {
    const byRef = new Map<string, Record<string, unknown>>();
    (nextItems as Array<Record<string, unknown>>).forEach((it, i) => {
      if (!it || typeof it !== 'object') return;
      const ref = s(it.ref) || `line-${i}`;
      byRef.set(ref, it);
    });
    for (const entry of tp) {
      const ref = s(entry.ref).trim();
      const line = byRef.get(ref);
      if (!line) {
        throw new ValidationError(
          `Line ${ref} is no longer on this proposal, so freight cannot be written to it. Re-open the freight entry to pick up the current lines.`,
        );
      }
      if (String(line.lineType ?? 'PRODUCT') !== 'PRODUCT') {
        throw new ValidationError(`Line ${ref} is not a product line and cannot carry freight`);
      }
      line.tpFreightMinor = assertMoney(entry.amountMinor, `Freight for ${s(line.name) || ref}`);
    }
  }

  // ---- the meta buckets
  const metaSection = (nextSections as Array<Record<string, unknown>>).find(
    (x) => x && typeof x === 'object' && x.id === 'meta',
  );
  if (
    (amounts.structureFreightMinor != null || amounts.stdFreightMinor != null) &&
    (!metaSection || typeof metaSection.data !== 'object' || metaSection.data == null)
  ) {
    throw new ValidationError(
      'This version has no proposal header section, so structure and standard freight have nowhere to go.',
    );
  }
  const metaData = (metaSection?.data ?? {}) as Record<string, unknown>;

  if (amounts.structureFreightMinor != null) {
    metaData.structureFreightMinor = assertMoney(
      amounts.structureFreightMinor,
      'Structure freight',
    );
    // The wording field prints in place of the amount. Left as "TBD" it would keep
    // printing TBD next to a real figure on the customer's document.
    if (s(metaData.tbdStructureFreight).trim()) metaData.tbdStructureFreight = '';
  }
  if (amounts.stdFreightMinor != null) {
    metaData.stdFreightMinor = assertMoney(amounts.stdFreightMinor, 'Standard freight');
    // Standard freight only counts while its box is ticked (see analytics.ts), so
    // entering an amount has to tick it or the money silently vanishes.
    metaData.stdFreightOn = true;
  }

  const after = versionTotals(nextItems, nextSections);

  if (after.tpFreight !== before.tpFreight)
    changes.push({
      bucket: 'THIRD_PARTY',
      label: BUCKET_LABEL.THIRD_PARTY,
      fromMinor: before.tpFreight,
      toMinor: after.tpFreight,
    });
  if (after.structureFreight !== before.structureFreight)
    changes.push({
      bucket: 'STRUCTURE',
      label: BUCKET_LABEL.STRUCTURE,
      fromMinor: before.structureFreight,
      toMinor: after.structureFreight,
    });
  if (after.stdFreight !== before.stdFreight)
    changes.push({
      bucket: 'STANDARD',
      label: BUCKET_LABEL.STANDARD,
      fromMinor: before.stdFreight,
      toMinor: after.stdFreight,
    });

  return {
    sections: nextSections,
    items: nextItems,
    before,
    after,
    deltaMinor: after.total - before.total,
    changes,
  };
}

/**
 * The guard that makes amending a signed proposal safe.
 *
 * Everything except the three freight buckets must be identical. It is checked on
 * the recomputed totals rather than by inspecting the edit, so it catches a change
 * arriving by any route — a stale draft posted from a second tab, a line quantity
 * that moved underneath, a discount that recalculated.
 */
export function assertFreightOnlyChange(before: Totals, after: Totals): void {
  const fields: Array<[keyof Totals, string]> = [
    ['subtotal', 'the product subtotal'],
    ['discount', 'the discount'],
    ['tax', 'the freight tax pass-through'],
    ['matsFreight', 'mats & padding freight'],
    ['cogs', 'the cost of goods'],
  ];
  const moved = fields.filter(([k]) => before[k] !== after[k]);
  if (moved.length) {
    throw new ValidationError(
      `A freight true-up may only change freight. This change also moves ${moved
        .map(([, label]) => label)
        .join(
          ', ',
        )}. Nothing has been written. Create a new proposal version for a change of that kind.`,
    );
  }
}

/** Sum of a staged third-party set, for the queue and the audit line. */
export function thirdPartyTotal(
  lines: Array<{ amountMinor?: unknown }> | null | undefined,
): number {
  if (!Array.isArray(lines)) return 0;
  return lines.reduce((a, l) => a + n(l?.amountMinor), 0);
}

/** Whole days between two instants, floored at zero. */
export function ageInDays(from: Date | string | null | undefined, now: Date = new Date()): number {
  if (!from) return 0;
  const t = from instanceof Date ? from.getTime() : new Date(from).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export const ESCALATION_DAYS = 5;

export type FreightUrgency = 'NEW' | 'AGEING' | 'ESCALATED';

/**
 * How loudly a gap should announce itself. Five days is the threshold SSG set:
 * long enough that a vendor has had a fair chance to answer, short enough that the
 * job has not shipped.
 */
export function urgencyFor(ageDays: number, threshold: number = ESCALATION_DAYS): FreightUrgency {
  if (ageDays >= threshold) return 'ESCALATED';
  if (ageDays >= Math.max(1, Math.floor(threshold / 2))) return 'AGEING';
  return 'NEW';
}

/** One-line summary of a true-up's money movement, for audit details and email. */
export function describeChanges(changes: BucketChange[], deltaMinor: number): string {
  const money = (v: number): string =>
    `$${(v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const parts = changes.map((c) => `${c.label} ${money(c.fromMinor)} → ${money(c.toMinor)}`);
  return `${parts.join('; ')} (total ${deltaMinor >= 0 ? '+' : '−'}${money(Math.abs(deltaMinor))})`;
}
