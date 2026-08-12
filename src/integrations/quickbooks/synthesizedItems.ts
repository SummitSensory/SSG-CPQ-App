/**
 * QuickBooks items for proposal lines the pricing engine SYNTHESIZES.
 *
 * Most lines resolve to a QuickBooks item through a link: by CPQ product id, or by
 * part number for the 213 ItemSku links. A few lines have neither, because no
 * catalog row exists for them and none can:
 *
 *   R-SSG-1010CLM, R-SSG-0806CLM-2, …   one part number per mat SIZE, generated from
 *                                       the frame footprint by matPricing.ts
 *
 * A catalog row per size would mean a new product — and a new QuickBooks item — every
 * time a rep configures a dimension nobody has quoted before, for a line whose price
 * comes from the formula regardless. So one QuickBooks item stands for the whole
 * family, matched by pattern, and the configured size travels in the line
 * description. New sizes work with no data entry and no deploy.
 *
 * The mats are split by thickness because 2" and 3.25" are different products with
 * different costs, and splitting them keeps Sales by Product/Service meaningful.
 *
 * H-1000 is deliberately NOT here. It is a real ACTIVE catalog row, so it resolves
 * through the ordinary product link once a QuickBooks item is linked to it — the
 * fastener detail stays in the BOM and QuickBooks sees the single kit line.
 */

export interface SynthesizedItemRule {
  /** Matched against the line's part number, upper-cased and trimmed. */
  pattern: RegExp;
  /** Human label, used in the preflight error and the integration status view. */
  family: string;
  /**
   * Environment variable holding the QuickBooks Item id. An env var rather than a
   * hardcoded id because the sandbox and production companies number their items
   * independently, and the same build runs against both.
   */
  itemIdEnv: string;
}

export const SYNTHESIZED_ITEM_RULES: readonly SynthesizedItemRule[] = [
  {
    // 2" first: the 3.25" pattern would otherwise need to exclude the suffix.
    pattern: /^R-SSG-\d{2,4}CLM-2$/,
    family: 'Adventure Floor Mat System — 2"',
    itemIdEnv: 'QBO_ITEM_ID_MAT_SYSTEM_2IN',
  },
  {
    pattern: /^R-SSG-\d{2,4}CLM$/,
    family: 'Adventure Floor Mat System — 3.25"',
    itemIdEnv: 'QBO_ITEM_ID_MAT_SYSTEM_325IN',
  },
];

/** The rule covering a part number, or null when it is not a synthesized family. */
export function synthesizedRuleFor(sku: string | null | undefined): SynthesizedItemRule | null {
  const s = String(sku ?? '')
    .trim()
    .toUpperCase();
  if (!s) return null;
  return SYNTHESIZED_ITEM_RULES.find((r) => r.pattern.test(s)) ?? null;
}

/**
 * The QuickBooks Item id for a synthesized part number, or null.
 *
 * Null covers two different situations on purpose — the part is not a synthesized
 * family, or it is but the env var is unset. Both mean "no item", and both are then
 * reported by the preflight as an unmapped line rather than silently sending a line
 * with no ItemRef.
 */
export function resolveSynthesizedItemId(sku: string | null | undefined): string | null {
  const rule = synthesizedRuleFor(sku);
  if (!rule) return null;
  const id = String(process.env[rule.itemIdEnv] ?? '').trim();
  return id || null;
}

/**
 * Families configured with no item id, for the integration status page. An empty
 * array means every synthesized family can reach QuickBooks.
 */
export function unconfiguredSynthesizedFamilies(): Array<{ family: string; env: string }> {
  return SYNTHESIZED_ITEM_RULES.filter((r) => !String(process.env[r.itemIdEnv] ?? '').trim()).map(
    (r) => ({ family: r.family, env: r.itemIdEnv }),
  );
}
