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
}

function esc(s: string): string {
  return s.replace(/'/g, "\\'");
}

/** SKUs are compared case- and whitespace-insensitively. */
function normSku(s: string): string {
  return s.trim().toUpperCase();
}

function itemHash(name: string, sku: string, description: string | null): string {
  return createHash('sha256').update(JSON.stringify({ name, sku, description })).digest('hex');
}

/** Page through every Item in the QuickBooks company. */
async function fetchAllQboItems(
  realmId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QboItem[]> {
  const PAGE = 500;
  const all: QboItem[] = [];
  for (let start = 1; ; start += PAGE) {
    const res = await query<{ Item?: QboItem[] }>(
      realmId,
      `select Id, SyncToken, Name, Sku from Item startposition ${start} maxresults ${PAGE}`,
      fetchImpl,
    );
    const batch = res.Item ?? [];
    all.push(...batch);
    if (batch.length < PAGE) return all;
  }
}

export interface SkuLinkReport {
  qboItemsWithSku: number;
  productsLinked: number;
  skusLinked: number;
  /** CPQ part numbers with no matching QuickBooks item (first 100). */
  unmatched: string[];
  unmatchedCount: number;
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
  const qboItems = await fetchAllQboItems(realmId, fetchImpl);
  const bySku = new Map<string, QboItem>();
  for (const it of qboItems) {
    if (it.Sku) bySku.set(normSku(it.Sku), it);
  }

  const products = await prisma.product.findMany({ select: { id: true, sku: true } });
  const skus = await prisma.sku.findMany({ select: { part: true } });

  const unmatched = new Set<string>();
  let productsLinked = 0;
  let skusLinked = 0;

  for (const p of products) {
    if (!p.sku) continue;
    const match = bySku.get(normSku(p.sku));
    if (!match) {
      unmatched.add(p.sku);
      continue;
    }
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
    await upsertLink({ entity: ENTITY_BY_SKU, entityId: key }, match.Id, {
      syncToken: match.SyncToken,
    });
    skusLinked++;
  }

  const list = [...unmatched].sort();
  logger.info(
    { qboItems: qboItems.length, productsLinked, skusLinked, unmatched: list.length },
    'QuickBooks item link-by-SKU complete',
  );
  return {
    qboItemsWithSku: bySku.size,
    productsLinked,
    skusLinked,
    unmatched: list.slice(0, 100),
    unmatchedCount: list.length,
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
          `select Id, SyncToken, Name, Sku from Item where Sku = '${esc(product.sku)}'`,
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
        `select Id, SyncToken, Name, Sku from Item where Name = '${esc(product.name)}'`,
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
