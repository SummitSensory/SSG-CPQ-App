import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { computePricing, PRICING_ENGINE_VERSION, type PricingInput, type PricingBreakdown } from './engine.js';

export { PRICING_ENGINE_VERSION };

/**
 * Resolve the unit price for a product at a date, in precedence order:
 * customer-specific → promotional → active price-list entry.
 * Returns null when no price applies — the engine treats null as "unknown",
 * NEVER as zero.
 */
export async function resolveUnitPrice(
  productId: string,
  opts: { organizationId?: string; quantity?: number; at?: Date },
): Promise<{ unitPrice: bigint | null; source: string }> {
  const at = opts.at ?? new Date();
  const activeWindow = { effectiveDate: { lte: at }, OR: [{ expirationDate: null }, { expirationDate: { gte: at } }] };

  if (opts.organizationId) {
    const cp = await prisma.customerPrice.findFirst({ where: { organizationId: opts.organizationId, productId, ...activeWindow } });
    if (cp) return { unitPrice: cp.unitPrice, source: 'customer' };
  }
  const promo = await prisma.promotionalPrice.findFirst({ where: { productId, ...activeWindow } });
  if (promo) return { unitPrice: promo.unitPrice, source: 'promotional' };

  const entry = await prisma.priceListEntry.findFirst({
    where: { productId, minQuantity: { lte: opts.quantity ?? 1 }, priceList: { status: 'ACTIVE', effectiveDate: { lte: at }, OR: [{ expirationDate: null }, { expirationDate: { gte: at } }] } },
    orderBy: { minQuantity: 'desc' },
  });
  if (entry) return { unitPrice: entry.unitPrice, source: 'price-list' };

  return { unitPrice: null, source: 'unresolved' };
}

export async function resolveUnitCost(productId: string, at: Date = new Date()): Promise<bigint | null> {
  const cost = await prisma.productCost.findFirst({ where: { productId, effectiveDate: { lte: at } }, orderBy: { effectiveDate: 'desc' } });
  return cost ? cost.unitCost : null;
}

/** Compute a quote. Pure engine call — no formulas live outside this domain. */
export function quote(input: PricingInput): PricingBreakdown {
  return computePricing(input);
}

/** Persist an immutable price snapshot (preserve historical pricing). */
export async function snapshotQuote(
  input: PricingInput,
  breakdown: PricingBreakdown,
  userId: string,
  opts: { subjectRef?: string; ruleSnapshotId?: string } = {},
): Promise<string> {
  const snap = await prisma.priceSnapshot.create({
    data: {
      subjectRef: opts.subjectRef ?? null,
      currency: input.currency,
      engineVersion: PRICING_ENGINE_VERSION,
      ruleSnapshotId: opts.ruleSnapshotId ?? null,
      input: JSON.parse(JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
      breakdown: JSON.parse(JSON.stringify(breakdown, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
      grandTotal: breakdown.grandTotal,
      incomplete: breakdown.incomplete,
      createdById: userId,
    },
  });
  return snap.id;
}

/** Log a manual override — authorization + reason are mandatory. */
export async function logOverride(params: {
  subjectRef?: string;
  field: string;
  previousValue?: string;
  newValue: string;
  reason: string;
  authorizedById: string;
}): Promise<void> {
  if (!params.reason?.trim()) throw new ValidationError('Override requires a reason');
  if (!params.authorizedById) throw new ValidationError('Override requires an authorizing user');
  await prisma.priceOverrideLog.create({
    data: {
      subjectRef: params.subjectRef ?? null,
      field: params.field,
      previousValue: params.previousValue ?? null,
      newValue: params.newValue,
      reason: params.reason,
      authorizedById: params.authorizedById,
    },
  });
  await recordAudit({ actorId: params.authorizedById, action: 'pricing.override', entity: 'PriceOverrideLog', details: { field: params.field } });
}
