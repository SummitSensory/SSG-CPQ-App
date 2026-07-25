import { prisma } from '../lib/prisma.js';
import type { Product, ProductCategory, ProductStatus } from '@prisma/client';
import { ConflictError, ValidationError } from '../lib/errors.js';

/** Allowed status transitions. */
const TRANSITIONS: Record<ProductStatus, ProductStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

export function canTransition(from: ProductStatus, to: ProductStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Serializable snapshot of a product for version history. */
export function buildSnapshot(p: Product): Record<string, unknown> {
  return {
    sku: p.sku,
    name: p.name,
    kind: p.kind,
    status: p.status,
    categoryId: p.categoryId,
    familyId: p.familyId,
    proposalDescription: p.proposalDescription,
    internalDescription: p.internalDescription,
    lengthIn: p.lengthIn,
    widthIn: p.widthIn,
    heightIn: p.heightIn,
    weightOz: p.weightOz,
    capacity: p.capacity,
    activeFrom: p.activeFrom,
    activeTo: p.activeTo,
    adminNotes: p.adminNotes,
    version: p.version,
  };
}

/**
 * Hard-delete policy: a product may be permanently deleted ONLY if it was never
 * activated AND is not referenced elsewhere. Anything that could appear on a
 * historical proposal (ever-active) must be archived, never deleted.
 */
export function canHardDelete(everActive: boolean, referencedCount: number): boolean {
  return !everActive && referencedCount === 0;
}

export async function updateProduct(
  id: string,
  data: Partial<Product>,
  userId: string,
  note?: string,
): Promise<Product> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.product.findUnique({ where: { id } });
    if (!current) throw new ValidationError('Product not found');
    // Snapshot the CURRENT state before mutating (version history).
    await tx.productVersion.create({
      data: {
        productId: id,
        version: current.version,
        snapshot: buildSnapshot(current) as object,
        changedById: userId,
        changeNote: note ?? null,
      },
    });
    return tx.product.update({ where: { id }, data: { ...data, version: current.version + 1 } });
  });
}

export async function changeStatus(
  id: string,
  to: ProductStatus,
  userId: string,
  reason?: string,
): Promise<Product> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.product.findUnique({ where: { id } });
    if (!current) throw new ValidationError('Product not found');
    if (current.status === to) return current;
    if (!canTransition(current.status, to)) {
      throw new ConflictError(`Illegal status transition ${current.status} -> ${to}`);
    }
    await tx.productStatusHistory.create({
      data: {
        productId: id,
        fromStatus: current.status,
        toStatus: to,
        reason: reason ?? null,
        changedById: userId,
      },
    });
    // Safe deactivation: stamp activeTo when leaving ACTIVE.
    const extra = to === 'INACTIVE' || to === 'ARCHIVED' ? { activeTo: new Date() } : {};
    const started = to === 'ACTIVE' && !current.activeFrom ? { activeFrom: new Date() } : {};
    return tx.product.update({ where: { id }, data: { status: to, ...extra, ...started } });
  });
}

/**
 * Resolves and validates where a category node sits in its product line's
 * tier tree: tier 1 has no parent; every other tier is exactly parent + 1
 * (max 4), and a node's product line must match its parent's.
 */
export function resolveCategoryTier(
  input: { tierLevel?: number; productLineId?: string; productId?: string },
  parent: ProductCategory | null,
): { tierLevel: number; productLineId: string | null } {
  if (!parent) {
    const tierLevel = input.tierLevel ?? 1;
    if (tierLevel !== 1) throw new ValidationError('A top-level category must be tier 1');
    if (input.productId) {
      throw new ValidationError(
        'Tier 1 categories are headers only — they cannot reference a product',
      );
    }
    return { tierLevel: 1, productLineId: input.productLineId ?? null };
  }
  const tierLevel = parent.tierLevel + 1;
  if (tierLevel > 4) throw new ValidationError('Maximum tier depth is 4');
  if (input.tierLevel != null && input.tierLevel !== tierLevel) {
    throw new ValidationError(`tierLevel must be ${tierLevel} (parent tier + 1)`);
  }
  const productLineId = input.productLineId ?? parent.productLineId ?? null;
  if (parent.productLineId && productLineId !== parent.productLineId) {
    throw new ValidationError("A category's product line must match its parent's");
  }
  return { tierLevel, productLineId };
}

/** True if setting `nodeId`'s parent to `newParentId` would create a cycle. */
export function wouldCreateCycle(
  categories: Array<{ id: string; parentId: string | null }>,
  nodeId: string,
  newParentId: string | null,
): boolean {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const seen = new Set<string>();
  let cur = newParentId;
  while (cur) {
    if (cur === nodeId) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

/** Throw if the product cannot be hard-deleted; the caller should archive instead. */
export async function assertDeletable(id: string): Promise<void> {
  const [everActive, referencedCount] = await Promise.all([
    prisma.productStatusHistory
      .count({ where: { productId: id, toStatus: 'ACTIVE' } })
      .then((n) => n > 0),
    prisma.productRelation.count({ where: { childId: id } }),
  ]);
  if (!canHardDelete(everActive, referencedCount)) {
    throw new ConflictError(
      'Product cannot be deleted (it was active or is referenced by other products/proposals). Archive it instead.',
    );
  }
}
