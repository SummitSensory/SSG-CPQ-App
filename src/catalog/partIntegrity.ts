/**
 * The catalog's invariants, as code, in one place.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every serious defect found in the audit was the same defect wearing a different
 * costume: the same fact stored in two places, with nothing checking that the two
 * agreed.
 *
 *   - A part is a `Product` row (name, category, tree position, sourcing) AND a `Sku` row
 *     (price, cost, weight, vendor). Three of the four write paths created only one of
 *     them, so 194 parts existed as half of themselves — and because
 *     `GET /catalog/items` reports a Product with no Sku as `unitPriceMinor: 0,
 *     active: true`, 192 of them were being offered to reps in the proposal builder at
 *     $0.00.
 *   - A part's vendor is `Sku.manufacturer` (a string) AND `ProductSourcing`
 *     (a relation). Two write paths set only the string. Seven parts ended up naming
 *     different companies in the two records, and since the Bill of Materials reads the
 *     string, the relation was quietly wrong for as long as anyone cared to look.
 *   - A part's section is `Sku.category` (a string) AND `Product.categoryId`
 *     (a relation). Same shape, and the worst consequence of the three: the string is
 *     what the proposal engine groups PRINTED LINES by, and `PATCH /catalog/items/:part`
 *     moved the relation while leaving the string alone whenever a Product existed — the
 *     everyday path. So the catalog screen showed one section and the customer's proposal
 *     printed another, every time somebody changed a part's section.
 *
 * Each of those was found by a person reading code. That does not scale, and it is not a
 * guarantee. So the invariants live here, once, and are checked two ways: by
 * `prisma/check-part-integrity.ts` on demand, and by
 * `tests/integration/part-integrity.test.ts`, which fails the build. A violation stops
 * being something to notice and becomes something that cannot ship.
 *
 * This file READS ONLY. It never repairs — a violation needs a person to decide which of
 * the two records was right, and `prisma/repair-half-created-parts.ts` and
 * `prisma/align-vendor-sourcing.ts` exist for the cases where that answer is knowable.
 */
import type { PrismaClient } from '@prisma/client';

export type Severity = 'blocking' | 'warning';

export interface Violation {
  /** Stable id so a test can assert on a kind without matching prose. */
  rule: string;
  severity: Severity;
  part: string;
  detail: string;
}

export interface IntegrityReport {
  checked: { products: number; skus: number; sourcing: number };
  violations: Violation[];
  blocking: number;
  warnings: number;
  /** Grouped counts, for a summary line that does not print 200 rows. */
  byRule: Record<string, number>;
}

const key = (v: unknown): string => (v == null ? '' : String(v)).trim().toLowerCase();

/**
 * Every invariant, checked against live data.
 *
 * Severity is the judgement call, and it is deliberate:
 *
 *   blocking — a state that can put a wrong number on a customer document. A Product with
 *              no Sku that is ACTIVE is quotable at $0.00; two vendor records disagreeing
 *              means the purchase order and the catalog name different companies.
 *
 *   warning  — a state that is untidy but cannot reach a customer. A Sku with no Product
 *              is invisible to the tree and the category filters, which is a real problem
 *              for whoever is administering the catalog, but it does not misprice a quote.
 *
 * The distinction matters because a check that blocks on everything gets switched off.
 */
export async function checkPartIntegrity(prisma: PrismaClient): Promise<IntegrityReport> {
  const [products, skus, sourcing] = await Promise.all([
    prisma.product.findMany({
      select: { id: true, sku: true, name: true, status: true, categoryId: true },
    }),
    prisma.sku.findMany({
      select: { part: true, manufacturer: true, category: true, active: true },
    }),
    prisma.productSourcing.findMany({
      select: {
        manufacturerId: true,
        isPrimary: true,
        product: { select: { sku: true } },
        manufacturer: { select: { name: true } },
      },
    }),
  ]);

  const skuByPart = new Map(skus.map((s) => [key(s.part), s]));
  const productBySku = new Map(products.map((p) => [key(p.sku), p]));
  /*
   * No category lookup here any more. It existed for the rule that compared
   * `Sku.category` against the tree, which was removed once `dataset.ts` made clear those
   * hold different facts — a part TYPE and a tree position. Reading the table for a rule
   * that no longer exists is a query per run and a variable that lint correctly refuses.
   */
  /*
   * ALL the vendors a part can be sourced from, and which one is primary.
   *
   * `ProductSourcing` is a MANY-TO-MANY: `@@unique([productId, manufacturerId])` plus an
   * `isPrimary` flag, so a part legitimately lists several vendors with one preferred.
   *
   * An earlier version of this file collapsed it to one vendor per part with a
   * `Map.set` in a loop — so for a part with two vendors, whichever row the database
   * returned last silently won, and the check then reported a "disagreement" between
   * `Sku.manufacturer` and an arbitrarily chosen alternate. Seven parts were flagged
   * that way and none of them was wrong: the tracking-rail hardware lists both Goldberg
   * Brothers and Productive Tool Products, which is what a second source is for.
   */
  /*
   * ALL the vendors a part can be sourced from, and ALL the ones flagged primary.
   *
   * `primaries` is a list, not a value, and that is the whole point. `isPrimary` is
   * `@default(true)` in the schema, so every sourcing row added without explicitly
   * setting it becomes primary — which means a part with two sources naturally ends up
   * with two primaries, and "the primary source" is not a thing that exists for it.
   *
   * This is the third version of this index. The first collapsed the vendor list to one
   * value with a `Map.set` in a loop; the second fixed that but collapsed the PRIMARY
   * flag the same way, so it named an arbitrary winner among several primaries and
   * reported seven parts as mis-flagged when the real condition was that all their rows
   * were flagged. Same mistake twice, one layer apart: assuming a cardinality instead of
   * reading it. Nothing here assumes one of anything.
   */
  const vendorsByPart = new Map<string, { all: string[]; primaries: string[] }>();
  for (const r of sourcing) {
    if (!r.product?.sku || !r.manufacturer?.name) continue;
    const k = key(r.product.sku);
    const entry = vendorsByPart.get(k) ?? { all: [], primaries: [] };
    entry.all.push(r.manufacturer.name);
    if (r.isPrimary) entry.primaries.push(r.manufacturer.name);
    vendorsByPart.set(k, entry);
  }

  const v: Violation[] = [];

  for (const p of products) {
    const sku = skuByPart.get(key(p.sku));

    if (!sku) {
      // ACTIVE is what makes this dangerous rather than merely incomplete: the part
      // picker keeps every row GET /catalog/items marks active, and that endpoint marks a
      // Sku-less Product active whenever its status is ACTIVE — with a price of zero.
      v.push({
        rule: 'product-without-sku',
        severity: p.status === 'ACTIVE' ? 'blocking' : 'warning',
        part: p.sku,
        detail:
          p.status === 'ACTIVE'
            ? 'no priced record, and ACTIVE — selectable in the proposal builder at $0.00'
            : `no priced record (status ${p.status}, so not selectable)`,
      });
      continue;
    }

    const src = vendorsByPart.get(key(p.sku));
    const named = (sku.manufacturer ?? '').trim();
    if (named && !src) {
      v.push({
        rule: 'vendor-not-linked',
        severity: 'warning',
        part: p.sku,
        detail:
          `priced record says “${named}” but there is no sourcing link, so vendor ` +
          `reports miss this part`,
      });
    } else if (named && src) {
      const listed = src.all.some((n) => key(n) === key(named));
      if (!listed) {
        // The real defect: the part is ORDERED from a vendor that is not among the
        // vendors it is recorded as being sourced from. The Bill of Materials follows
        // `Sku.manufacturer`, so a purchase order goes to a company the catalog does not
        // associate with the part at all.
        v.push({
          rule: 'vendor-not-sourced',
          severity: 'blocking',
          part: p.sku,
          detail:
            `ordered from “${named}”, which is not among its sourcing vendors ` +
            `(${src.all.join(', ') || 'none'})`,
        });
      } else if (src.primaries.length > 1) {
        // More than one row flagged primary, so the flag carries no information for this
        // part. Not dangerous — every listed vendor genuinely supplies it, and the order
        // follows `Sku.manufacturer` regardless — but it means nothing downstream can
        // answer "who is the preferred source" without guessing, which is what the
        // earlier version of this check did.
        v.push({
          rule: 'vendor-multiple-primary',
          severity: 'warning',
          part: p.sku,
          detail:
            `${src.primaries.length} sources are all flagged primary ` +
            `(${src.primaries.join(', ')}); ordered from “${named}”`,
        });
      } else if (src.primaries.length === 1 && key(src.primaries[0]!) !== key(named)) {
        // Exactly one preferred source, and it is not the one being ordered from. Worth
        // knowing and not dangerous: the order still goes to a vendor that supplies the
        // part. Which one is preferred is a purchasing judgement, not a check's call.
        v.push({
          rule: 'vendor-not-primary',
          severity: 'warning',
          part: p.sku,
          detail:
            `ordered from “${named}”, but “${src.primaries[0]}” is marked as the ` +
            `primary source`,
        });
      }
    }

    /*
     * THERE IS NO CATEGORY RULE HERE, AND THAT IS DELIBERATE.
     *
     * An earlier version of this file flagged `Sku.category` disagreeing with the
     * product tree, first as a warning and then as blocking, on the stated grounds that
     * `Sku.category` was what the proposal engine grouped printed lines by.
     *
     * That was false. `src/reporting/dataset.ts` says what each field is:
     *
     *     /** Sku.category, or 'UNCATEGORISED' when the part is not in the catalog. *\/
     *     /** Sku.proposalGroup — the tier heading the builder files this part under. *\/
     *
     * `Sku.proposalGroup` is the proposal heading. `Sku.category` is a part TYPE — FRAME,
     * TROLLEY, ACCESSORY — used for catalog filtering and as a reporting dimension in
     * `query.ts`. `Product.categoryId` is where the part sits in the tree. Three fields,
     * three jobs, and no reason for any two of them to match: 219 parts in this database
     * are filed under "ADVENTURE SERIES FRAME" in the tree and typed "FRAME", which is
     * correct on both counts.
     *
     * A check that flagged those 219 would have been wrong 219 times, and the repair it
     * pointed at would have destroyed a deliberate taxonomy. Two records holding
     * DIFFERENT facts is not duplication, and the test for that is what each field is
     * documented to mean — not what the shapes look like from the outside.
     */

    if (p.status === 'ACTIVE' && !sku.active) {
      v.push({
        rule: 'active-mismatch',
        severity: 'warning',
        part: p.sku,
        detail: 'live in the tree but inactive in the price list',
      });
    }
  }

  for (const s of skus) {
    if (!productBySku.has(key(s.part))) {
      v.push({
        rule: 'sku-without-product',
        severity: 'warning',
        part: s.part,
        detail: 'priced record with no catalog record — absent from the tree and category filters',
      });
    }
  }

  const byRule: Record<string, number> = {};
  for (const x of v) byRule[x.rule] = (byRule[x.rule] ?? 0) + 1;

  return {
    checked: { products: products.length, skus: skus.length, sourcing: sourcing.length },
    violations: v,
    blocking: v.filter((x) => x.severity === 'blocking').length,
    warnings: v.filter((x) => x.severity === 'warning').length,
    byRule,
  };
}

/** Human-readable summary. Shared by the CLI and the test's failure message. */
export function formatIntegrityReport(r: IntegrityReport, limit = 25): string {
  const out: string[] = [];
  out.push(
    `Checked ${r.checked.products} products, ${r.checked.skus} priced records, ` +
      `${r.checked.sourcing} sourcing links.`,
  );
  if (!r.violations.length) {
    out.push('No violations. Every part has both halves and they agree.');
    return out.join('\n');
  }
  out.push(`${r.blocking} blocking, ${r.warnings} warning.`);
  out.push('');
  for (const rule of Object.keys(r.byRule).sort()) {
    const rows = r.violations.filter((x) => x.rule === rule);
    const sev = rows[0]!.severity.toUpperCase();
    out.push(`${rule}  [${sev}]  ${rows.length}`);
    for (const x of rows.slice(0, limit)) out.push(`   ${x.part.padEnd(20)} ${x.detail}`);
    if (rows.length > limit) out.push(`   … +${rows.length - limit} more`);
    out.push('');
  }
  return out.join('\n');
}
