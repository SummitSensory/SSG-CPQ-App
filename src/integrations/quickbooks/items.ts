import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { query, create } from './client.js';
import { toQboItem } from './mapping.js';
import { findLink, upsertLink, markLinkState } from './links.js';

const ENTITY = 'Item';
/**
 * Second link entity keyed by SKU STRING rather than a Product id. Generated
 * proposal lines (frame parts, adventure components) carry a part number but no
 * productId, so a product-id-only map would leave them unmapped and they would
 * land in QuickBooks as the default "Services" item.
 */ 
const ENTITY_BY_SKU = 'ItemSku';

interface QboItem {
  Id: string;
  SyncToken: string;
  Name: string;
  Sku?: string;
  [key: string]: unknown;
}

function esc(s: string): string {
  return s.replace(/'/g, "\\'");
}

/**
 * SKUs are compared case- and whitespace-insensitively.
 *
 * Also strips the literal `_x000D_` token and any embedded CR/LF. Those come
 * from spreadsheet round-trips where a carriage return was saved into a part
 * number (e.g. `382-408_x000D_`); without this they can never match their
 * QuickBooks twin. The underlying catalog rows still want cleaning up — see
 * `dirtySkus` in the link report — but a data-entry artifact should not be
 * allowed to silently break mapping.
 */
function normSku(s: string): string {
  return s
    .replace(/_x000D_/gi, '')
    .replace(/[\r\n\t]+/g, '')
    .trim()
    .toUpperCase();
}

/** True when a SKU only matches after normalization stripped junk out of it. */
function isDirtySku(s: string): boolean {
  return normSku(s) !== s.trim().toUpperCase();
}

function itemHash(name: string, sku: string, description: string | null): string {
  return createHash('sha256').update(JSON.stringify({ name, sku, description })).digest('hex');
}

/**
 * Page through every Item in the QuickBooks company.
 *
 * MUST use `select *`. The QuickBooks Online query API does not reliably honour
 * a named-column projection: `select Id, SyncToken, Name, Sku from Item` returns
 * rows with `Sku` silently omitted, so every item looks SKU-less and the whole
 * link scan matches nothing. `select *` is the documented form and returns the
 * full item payload. Do not "optimise" this back into a column list.
 */
async function fetchAllQboItems(
  realmId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QboItem[]> {
  const PAGE = 500; // Conservative: QuickBooks documents 1000 but throttles large pages.
  const all: QboItem[] = [];
  for (let start = 1; ; start += PAGE) {
    const res = await query<{ Item?: QboItem[] }>(
      realmId,
      `select * from Item startposition ${start} maxresults ${PAGE}`,
      fetchImpl,
    );
    const batch = res.Item ?? [];
    all.push(...batch);
    if (batch.length < PAGE) return all;
  }
}

export interface SkuLinkReport {
  /** Total items read from QuickBooks, SKU or not — 0 here means a read problem. */
  qboItemsTotal: number;
  qboItemsWithSku: number;
  productsLinked: number;
  skusLinked: number;
  /** CPQ part numbers with no matching QuickBooks item (first 100). */
  unmatched: string[];
  unmatchedCount: number;
  /**
   * CPQ part numbers that only matched after normalization stripped a stray
   * carriage return or tab out of them. These linked successfully but the
   * catalog rows are dirty and should be cleaned at source.
   */
  dirtySkus: string[];
}

/**
 * Bulk-link the catalog to QuickBooks by SKU. Reads every QuickBooks item once,
 * then links:
 *   - each Product whose `sku` matches a QuickBooks item's Sku, and
 *   - each SKU master part, keyed by the part string, for generated lines that
 *     carry no productId.
 *
 * Creates nothing in QuickBooks — items are imported there via the Products &
 * Services spreadsheet, and this only records which CPQ record maps to which
 * QuickBooks item. Safe to re-run; it is idempotent.
 */
export async function linkItemsBySku(
  realmId: string,
  _userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SkuLinkReport> {
  let qboItems: QboItem[];
  try {
    qboItems = await fetchAllQboItems(realmId, fetchImpl);
  } catch (err) {
    logger.error({ err, realmId }, 'QuickBooks item read failed during link-by-SKU');
    throw new Error(`Reading items from QuickBooks failed: ${String(err)}`);
  }
  const bySku = new Map<string, QboItem>();
  for (const it of qboItems) {
    if (it.Sku) bySku.set(normSku(it.Sku), it);
  }

  const products = await prisma.product.findMany({ select: { id: true, sku: true } });
  const skus = await prisma.sku.findMany({ select: { part: true } });

  const unmatched = new Set<string>();
  const dirty = new Set<string>();
  let productsLinked = 0;
  let skusLinked = 0;

  for (const p of products) {
    if (!p.sku) continue;
    const match = bySku.get(normSku(p.sku));
    if (!match) {
      unmatched.add(p.sku);
      continue;
    }
    if (isDirtySku(p.sku)) dirty.add(p.sku);
    await upsertLink({ entity: ENTITY, entityId: p.id }, match.Id, {
      syncToken: match.SyncToken,
    });
    productsLinked++;
  }

  for (const s of skus) {
    if (!s.part) continue;
    const key = normSku(s.part);
    const match = bySku.get(key);
    if (!match) {
      unmatched.add(s.part);
      continue;
    }
    if (isDirtySku(s.part)) dirty.add(s.part);
    await upsertLink({ entity: ENTITY_BY_SKU, entityId: key }, match.Id, {
      syncToken: match.SyncToken,
    });
    skusLinked++;
  }

  const list = [...unmatched].sort();
  const dirtyList = [...dirty].sort();
  logger.info(
    {
      qboItems: qboItems.length,
      qboItemsWithSku: bySku.size,
      productsLinked,
      skusLinked,
      unmatched: list.length,
      dirtySkus: dirtyList.length,
    },
    'QuickBooks item link-by-SKU complete',
  );
  return {
    qboItemsTotal: qboItems.length,
    qboItemsWithSku: bySku.size,
    productsLinked,
    skusLinked,
    unmatched: list.slice(0, 100),
    unmatchedCount: list.length,
    dirtySkus: dirtyList,
  };
}

/**
 * Sync a single product/service to QuickBooks as an Item — ONLY for products
 * whose catalog record is approved for accounting sync. Duplicate-safe via the
 * QboEntityLink unique constraint, a SKU lookup, then a Name lookup fallback.
 * Unchanged items (same hash) are skipped so we don't churn QuickBooks.
 */
export async function syncItem(
  productId: string,
  realmId: string,
  incomeAccountRef: string,
  _userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ qboId: string; created: boolean; skipped: boolean }> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new Error(`Product ${productId} not found`);
  if (product.status !== 'ACTIVE')
    throw new Error(`Product ${product.sku} is not ACTIVE — refusing to sync`);

  const ref = { entity: ENTITY, entityId: productId };
  const hash = itemHash(product.name, product.sku, product.proposalDescription);
  const existing = await findLink(ref);
  if (existing && existing.lastSyncedHash === hash)
    return { qboId: existing.qboId, created: false, skipped: true };

  try {
    if (!existing) {
      // Adopt by SKU first — that is the identifier the QuickBooks import used.
      if (product.sku) {
        const bySku = await query<{ Item?: QboItem[] }>(
          realmId,
          `select * from Item where Sku = '${esc(normSku(product.sku))}'`,
          fetchImpl,
        );
        const skuMatch = bySku.Item?.[0];
        if (skuMatch) {
          await upsertLink(ref, skuMatch.Id, { syncToken: skuMatch.SyncToken, hash });
          await log(productId, skuMatch.Id, 'ok', 'adopted existing item by SKU');
          return { qboId: skuMatch.Id, created: false, skipped: false };
        }
      }
      // Then by name.
      const found = await query<{ Item?: QboItem[] }>(
        realmId,
        `select * from Item where Name = '${esc(product.name)}'`,
        fetchImpl,
      );
      const match = found.Item?.[0];
      if (match) {
        await upsertLink(ref, match.Id, { syncToken: match.SyncToken, hash });
        await log(productId, match.Id, 'ok', 'adopted existing item by name');
        return { qboId: match.Id, created: false, skipped: false };
      }
    }

    const body = toQboItem(
      {
        name: product.name,
        sku: product.sku,
        kind: product.kind,
        description: product.proposalDescription,
      },
      incomeAccountRef,
    );
    const res = await create<{ Item: QboItem }>(
      realmId,
      'item',
      body,
      `item:${productId}`,
      fetchImpl,
    );
    await upsertLink(ref, res.Item.Id, { syncToken: res.Item.SyncToken, hash });
    await log(productId, res.Item.Id, 'ok', existing ? 'updated item link' : 'created item');
    return { qboId: res.Item.Id, created: !existing, skipped: false };
  } catch (err) {
    logger.error({ err, productId }, 'QuickBooks item sync failed');
    await markLinkState(ref, 'ERROR');
    await log(productId, null, 'error', String(err));
    throw err;
  }
}

async function log(entityId: string, externalId: string | null, status: string, note: string) {
  await prisma.integrationSyncLog.create({
    data: {
      provider: 'quickbooks',
      direction: 'OUTBOUND',
      entity: ENTITY,
      entityId,
      externalId,
      status,
      error: status === 'ok' ? null : note,
    },
  });
}
