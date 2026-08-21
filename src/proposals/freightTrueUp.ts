import { ValidationError } from '../lib/errors.js';
import { versionTotals, metaOf, itemsOf, type Totals, type RawItem } from './analytics.js';

/**
 * Freight true-up — the pure half.
 *
 * SSG sends proposals before its vendors have quoted freight, and customers sign
 * them anyway. The freight arrives days or weeks later, by which time the version is
 * frozen, manufacturing has started, and a QuickBooks invoice may be out. This
 * module holds the money math for putting that freight back onto the document
 * without pretending the customer signed a different one.
 *
 * FOUR buckets, because freight reaches Summit four different ways:
 *
 *   STEEL       — the structure. Quoted on the monday deal board and read from it;
 *                 one job-level amount (`structureFreightMinor`).
 *   MATS        — floor padding. Also quoted on the board, its own column; one
 *                 job-level amount (`matsFreightMinor`).
 *   THERAPEUTIC — equipment and accessories. Entered by hand, against the product
 *                 items it covers, because a vendor quotes shipping on their own
 *                 parts (`tpFreightMinor` per line).
 *   OTHER       — anything else, entered by hand, either against product items or
 *                 as one job-level amount with a description (`stdFreightMinor`).
 *                 This is the bucket the old "standard freight" became; amounts
 *                 already recorded under that name are read and shown unchanged.
 *
 * The safety property that makes amending a signed proposal defensible: a true-up
 * may move the freight buckets and NOTHING ELSE. The product subtotal, the discount,
 * the freight-tax pass-through and the cost of goods are compared before and after,
 * and a change in any of them aborts the amendment. That is what stops "add the
 * freight" from becoming a back door into a signed price.
 *
 * The mats TAX pass-through is deliberately outside every bucket. monday quotes it
 * next to the mats freight and this module reports it so nobody has to go looking,
 * but it is a tax figure: moving it would make the guard above meaningless. It needs
 * a new proposal version.
 *
 * No Prisma — the same contract as analytics.ts and priceEntry.ts.
 */

export const FREIGHT_BUCKETS = ['STEEL', 'MATS', 'THERAPEUTIC', 'OTHER'] as const;
export type FreightBucket = (typeof FREIGHT_BUCKETS)[number];

/** Where a bucket's figure comes from. Decides whether the form types or reads. */
export type FreightSource = 'MONDAY' | 'MANUAL';

/** What one entry covers: the whole job, or a chosen set of product items. */
export type FreightScope = 'JOB' | 'LINES';

export interface BucketSpec {
  label: string;
  /** Shorter form, for the estimate line and the queue chips. */
  short: string;
  source: FreightSource;
  /** The scopes an entry in this bucket may use; the first is the default. */
  scopes: FreightScope[];
  /** Where a job-level amount lands on the version's meta, if anywhere. */
  metaField: 'structureFreightMinor' | 'matsFreightMinor' | 'stdFreightMinor' | null;
  /** The wording field that prints in place of the amount ("TBD"). */
  tbdField: 'tbdStructureFreight' | 'tbdMatsFreight' | null;
  /** The totals component this bucket moves. */
  totalsKey: keyof Pick<Totals, 'structureFreight' | 'matsFreight' | 'tpFreight' | 'stdFreight'>;
  help: string;
}

export const BUCKETS: Record<FreightBucket, BucketSpec> = {
  STEEL: {
    label: 'Steel freight',
    short: 'Steel',
    source: 'MONDAY',
    scopes: ['JOB'],
    metaField: 'structureFreightMinor',
    tbdField: 'tbdStructureFreight',
    totalsKey: 'structureFreight',
    help: 'Read from the deal board. One amount for the structure shipment.',
  },
  MATS: {
    label: 'Mats & padding freight',
    short: 'Mats',
    source: 'MONDAY',
    scopes: ['JOB'],
    metaField: 'matsFreightMinor',
    tbdField: 'tbdMatsFreight',
    totalsKey: 'matsFreight',
    help: 'Read from the deal board. One amount for the padding shipment.',
  },
  THERAPEUTIC: {
    label: 'Therapeutic equipment & accessories freight',
    short: 'Therapeutic',
    source: 'MANUAL',
    scopes: ['LINES'],
    metaField: null,
    tbdField: null,
    totalsKey: 'tpFreight',
    help: 'Entered by hand against the items it covers. Pick the items, enter one amount.',
  },
  OTHER: {
    label: 'Other freight',
    short: 'Other',
    source: 'MANUAL',
    scopes: ['JOB', 'LINES'],
    metaField: 'stdFreightMinor',
    tbdField: null,
    totalsKey: 'stdFreight',
    help: 'Anything the other three do not cover. Needs a description saying what it is for.',
  },
};

export const BUCKET_LABEL: Record<FreightBucket, string> = {
  STEEL: BUCKETS.STEEL.label,
  MATS: BUCKETS.MATS.label,
  THERAPEUTIC: BUCKETS.THERAPEUTIC.label,
  OTHER: BUCKETS.OTHER.label,
};

/**
 * "Standard freight" was this application's name for the fourth bucket until ops
 * pointed out that nothing about it was standard. Records written under the old name
 * are the same money in the same meta field, so they read straight through — this
 * map exists only so an old audit row, an old snapshot key or an old API caller
 * still resolves to a bucket.
 */
const LEGACY_BUCKET: Record<string, FreightBucket> = {
  STANDARD: 'OTHER',
  STRUCTURE: 'STEEL',
  THIRD_PARTY: 'THERAPEUTIC',
};

export function normalizeBucket(value: unknown): FreightBucket | null {
  const key = String(value ?? '')
    .trim()
    .toUpperCase();
  if ((FREIGHT_BUCKETS as readonly string[]).includes(key)) return key as FreightBucket;
  return LEGACY_BUCKET[key] ?? null;
}

const n = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;
const s = (v: unknown): string => (v == null ? '' : String(v));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

const money = (v: number): string =>
  `$${(v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ────────────────────────── the product items ────────────────────────── */

/**
 * A product item freight can be attached to.
 *
 * Every product line is listed, not only the ones with a gap. The screenshot this
 * replaced showed a bare "Structure freight / 0.00" box with no indication of what
 * was being shipped — ops could not tell which job's swing they were pricing. Even
 * for steel and mats, where the amount is one job-level figure off the board, the
 * items are shown so the person approving it can see what the shipment contains.
 */
export interface FreightLine {
  ref: string;
  sku: string;
  name: string;
  quantity: number;
  vendor: string | null;
  /** Extended price, minor units — the weight used to apportion a shared amount. */
  extendedMinor: number;
  /** Freight already on this line. */
  currentMinor: number;
  /** The vendor quotes freight separately, so this line is expected to carry some. */
  freightQuoted: boolean;
}

export interface LineContext {
  /**
   * Part numbers whose vendor quotes freight separately (`Manufacturer.freightTbd`
   * / `rfqEnabled`), resolved by the caller. Used to mark which lines are EXPECTED
   * to carry freight — not to hide the others.
   */
  freightQuotedSkus?: Set<string>;
  /** Part number → vendor name, so a row can say whose freight it is. */
  vendorBySku?: Map<string, string>;
}

/** Every product line on a version, in document order. */
export function freightLines(items: unknown, ctx: LineContext = {}): FreightLine[] {
  const out: FreightLine[] = [];
  itemsOf(items).forEach((l, i) => {
    if ((l.lineType ?? 'PRODUCT') !== 'PRODUCT') return;
    const sku = s(l.sku).trim();
    const key = sku.toUpperCase();
    const qty = n(l.quantity);
    const unit = n((l as RawItem & { unitPriceMinor?: unknown }).unitPriceMinor);
    out.push({
      ref: s((l as RawItem & { ref?: string }).ref) || `line-${i}`,
      sku,
      name: s(l.name) || sku || `Line ${i + 1}`,
      quantity: qty,
      vendor: (sku && ctx.vendorBySku?.get(key)) || null,
      extendedMinor: Math.max(0, Math.round(unit * (qty || 1))),
      currentMinor: n(l.tpFreightMinor),
      freightQuoted: !!sku && !!ctx.freightQuotedSkus?.has(key),
    });
  });
  return out;
}

/* ────────────────────────── what is outstanding ────────────────────────── */

export interface BucketGap {
  bucket: FreightBucket;
  label: string;
  source: FreightSource;
  /** Amount currently on the proposal for this bucket. */
  currentMinor: number;
  /** Wording printing in place of an amount, e.g. "TBD". */
  tbdText: string;
  /** Product lines expected to carry freight and still at zero (THERAPEUTIC only). */
  lines: FreightLine[];
}

export interface FreightGaps {
  buckets: FreightBucket[];
  byBucket: Record<FreightBucket, BucketGap>;
  /** Lines expected to carry therapeutic freight and still at zero. */
  gapLines: FreightLine[];
  any: boolean;
}

/**
 * What is still outstanding on a version.
 *
 * A zero counts as outstanding rather than as an answer — the opposite of the rule
 * for line prices, and the right way round for freight: nobody deliberately quotes
 * $0 of steel freight, the cost of asking twice is a question, and the cost of not
 * asking is an unrecovered shipping bill. "No freight applies" is recorded
 * explicitly against the bucket instead.
 *
 * OTHER is the exception. It is opt-in by nature, so it is only outstanding when
 * someone has switched it on and left it at zero.
 */
export function freightGaps(items: unknown, sections: unknown, ctx: LineContext = {}): FreightGaps {
  const meta = metaOf(sections);
  const t = versionTotals(items, sections);
  const lines = freightLines(items, ctx);
  const gapLines = lines.filter((l) => l.freightQuoted && l.currentMinor === 0);

  const byBucket = {} as Record<FreightBucket, BucketGap>;
  const buckets: FreightBucket[] = [];

  for (const bucket of FREIGHT_BUCKETS) {
    const spec = BUCKETS[bucket];
    const currentMinor = t[spec.totalsKey];
    const tbdText = spec.tbdField ? s(meta[spec.tbdField]).trim() : '';
    const missing =
      bucket === 'THERAPEUTIC'
        ? gapLines.length > 0
        : bucket === 'OTHER'
          ? !!meta.stdFreightOn && currentMinor === 0
          : currentMinor === 0;

    byBucket[bucket] = {
      bucket,
      label: spec.label,
      source: spec.source,
      currentMinor,
      tbdText,
      lines: bucket === 'THERAPEUTIC' ? gapLines : [],
    };
    if (missing) buckets.push(bucket);
  }

  return { buckets, byBucket, gapLines, any: buckets.length > 0 };
}

/* ────────────────────────── apportionment ────────────────────────── */

export interface Allocation {
  ref: string;
  amountMinor: number;
}

/**
 * Split one amount across the chosen product items.
 *
 * Ops asked to enter a single figure over a selection — a vendor quotes "$1,840 to
 * ship the swing, the platform and the crash pad", not a figure per part. The split
 * has to happen somewhere, because freight lives on the line, so it happens here:
 * pro-rata on extended price, largest-remainder, deterministic. Whole cents, and the
 * parts always sum to the whole.
 *
 * Equal weight when the selection has no price to go on (a $0 line, a swap-out),
 * which is the only sane reading of "split this evenly".
 */
export function apportion(
  amountMinor: number,
  lines: Array<{ ref: string; extendedMinor: number }>,
): Allocation[] {
  if (!lines.length) throw new ValidationError('Pick at least one item for this freight to go on');
  const total = assertMoney(amountMinor, 'Freight');
  const weights = lines.map((l) => Math.max(0, Math.round(n(l.extendedMinor))));
  const sum = weights.reduce((a, b) => a + b, 0);
  const basis = sum > 0 ? weights : lines.map(() => 1);
  const basisSum = basis.reduce((a, b) => a + b, 0);

  const exact = basis.map((w) => (total * w) / basisSum);
  const floors = exact.map((v) => Math.floor(v));
  let left = total - floors.reduce((a, b) => a + b, 0);

  // Largest fractional remainder first; ties by descending weight, then by position,
  // so the same selection and the same amount always split the same way.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v), w: basis[i]! }))
    .sort((a, b) => b.frac - a.frac || b.w - a.w || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    floors[o.i] = floors[o.i]! + 1;
    left -= 1;
  }
  return lines.map((l, i) => ({ ref: l.ref, amountMinor: floors[i]! }));
}

/* ────────────────────────── applying ────────────────────────── */

/** One answered amount, as the service holds it. */
export interface FreightEntryInput {
  bucket: FreightBucket;
  scope: FreightScope;
  amountMinor: number;
  /** For a LINES entry: the items it covers, with the split already computed. */
  allocations?: Allocation[];
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
 * Write answered freight onto a version's content and report the money movement.
 *
 * Returns new sections/items rather than mutating: the caller compares the two
 * totals, decides whether the change is legal, and only then writes. Nothing here
 * touches the database, so an amendment can be previewed on screen — with its real
 * before and after totals — before anyone commits to it.
 *
 * Line-level amounts ADD to what a line already carries. Two vendors can each quote
 * freight against the same item weeks apart, and the second quote is not a
 * correction of the first — treating it as one silently discarded money.
 */
export function applyFreightEntries(
  sections: unknown,
  items: unknown,
  entries: FreightEntryInput[],
): AppliedContent {
  const before = versionTotals(items, sections);
  const nextSections = clone(sections) as unknown;
  const nextItems = clone(items) as unknown;

  if (!Array.isArray(nextItems))
    throw new ValidationError('This version has no line items to amend');
  if (!Array.isArray(nextSections))
    throw new ValidationError('This version has no sections to amend');

  const byRef = new Map<string, Record<string, unknown>>();
  (nextItems as Array<Record<string, unknown>>).forEach((it, i) => {
    if (!it || typeof it !== 'object') return;
    byRef.set(s(it.ref) || `line-${i}`, it);
  });

  const metaSection = (nextSections as Array<Record<string, unknown>>).find(
    (x) => x && typeof x === 'object' && x.id === 'meta',
  );
  const needsMeta = entries.some((e) => e.scope === 'JOB');
  if (
    needsMeta &&
    (!metaSection || typeof metaSection.data !== 'object' || metaSection.data == null)
  ) {
    throw new ValidationError(
      'This version has no proposal header section, so a job-level freight amount has nowhere to go.',
    );
  }
  const metaData = (metaSection?.data ?? {}) as Record<string, unknown>;

  // Job-level buckets are SUMMED before they are written: two amounts in the same
  // bucket are two shipments, and the meta field holds one figure.
  const jobTotals = new Map<FreightBucket, number>();

  for (const entry of entries) {
    const bucket = normalizeBucket(entry.bucket);
    if (!bucket) throw new ValidationError(`"${entry.bucket}" is not a freight bucket`);
    const spec = BUCKETS[bucket];
    if (!spec.scopes.includes(entry.scope)) {
      throw new ValidationError(
        `${spec.label} cannot be entered ${entry.scope === 'JOB' ? 'as one job amount' : 'against individual items'}`,
      );
    }

    if (entry.scope === 'LINES') {
      const allocations = entry.allocations ?? [];
      if (!allocations.length) throw new ValidationError(`${spec.label} has no items to go on`);
      const sum = allocations.reduce((a, x) => a + assertMoney(x.amountMinor, spec.label), 0);
      if (sum !== assertMoney(entry.amountMinor, spec.label)) {
        throw new ValidationError(
          `${spec.label}: the split across the items comes to ${money(sum)} but the amount entered is ${money(entry.amountMinor)}.`,
        );
      }
      for (const alloc of allocations) {
        const line = byRef.get(s(alloc.ref).trim());
        if (!line) {
          throw new ValidationError(
            `Item ${alloc.ref} is no longer on this proposal, so freight cannot be written to it. Re-open the freight panel to pick up the current items.`,
          );
        }
        if (String(line.lineType ?? 'PRODUCT') !== 'PRODUCT') {
          throw new ValidationError(
            `Item ${alloc.ref} is not a product line and cannot carry freight`,
          );
        }
        line.tpFreightMinor = n(line.tpFreightMinor) + alloc.amountMinor;
      }
      continue;
    }

    if (!spec.metaField) throw new ValidationError(`${spec.label} has no job-level field`);
    jobTotals.set(
      bucket,
      (jobTotals.get(bucket) ?? 0) + assertMoney(entry.amountMinor, spec.label),
    );
  }

  for (const [bucket, added] of jobTotals) {
    const spec = BUCKETS[bucket];
    const field = spec.metaField!;
    metaData[field] = n(metaData[field]) + added;
    // The wording field prints in place of the amount. Left as "TBD" it would keep
    // printing TBD next to a real figure on the customer's document.
    if (spec.tbdField && s(metaData[spec.tbdField]).trim()) metaData[spec.tbdField] = '';
    // Other freight only counts while its box is ticked (see analytics.ts), so
    // entering an amount has to tick it or the money silently vanishes.
    if (bucket === 'OTHER') metaData.stdFreightOn = true;
  }

  const after = versionTotals(nextItems, nextSections);
  const changes: BucketChange[] = [];
  for (const bucket of FREIGHT_BUCKETS) {
    const key = BUCKETS[bucket].totalsKey;
    if (after[key] !== before[key]) {
      changes.push({
        bucket,
        label: BUCKETS[bucket].label,
        fromMinor: before[key],
        toMinor: after[key],
      });
    }
  }

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
 * Everything except the four freight buckets must be identical. Checked on the
 * recomputed totals rather than by inspecting the edit, so it catches a change
 * arriving by any route — a stale form posted from a second tab, a line quantity
 * that moved underneath, a discount that recalculated.
 *
 * The freight TAX pass-through is on this list even though monday quotes it beside
 * the mats freight. It is tax: it belongs to the document the customer signed, and
 * a freight true-up that could move it would be a price editor wearing a freight
 * label.
 */
export function assertFreightOnlyChange(before: Totals, after: Totals): void {
  const fields: Array<[keyof Totals, string]> = [
    ['subtotal', 'the product subtotal'],
    ['discount', 'the discount'],
    ['tax', 'the freight tax pass-through'],
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

/* ────────────────────────── evidence ────────────────────────── */

export interface EvidenceInput {
  bucket: FreightBucket;
  scope: FreightScope;
  amountMinor: number;
  source: FreightSource;
  vendorQuoteRef?: string | null;
  quoteAttachmentId?: string | null;
  description?: string | null;
  /** Required when a monday-sourced bucket is typed in by hand. */
  overrideReason?: string | null;
}

/**
 * What has to be true before an amount can be saved.
 *
 * Evidence is required as soon as there is money: a freight figure with no source
 * behind it is somebody's recollection, and it gets defended to a customer months
 * later. The rules differ per bucket because the sources differ.
 */
export function assertEvidence(input: EvidenceInput): void {
  const spec = BUCKETS[input.bucket];
  const amount = assertMoney(input.amountMinor, spec.label);
  if (amount === 0) return;

  if (spec.source === 'MONDAY' && input.source === 'MANUAL') {
    const reason = s(input.overrideReason).trim();
    if (reason.length < 5) {
      throw new ValidationError(
        `${spec.label} normally comes off the deal board. To type it in, say why in one line — that reason is kept with the figure.`,
      );
    }
    return;
  }
  if (spec.source === 'MONDAY') return; // read from the board; the board IS the evidence

  const ref = s(input.vendorQuoteRef).trim();
  if (!ref && !input.quoteAttachmentId) {
    throw new ValidationError(
      `Give the vendor quote reference for ${spec.label.toLowerCase()}, or attach the quote, before saving an amount.`,
    );
  }
  if (input.bucket === 'OTHER' && input.scope === 'JOB' && s(input.description).trim().length < 3) {
    throw new ValidationError(
      'Say what the other freight is for — the description prints on the estimate.',
    );
  }
}

/* ────────────────────────── age and urgency ────────────────────────── */

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
 * How loudly a gap should announce itself. Five days is the threshold SSG set: long
 * enough that a vendor has had a fair chance to answer, short enough that the job
 * has not shipped.
 */
export function urgencyFor(ageDays: number, threshold: number = ESCALATION_DAYS): FreightUrgency {
  if (ageDays >= threshold) return 'ESCALATED';
  if (ageDays >= Math.max(1, Math.floor(threshold / 2))) return 'AGEING';
  return 'NEW';
}

/**
 * How long an acknowledged alert stays quiet.
 *
 * The banner for an invoice that is short of freight can be dismissed, because
 * somebody has to be able to read the screen underneath it. It cannot be dismissed
 * permanently: an unbilled freight bill does not stop being one because it was
 * clicked away, so it returns the next day until the freight is on the invoice or
 * somebody records that none applies.
 */
export const ALERT_QUIET_HOURS = 24;

export function alertIsQuiet(
  ackAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!ackAt) return false;
  const t = ackAt instanceof Date ? ackAt.getTime() : new Date(ackAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < ALERT_QUIET_HOURS * 3_600_000;
}

/** One-line summary of a true-up's money movement, for audit details and email. */
export function describeChanges(changes: BucketChange[], deltaMinor: number): string {
  const parts = changes.map((c) => `${c.label} ${money(c.fromMinor)} → ${money(c.toMinor)}`);
  return `${parts.join('; ')} (total ${deltaMinor >= 0 ? '+' : '−'}${money(Math.abs(deltaMinor))})`;
}

/** Plain-language list of what a job is waiting on, for the gate and the banner. */
export function describeGaps(gaps: FreightGaps): string {
  const parts = gaps.buckets.map((b) => {
    if (b === 'THERAPEUTIC') {
      const count = gaps.gapLines.length;
      return `${count} item${count === 1 ? '' : 's'} with no therapeutic freight`;
    }
    if (b === 'OTHER') return 'other freight switched on but zero';
    return `no ${BUCKETS[b].short.toLowerCase()} freight`;
  });
  return parts.join(', ');
}
