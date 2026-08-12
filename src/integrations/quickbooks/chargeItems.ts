/**
 * QuickBooks items for the NON-PRODUCT charges on a document: freight, the
 * order discount, sales tax, and a portion-invoice deposit.
 *
 * Product lines resolve to an item through a link — by CPQ product id, by part
 * number, or by synthesized family. Freight, discount and tax have no catalog
 * row behind them, so they were sent with no ItemRef at all. QuickBooks does
 * not reject that: it files the line under the company's default sales item,
 * which for SSG is "Professional Design & Rendering Consulting Fee". Every
 * freight dollar, every discount and every tax cent has therefore been landing
 * in the consulting-fee row of Sales by Product/Service, and in whatever income
 * account that item points at. The totals were right; the books were not.
 *
 * Ids come from environment variables rather than code because the sandbox and
 * production companies number their items independently and the same build runs
 * against both — the same reasoning as synthesizedItems.ts.
 *
 * A charge with no configured item still posts, with no ItemRef, exactly as it
 * does today. That is deliberate: an unconfigured freight item must not block an
 * accepted proposal from reaching QuickBooks. `unconfiguredChargeItems()` lists
 * what is missing so the integration status page can say so out loud.
 */

export type ChargeKind =
  | 'FREIGHT_THIRD_PARTY'
  | 'FREIGHT_STRUCTURE'
  | 'FREIGHT_MATS'
  | 'FREIGHT_STANDARD'
  | 'FREIGHT_OTHER'
  | 'FREIGHT_TAX'
  | 'DISCOUNT'
  | 'DEPOSIT';

interface ChargeItemRule {
  kind: ChargeKind;
  /** Human label for the status page. */
  label: string;
  /** Environment variable holding the QuickBooks Item id. */
  env: string;
  /**
   * Fallback env var, tried when the specific one is unset. Every freight class
   * falls back to one general freight item, so a company that does not want
   * freight broken out by class can configure a single id and be done.
   */
  fallbackEnv?: string;
}

const RULES: readonly ChargeItemRule[] = [
  {
    kind: 'FREIGHT_THIRD_PARTY',
    label: 'Third-party freight',
    env: 'QBO_ITEM_ID_FREIGHT_THIRD_PARTY',
    fallbackEnv: 'QBO_ITEM_ID_FREIGHT',
  },
  {
    kind: 'FREIGHT_STRUCTURE',
    label: 'Structure freight',
    env: 'QBO_ITEM_ID_FREIGHT_STRUCTURE',
    fallbackEnv: 'QBO_ITEM_ID_FREIGHT',
  },
  {
    kind: 'FREIGHT_MATS',
    label: 'Mats & padding freight',
    env: 'QBO_ITEM_ID_FREIGHT_MATS',
    fallbackEnv: 'QBO_ITEM_ID_FREIGHT',
  },
  {
    kind: 'FREIGHT_STANDARD',
    label: 'Standard freight',
    env: 'QBO_ITEM_ID_FREIGHT_STANDARD',
    fallbackEnv: 'QBO_ITEM_ID_FREIGHT',
  },
  { kind: 'FREIGHT_OTHER', label: 'Freight (other)', env: 'QBO_ITEM_ID_FREIGHT' },
  /**
   * The proposal's Tax field is a freight tax PASS-THROUGH, not sales tax on the
   * order. It reimburses tax the carrier charged on crating and freight, so it
   * belongs on the pass-through item (SSG: "Crating & Freight - Tax (Mats)",
   * item 207) and not in QuickBooks' sales tax engine. Naming it "sales tax"
   * would put a pass-through cost into the Sales Tax Center and onto a filing.
   */
  { kind: 'FREIGHT_TAX', label: 'Crating & freight tax', env: 'QBO_ITEM_ID_FREIGHT_TAX' },
  { kind: 'DISCOUNT', label: 'Order discount', env: 'QBO_ITEM_ID_DISCOUNT' },
  { kind: 'DEPOSIT', label: 'Deposit / portion invoice', env: 'QBO_ITEM_ID_DEPOSIT' },
];

const BY_KIND = new Map<ChargeKind, ChargeItemRule>(RULES.map((r) => [r.kind, r]));

/** The QuickBooks Item id configured for a charge kind, or null. */
export function chargeItemId(kind: ChargeKind): string | null {
  const rule = BY_KIND.get(kind);
  if (!rule) return null;
  const direct = String(process.env[rule.env] ?? '').trim();
  if (direct) return direct;
  const fallback = rule.fallbackEnv ? String(process.env[rule.fallbackEnv] ?? '').trim() : '';
  return fallback || null;
}

/**
 * Classify a fee by the label the totals reader produced.
 *
 * The proposal-builder path emits four fixed labels, matched exactly. The
 * pricing-engine path emits raw keys off the snapshot's `fees` map, whose
 * spelling is not guaranteed, so anything containing "freight" falls to the
 * general freight item rather than to no item at all.
 */
export function feeChargeKind(label: string): ChargeKind {
  const l = label.trim().toLowerCase();
  if (l === 'third-party freight' || l.includes('third-party') || l.includes('third party'))
    return 'FREIGHT_THIRD_PARTY';
  if (l === 'structure freight' || l.includes('structure')) return 'FREIGHT_STRUCTURE';
  if (l === 'mats & padding freight' || l.includes('mat')) return 'FREIGHT_MATS';
  if (l === 'standard freight' || l.includes('standard')) return 'FREIGHT_STANDARD';
  return 'FREIGHT_OTHER';
}

/**
 * The SalesItemLineDetail body for a charge row: quantity one, plus the ItemRef
 * when one is configured. Written once so the estimate, the invoice and the
 * portion invoice cannot drift apart.
 */
export function chargeDetail(kind: ChargeKind): Record<string, unknown> {
  const id = chargeItemId(kind);
  return { Qty: 1, ...(id ? { ItemRef: { value: id } } : {}) };
}

/**
 * Charge classes with no item configured, for the integration status page. The
 * per-class freight rows are reported only when the general freight item is
 * also unset, since the fallback already covers them.
 */
export function unconfiguredChargeItems(): Array<{ label: string; env: string }> {
  return RULES.filter((r) => !chargeItemId(r.kind)).map((r) => ({ label: r.label, env: r.env }));
}
