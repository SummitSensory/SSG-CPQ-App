/**
 * Price-entry gate for proposal lines.
 *
 * A proposal line carries its own `rateMinor` — the builder copies the resolved
 * catalog price onto the line when the product is added. A product with no
 * resolvable price (the professional-services and travel lines, priced per
 * project) copies nothing, so the line arrives with `rateMinor` absent.
 *
 * `versionTotals` reads a missing rate as 0, which means an unanswered line has
 * always totalled as free rather than announcing itself. These functions make the
 * distinction the money math cannot:
 *
 *   - `rateMinor` absent      → nobody has answered yet. Blocks release.
 *   - `rateMinor` === 0       → someone decided it is zero. Allowed, with a reason.
 *   - `rateMinor` > 0         → priced.
 *
 * Zero is a legitimate answer (a waived mobilization, an absorbed return visit),
 * which is exactly why it has to be typed rather than inherited from a blank.
 *
 * Pure functions, no Prisma — same contract as analytics.ts, and unit-testable.
 */

/** A proposal line as stored in ProposalVersion.items. */
export interface PricedLine {
  ref?: string;
  name?: string;
  sku?: string;
  productId?: string | null;
  lineType?: string;
  quantity?: number;
  /** Unit price in minor units. Absent means "not yet answered". */
  rateMinor?: number | null;
  /** Required when rateMinor is 0 — why this line is free. */
  priceNote?: string | null;
}

export type PriceEntryReason = 'AWAITING_PRICE' | 'ZERO_WITHOUT_REASON';

export interface PriceEntryIssue {
  ref: string | null;
  name: string;
  sku: string | null;
  reason: PriceEntryReason;
}

export interface PriceEntryAudit {
  /** Lines with no price entered at all. */
  awaiting: PriceEntryIssue[];
  /** Lines set to $0.00 with no reason given. */
  zeroWithoutReason: PriceEntryIssue[];
  /** Everything that needs attention, in line order. */
  issues: PriceEntryIssue[];
  ok: boolean;
}

const isLine = (v: unknown): v is PricedLine => !!v && typeof v === 'object';

/** Only PRODUCT lines carry money; headings and notes are not priced. */
const isPriced = (l: PricedLine): boolean => (l.lineType ?? 'PRODUCT') === 'PRODUCT';

/**
 * Has a price actually been entered? A number — including 0 — is an answer.
 * null, undefined, '' and NaN are not.
 */
export function hasEnteredPrice(l: PricedLine): boolean {
  const r = l.rateMinor;
  if (r === null || r === undefined) return false;
  const n = typeof r === 'number' ? r : Number(r);
  return Number.isFinite(n);
}

const describe = (l: PricedLine, reason: PriceEntryReason): PriceEntryIssue => ({
  ref: l.ref ?? null,
  name: (l.name || '').trim() || l.sku || 'Untitled line',
  sku: l.sku ?? null,
  reason,
});

/**
 * Inspect a version's items for lines that cannot go out as they stand.
 *
 * Called on save (advisory), on submit-for-review (warning) and on release
 * (blocking) — one function so all three agree on what counts as a problem.
 */
export function auditPriceEntry(items: unknown): PriceEntryAudit {
  const lines = (Array.isArray(items) ? items : []).filter(isLine).filter(isPriced);

  const awaiting: PriceEntryIssue[] = [];
  const zeroWithoutReason: PriceEntryIssue[] = [];

  for (const l of lines) {
    if (!hasEnteredPrice(l)) {
      awaiting.push(describe(l, 'AWAITING_PRICE'));
      continue;
    }
    const rate = Number(l.rateMinor);
    if (rate === 0 && !(l.priceNote || '').trim()) {
      zeroWithoutReason.push(describe(l, 'ZERO_WITHOUT_REASON'));
    }
  }

  const issues = [...awaiting, ...zeroWithoutReason];
  return { awaiting, zeroWithoutReason, issues, ok: issues.length === 0 };
}

/** Join up to `max` line names for a message, then "and N more". */
function nameList(issues: PriceEntryIssue[], max = 4): string {
  const names = issues.map((i) => i.name);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/**
 * The sentence shown to the person who tried to move the proposal on. Names the
 * lines rather than reporting a count — "3 lines need a price" sends them hunting
 * through the builder for which three.
 */
export function priceEntryMessage(audit: PriceEntryAudit): string | null {
  if (audit.ok) return null;
  const parts: string[] = [];
  if (audit.awaiting.length) {
    parts.push(
      `${audit.awaiting.length === 1 ? 'This line needs' : `These ${audit.awaiting.length} lines need`} a price: ${nameList(audit.awaiting)}.`,
    );
  }
  if (audit.zeroWithoutReason.length) {
    parts.push(
      `${audit.zeroWithoutReason.length === 1 ? 'This line is' : `These ${audit.zeroWithoutReason.length} lines are`} $0.00 and need a reason: ${nameList(audit.zeroWithoutReason)}.`,
    );
  }
  return parts.join(' ');
}
