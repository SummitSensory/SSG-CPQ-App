import { prisma } from '../../lib/prisma.js';
import { ConflictError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { query } from './client.js';
import { normSku } from './items.js';
import { synthesizedRuleFor, resolveSynthesizedItemId } from './synthesizedItems.js';
import type { AcceptedLine } from './mapping.js';

/**
 * Part-number preflight for QuickBooks documents.
 *
 * Every priced line on an accepted proposal is supposed to carry an ItemRef to
 * a real QuickBooks item. Nothing enforced that. A line whose part number was
 * never imported into QuickBooks, or whose item was deleted or made inactive
 * after the link was recorded, still posts — QuickBooks accepts the line
 * without an ItemRef and files it under the default service item. The invoice
 * total is right, the customer notices nothing, and Sales by Product/Service is
 * quietly wrong until someone reads a report months later.
 *
 * So the mapping is verified against QuickBooks itself before any document is
 * created, and a failure blocks the create rather than being logged. The check
 * runs on the SAME frozen lines the document is built from, so it can never
 * pass on one set of lines and send another.
 */

export type SkuCheckStatus =
  'OK' | 'NO_SKU' | 'UNMAPPED' | 'MISSING_IN_QBO' | 'INACTIVE_IN_QBO' | 'SKU_MISMATCH';

export interface SkuCheckLine {
  description: string;
  sku: string;
  productId: string | null;
  qboItemId: string | null;
  qboItemName: string;
  qboSku: string;
  status: SkuCheckStatus;
  /** Plain-language reason, written for the person who has to fix it. */
  detail: string;
  /** True when this line stops the document being created. */
  blocking: boolean;
}

export interface SkuCheckResult {
  ok: boolean;
  checkedAt: string;
  /** Priced lines examined. Headings, subheadings and notes are not counted. */
  productLines: number;
  okCount: number;
  lines: SkuCheckLine[];
  blockers: SkuCheckLine[];
  warnings: SkuCheckLine[];
  /** Distinct part numbers that must be fixed, for the message and the log. */
  missingSkus: string[];
}

interface QboItemRow {
  Id: string;
  Name?: string;
  Sku?: string;
  Active?: boolean;
}

function esc(s: string): string {
  return s.replace(/'/g, "\\'");
}

/**
 * Read the linked items back from QuickBooks by Id.
 *
 * `Active in (true, false)` is deliberate: a QuickBooks query returns only
 * active rows by default, so without it a deactivated item is indistinguishable
 * from a deleted one, and "inactive — reactivate it" would be reported as
 * "missing — import it". If an older minor version rejects the clause the query
 * is retried plain, and inactive items then read as missing rather than
 * aborting the whole check.
 */
async function fetchItemsByIds(
  realmId: string,
  ids: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, QboItemRow>> {
  const out = new Map<string, QboItemRow>();
  const unique = [...new Set(ids.filter(Boolean))];
  const CHUNK = 40;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const inList = unique
      .slice(i, i + CHUNK)
      .map((id) => `'${esc(id)}'`)
      .join(',');
    let rows: QboItemRow[] = [];
    try {
      const res = await query<{ Item?: QboItemRow[] }>(
        realmId,
        `select * from Item where Id in (${inList}) and Active in (true, false)`,
        fetchImpl,
      );
      rows = res.Item ?? [];
    } catch (err) {
      logger.warn({ err }, 'QuickBooks item preflight: Active clause rejected, retrying plain');
      const res = await query<{ Item?: QboItemRow[] }>(
        realmId,
        `select * from Item where Id in (${inList})`,
        fetchImpl,
      );
      rows = res.Item ?? [];
    }
    for (const it of rows) out.set(it.Id, it);
  }
  return out;
}

/**
 * Compare the frozen proposal lines against QuickBooks. Read-only; it never
 * creates or repairs a link. Repair is `Link items by SKU`, which is a
 * deliberate, logged action rather than something a create quietly does on the
 * way past.
 */
export async function checkSkuMapping(
  lines: AcceptedLine[],
  realmId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SkuCheckResult> {
  const priced = lines.filter((l) => (l.kind ?? 'PRODUCT') === 'PRODUCT');

  // Pricing-engine snapshots carry a productId but no part number on the line.
  // Read the part numbers so the report names the part the buyer would look up,
  // not an internal id.
  const needSku = priced.filter((l) => !l.sku && l.productId).map((l) => l.productId as string);
  const skuByProduct = new Map<string, string>();
  if (needSku.length) {
    const rows = await prisma.product.findMany({
      where: { id: { in: [...new Set(needSku)] } },
      select: { id: true, sku: true },
    });
    for (const r of rows) skuByProduct.set(r.id, r.sku ?? '');
  }

  const qboItems = await fetchItemsByIds(
    realmId,
    priced.map((l) => l.qboItemId ?? '').filter(Boolean),
    fetchImpl,
  );

  const out: SkuCheckLine[] = priced.map((l) => {
    const sku = (l.sku ?? (l.productId ? skuByProduct.get(l.productId) : '') ?? '').trim();
    const qboItemId = l.qboItemId ?? null;
    const item = qboItemId ? qboItems.get(qboItemId) : undefined;
    const base = {
      description: l.description,
      sku,
      productId: l.productId ?? null,
      qboItemId,
      qboItemName: item?.Name ?? '',
      qboSku: item?.Sku ?? '',
    };

    if (!qboItemId && !sku) {
      return {
        ...base,
        status: 'NO_SKU' as const,
        detail: 'No part number on this line — it will invoice as text with no QuickBooks item.',
        blocking: false,
      };
    }
    if (!qboItemId) {
      return {
        ...base,
        status: 'UNMAPPED' as const,
        detail: `${sku} is not linked to any QuickBooks item.`,
        blocking: true,
      };
    }
    if (!item) {
      return {
        ...base,
        status: 'MISSING_IN_QBO' as const,
        detail: `Linked to QuickBooks item ${qboItemId}, which no longer exists.`,
        blocking: true,
      };
    }
    if (item.Active === false) {
      return {
        ...base,
        status: 'INACTIVE_IN_QBO' as const,
        detail: `QuickBooks item "${item.Name ?? qboItemId}" is inactive.`,
        blocking: true,
      };
    }
    if (sku && item.Sku && normSku(item.Sku) !== normSku(sku)) {
      /**
       * A synthesized family is the one legitimate mismatch.
       *
       * Every Adventure mat SIZE generates its own part number, and one QuickBooks
       * item stands for the whole family — so the item's SKU can never equal the
       * line's, by design. The check that matters is not "do the strings match" but
       * "is this the item the family is configured to use", which is what
       * resolveSynthesizedItemId answers. A line pointing at some OTHER item still
       * fails, so the mismatch rule keeps its teeth.
       */
      const rule = synthesizedRuleFor(sku);
      if (rule && resolveSynthesizedItemId(sku) === qboItemId) {
        return {
          ...base,
          status: 'OK' as const,
          detail: `Matched to the "${rule.family}" family item — a configured mat size has no item of its own.`,
          blocking: false,
        };
      }
      return {
        ...base,
        status: 'SKU_MISMATCH' as const,
        detail: `Linked to "${item.Name ?? qboItemId}", whose part number is ${item.Sku} — not ${sku}.`,
        blocking: true,
      };
    }
    return {
      ...base,
      status: 'OK' as const,
      detail: item.Sku ? '' : 'Matched by link; the QuickBooks item carries no part number.',
      blocking: false,
    };
  });

  const blockers = out.filter((l) => l.blocking);
  const warnings = out.filter((l) => !l.blocking && l.status !== 'OK');
  const missingSkus = [...new Set(blockers.map((b) => b.sku).filter(Boolean))].sort();

  return {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    productLines: out.length,
    okCount: out.filter((l) => l.status === 'OK').length,
    lines: out,
    blockers,
    warnings,
    missingSkus,
  };
}

/**
 * The gate. Throws a 409 naming the parts to fix, which is the whole point —
 * "QuickBooks rejected this" tells a rep nothing, "382-408 and CT-14 are not in
 * QuickBooks" tells them exactly what to import.
 */
export async function assertSkusMapped(
  lines: AcceptedLine[],
  realmId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SkuCheckResult> {
  const result = await checkSkuMapping(lines, realmId, fetchImpl);
  if (result.ok) return result;

  const named = result.missingSkus.length ? result.missingSkus : [];
  const shown = named.slice(0, 12).join(', ');
  const more = named.length > 12 ? ` and ${named.length - 12} more` : '';
  const subject =
    named.length > 0
      ? `${named.length} part number${named.length === 1 ? '' : 's'} on this proposal (${shown}${more})`
      : `${result.blockers.length} line${result.blockers.length === 1 ? '' : 's'} on this proposal`;

  logger.warn(
    { realmId, blockers: result.blockers.length, missingSkus: result.missingSkus },
    'QuickBooks create blocked: unmapped part numbers',
  );

  /**
   * Every blocker, not just the first. Each one can fail for a different reason —
   * one part never imported, another linked to the wrong item — and reporting one
   * at a time turns a single fix into as many round trips as there are problems.
   */
  const reasons = result.blockers
    .slice(0, 12)
    .map((b) => `• ${b.sku || b.description}: ${b.detail}`)
    .join(' ');
  const andMore = result.blockers.length > 12 ? ` …and ${result.blockers.length - 12} more.` : '';

  throw new ConflictError(
    `${subject} do not map to an active QuickBooks item, so this document was not created. ` +
      `${reasons}${andMore} ` +
      `Import the missing parts into QuickBooks (Products & Services), run "Link items by SKU" under Integrations, then retry.`,
  );
}
