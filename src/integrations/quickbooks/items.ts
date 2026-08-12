import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { query, create } from './client.js';
import { toQboItem } from './mapping.js';
import { findLink, upsertLink, markLinkState } from './links.js';
import { qboEnvironment } from '../../config/env.js';

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
  Type?: string;
  Active?: boolean;
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
export function normSku(s: string): string {
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
 *
 * `Active in (true, false)` is deliberate: a QuickBooks query returns only
 * active rows by default, so a deactivated item is indistinguishable from one
 * that was never imported, and the scan reports "not in QuickBooks" for a part
 * that is sitting right there, deactivated. Inactive rows are read, kept out of
 * the link maps, and reported separately as `inactiveMatches`. If an older
 * minor version rejects the clause the page is retried plain and inactive items
 * then read as missing, exactly as before.
 */
async function fetchAllQboItems(
  realmId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QboItem[]> {
  const PAGE = 500; // Conservative: QuickBooks documents 1000 but throttles large pages.
  const all: QboItem[] = [];
  for (let start = 1; ; start += PAGE) {
    let batch: QboItem[];
    try {
      const res = await query<{ Item?: QboItem[] }>(
        realmId,
        `select * from Item where Active in (true, false) startposition ${start} maxresults ${PAGE}`,
        fetchImpl,
      );
      batch = res.Item ?? [];
    } catch (err) {
      logger.warn({ err }, 'QuickBooks item scan: Active clause rejected, retrying plain');
      const res = await query<{ Item?: QboItem[] }>(
        realmId,
        `select * from Item startposition ${start} maxresults ${PAGE}`,
        fetchImpl,
      );
      batch = res.Item ?? [];
    }
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
   * CPQ part numbers that resolved to a QuickBooks item already claimed by a
   * different CPQ record — i.e. duplicate part numbers in the catalog. These
   * are NOT linked; the first claimant keeps the item. Each entry reads
   * "<part> -> already linked to <entityId>".
   */
  conflicts: string[];
  /**
   * CPQ part numbers that only matched after normalization stripped a stray
   * carriage return or tab out of them. These linked successfully but the
   * catalog rows are dirty and should be cleaned at source.
   */
  dirtySkus: string[];
  /**
   * CPQ part numbers matched to a QuickBooks item by NAME because no item
   * carried that part number in its SKU field. Each entry reads
   * "<part> -> \"<item name>\" (Service)". These are linked and will post
   * correctly; the entry exists so an operator can see that the match was made
   * on the name and, if they want the tighter match, fill in the item's SKU.
   */
  nameMatched: string[];
  /**
   * CPQ part numbers whose only QuickBooks match is a DEACTIVATED item. These
   * are NOT linked — linking would only move the failure to the preflight — and
   * the fix is to reactivate the item in QuickBooks and re-run the scan.
   */
  inactiveMatches: string[];
}

/**
 * Bulk-link the catalog to QuickBooks by SKU. Reads every QuickBooks item once,
 * then links:
 *   - each Product whose `sku` matches a QuickBooks item's Sku, and
 *   - each SKU master part, keyed by the part string, for generated lines that
 *     carry no productId.
 *
 * Matching is SKU first, then NAME. The name fallback exists because several
 * QuickBooks item types — Service, and Discount in particular — have no SKU
 * field in the Products & Services UI at all, so a part imported as one of them
 * can only ever be identified by its name. `FLEX-PRO-DISCOUNT` is the case that
 * forced this: the item was in QuickBooks, correctly named, and the scan could
 * not see it, so every proposal carrying that part was blocked at preflight
 * with "not linked to any QuickBooks item" and no way to fix it from the UI.
 * SKU keeps priority, an ambiguous name (two items sharing one name) is left
 * unmatched rather than guessed at, and every name match is reported.
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

  const active = qboItems.filter((it) => it.Active !== false);
  const inactive = qboItems.filter((it) => it.Active === false);

  const bySku = new Map<string, QboItem>();
  for (const it of active) {
    if (it.Sku) bySku.set(normSku(it.Sku), it);
  }

  /*
   * Name index. Only names that are UNIQUE across the company are usable — if
   * two items share a name, no automatic choice between them is defensible, so
   * the key is dropped and the part is reported unmatched.
   */
  const byName = new Map<string, QboItem>();
  const ambiguousNames = new Set<string>();
  for (const it of active) {
    if (!it.Name) continue;
    const key = normSku(it.Name);
    if (byName.has(key)) ambiguousNames.add(key);
    byName.set(key, it);
  }
  for (const key of ambiguousNames) byName.delete(key);

  /* Same two indexes over deactivated items, purely to explain a miss. */
  const inactiveByKey = new Map<string, QboItem>();
  for (const it of inactive) {
    if (it.Sku) inactiveByKey.set(normSku(it.Sku), it);
    if (it.Name && !inactiveByKey.has(normSku(it.Name))) inactiveByKey.set(normSku(it.Name), it);
  }

  const nameMatched: string[] = [];
  const inactiveMatches: string[] = [];

  /**
   * Resolve one CPQ part number to a QuickBooks item: SKU, then unique name.
   * Records why it matched, or why it did not.
   */
  function resolve(part: string): QboItem | null {
    const key = normSku(part);
    const skuHit = bySku.get(key);
    if (skuHit) return skuHit;
    const nameHit = byName.get(key);
    if (nameHit) {
      nameMatched.push(
        `${part} -> "${nameHit.Name}"${nameHit.Type ? ` (${nameHit.Type})` : ''} — matched by name; the QuickBooks item has no part number`,
      );
      return nameHit;
    }
    const dead = inactiveByKey.get(key);
    if (dead) {
      inactiveMatches.push(
        `${part} -> "${dead.Name}" (QuickBooks item ${dead.Id}) is deactivated — reactivate it and re-run this scan`,
      );
    }
    return null;
  }

  /*
   * Retired catalog rows are excluded. An INACTIVE/ARCHIVED product keeps its
   * SKU, so a deliberately retired duplicate would otherwise be reported as a
   * conflict on every scan forever — noise that hides real collisions.
   */
  const products = await prisma.product.findMany({
    where: { status: { notIn: ['INACTIVE', 'ARCHIVED'] } },
    select: { id: true, sku: true },
  });
  const skus = await prisma.sku.findMany({ select: { part: true } });

  /*
   * QboEntityLink is unique on (environment, entity, qboId) as well as on
   * (environment, entity, entityId): one QuickBooks object may be claimed by
   * only one CPQ record. Duplicate part numbers in the catalog resolve to the
   * same QuickBooks item and would violate it, so claims are resolved in memory
   * BEFORE any write — first claimant wins, everyone else is reported. Doing it
   * here rather than catching the database error keeps one bad row from
   * aborting a 600-row scan.
   */
  const claims = new Map<string, string>(); // `${entity}\u0000${qboId}` -> entityId
  const existingLinks = await prisma.qboEntityLink.findMany({
    where: {
      environment: qboEnvironment() as never,
      entity: { in: [ENTITY, ENTITY_BY_SKU] },
    },
    select: { entity: true, entityId: true, qboId: true },
  });
  for (const row of existingLinks) claims.set(`${row.entity}\u0000${row.qboId}`, row.entityId);

  /** Returns the current holder if someone else already claims this item. */
  function claimedByOther(entity: string, qboId: string, entityId: string): string | null {
    const holder = claims.get(`${entity}\u0000${qboId}`);
    return holder && holder !== entityId ? holder : null;
  }

  const unmatched = new Set<string>();
  const dirty = new Set<string>();
  const conflicts: string[] = [];
  let productsLinked = 0;
  let skusLinked = 0;

  for (const p of products) {
    if (!p.sku) continue;
    const match = resolve(p.sku);
    if (!match) {
      unmatched.add(p.sku);
      continue;
    }
    if (isDirtySku(p.sku)) dirty.add(p.sku);
    const heldBy = claimedByOther(ENTITY, match.Id, p.id);
    if (heldBy) {
      conflicts.push(`${p.sku} -> QuickBooks item ${match.Id} already linked to product ${heldBy}`);
      continue;
    }
    await upsertLink({ entity: ENTITY, entityId: p.id }, match.Id, {
      syncToken: match.SyncToken,
    });
    claims.set(`${ENTITY}\u0000${match.Id}`, p.id);
    productsLinked++;
  }

  for (const s of skus) {
    if (!s.part) continue;
    const key = normSku(s.part);
    const match = resolve(s.part);
    if (!match) {
      unmatched.add(s.part);
      continue;
    }
    if (isDirtySku(s.part)) dirty.add(s.part);
    const heldBy = claimedByOther(ENTITY_BY_SKU, match.Id, key);
    if (heldBy) {
      conflicts.push(`${s.part} -> QuickBooks item ${match.Id} already linked to part ${heldBy}`);
      continue;
    }
    await upsertLink({ entity: ENTITY_BY_SKU, entityId: key }, match.Id, {
      syncToken: match.SyncToken,
    });
    claims.set(`${ENTITY_BY_SKU}\u0000${match.Id}`, key);
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
      nameMatched: nameMatched.length,
      inactiveMatches: inactiveMatches.length,
      unmatched: list.length,
      dirtySkus: dirtyList.length,
      conflicts: conflicts.length,
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
    conflicts,
    dirtySkus: dirtyList,
    nameMatched: [...new Set(nameMatched)].sort(),
    inactiveMatches: [...new Set(inactiveMatches)].sort(),
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
      // Then by the catalog name, then by the part number used as a name —
      // Service and Discount items have no SKU field, so the part number is
      // frequently the item's name.
      for (const candidate of [product.name, product.sku].filter(Boolean) as string[]) {
        const found = await query<{ Item?: QboItem[] }>(
          realmId,
          `select * from Item where Name = '${esc(candidate)}'`,
          fetchImpl,
        );
        const match = found.Item?.[0];
        if (match) {
          await upsertLink(ref, match.Id, { syncToken: match.SyncToken, hash });
          await log(productId, match.Id, 'ok', `adopted existing item by name "${candidate}"`);
          return { qboId: match.Id, created: false, skipped: false };
        }
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
