import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { query, create } from './client.js';
import { toQboItem } from './mapping.js';
import { findLink, upsertLink, markLinkState } from './links.js';

const ENTITY = 'Item';

interface QboItem { Id: string; SyncToken: string; Name: string }

function esc(s: string): string {
  return s.replace(/'/g, "\\'");
}

function itemHash(name: string, sku: string, description: string | null): string {
  return createHash('sha256').update(JSON.stringify({ name, sku, description })).digest('hex');
}

/**
 * Sync a single product/service to QuickBooks as an Item — ONLY for products
 * whose catalog record is approved for accounting sync. Duplicate-safe via the
 * QboEntityLink unique constraint and a Name lookup fallback. Unchanged items
 * (same hash) are skipped so we don't churn QuickBooks.
 */
export async function syncItem(
  productId: string,
  realmId: string,
  incomeAccountRef: string,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ qboId: string; created: boolean; skipped: boolean }> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new Error(`Product ${productId} not found`);
  if (product.status !== 'ACTIVE') throw new Error(`Product ${product.sku} is not ACTIVE — refusing to sync`);

  const ref = { entity: ENTITY, entityId: productId };
  const hash = itemHash(product.name, product.sku, product.proposalDescription);
  const existing = await findLink(ref);
  if (existing && existing.lastSyncedHash === hash) return { qboId: existing.qboId, created: false, skipped: true };

  try {
    if (!existing) {
      // Adopt an existing QuickBooks item with the same name if present.
      const found = await query<{ Item?: QboItem[] }>(realmId, `select Id, SyncToken, Name from Item where Name = '${esc(product.name)}'`, fetchImpl);
      const match = found.Item?.[0];
      if (match) {
        await upsertLink(ref, match.Id, { syncToken: match.SyncToken, hash });
        await log(productId, match.Id, 'ok', 'adopted existing item');
        return { qboId: match.Id, created: false, skipped: false };
      }
    }

    const body = toQboItem({ name: product.name, sku: product.sku, kind: product.kind, description: product.proposalDescription }, incomeAccountRef);
    const res = await create<{ Item: QboItem }>(realmId, 'item', body, `item:${productId}`, fetchImpl);
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
    data: { provider: 'quickbooks', direction: 'OUTBOUND', entity: ENTITY, entityId, externalId, status, error: status === 'ok' ? null : note },
  });
}
