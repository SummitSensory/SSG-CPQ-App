import { prisma } from '../lib/prisma.js';
import type { Product, ProductStatus } from '@prisma/client';
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
    sku: p.sku, name: p.name, kind: p.kind, status: p.status,
    categoryId: p.categoryId, familyId: p.familyId,
    proposalDescription: p.proposalDescription, internalDescription: p.internalDescription,
    lengthIn: p.lengthIn, widthIn: p.widthIn, heightIn: p.heightIn,
    weightOz: p.weightOz, capacity: p.capacity,
    activeFrom: p.activeFrom, activeTo: p.activeTo, adminNotes: p.adminNotes,
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
      data: { productId: id, version: current.version, snapshot: buildSnapshot(current) as object, changedById: userId, changeNote: note ?? null },
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
      data: { productId: id, fromStatus: current.status, toStatus: to, reason: reason ?? null, changedById: userId },
    });
    // Safe deactivation: stamp activeTo when leaving ACTIVE.
    const extra = to === 'INACTIVE' || to === 'ARCHIVED' ? { activeTo: new Date() } : {};
    const started = to === 'ACTIVE' && !current.activeFrom ? { activeFrom: new Date() } : {};
    return tx.product.update({ where: { id }, data: { status: to, ...extra, ...started } });
  });
}

/** Throw if the product cannot be hard-deleted; the caller should archive instead. */
export async function assertDeletable(id: string): Promise<void> {
  const [everActive, referencedCount] = await Promise.all([
    prisma.productStatusHistory.count({ where: { productId: id, toStatus: 'ACTIVE' } }).then((n) => n > 0),
    prisma.productRelation.count({ where: { childId: id } }),
  ]);
  if (!canHardDelete(everActive, referencedCount)) {
    throw new ConflictError(
      'Product cannot be deleted (it was active or is referenced by other products/proposals). Archive it instead.',
    );
  }
}
