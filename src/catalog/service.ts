import { prisma } from '../lib/prisma.js';
import type { Prisma, PrismaClient, Product, ProductCategory, ProductStatus } from '@prisma/client';
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

/** A client that can run inside an interactive transaction, or the root client. */
export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The priced half of a part follows its catalog status.
 *
 * `Sku.active` is what the proposal builder's part picker and
 * `/catalog/items/defaults` read to decide whether a part is quotable, and
 * `Product.status` is what the tree and every status control write. They are two
 * records of one fact, so every status change writes both, in the same
 * transaction: a part archived in the tree must stop being offered at its old
 * price, and a part reactivated must come back. Matched case-insensitively, like
 * every other part-number join in the catalog.
 */
export async function syncSkuActive(db: Db, part: string, status: ProductStatus): Promise<void> {
  await db.sku.updateMany({
    where: { part: { equals: part, mode: 'insensitive' } },
    data: { active: status === 'ACTIVE' },
  });
}

/**
 * The status state machine, inside the caller's transaction. Writes the history
 * row, stamps the active window, and brings `Sku.active` along (see syncSkuActive).
 */
export async function changeStatusTx(
  tx: Db,
  id: string,
  to: ProductStatus,
  userId: string,
  reason?: string,
): Promise<Product> {
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
  const updated = await tx.product.update({
    where: { id },
    data: { status: to, ...extra, ...started },
  });
  await syncSkuActive(tx, current.sku, to);
  return updated;
}

export async function changeStatus(
  id: string,
  to: ProductStatus,
  userId: string,
  reason?: string,
): Promise<Product> {
  return prisma.$transaction((tx) => changeStatusTx(tx, id, to, userId, reason));
}

/**
 * "Make this part quotable / stop quoting it", from the catalog list's toggle,
 * the Delete dialog's "Deactivate instead", and `PATCH /catalog/items/:part
 * {active}`. All three used to write the flag (and sometimes the status)
 * directly, so ARCHIVED → ACTIVE and DRAFT → INACTIVE went straight through.
 *
 *   active: true  → the product becomes ACTIVE through the state machine, so an
 *                   ARCHIVED part is a 409 rather than quietly revived.
 *   active: false → an ACTIVE product becomes INACTIVE. A DRAFT or ARCHIVED one is
 *                   already not quotable and keeps its status (DRAFT → INACTIVE is
 *                   not a legal move, and it would also make a never-live part
 *                   look ever-active and so undeletable).
 *
 * Either way the Sku ends up agreeing with the product's resulting status. A
 * priced row with no catalog record has no state machine, so its flag is set as
 * asked.
 */
export async function setPartActiveTx(
  tx: Db,
  product: { id: string; sku: string; status: ProductStatus } | null,
  part: string,
  active: boolean,
  userId: string,
  reason: string,
): Promise<ProductStatus | null> {
  if (!product) {
    await tx.sku.updateMany({ where: { part }, data: { active } });
    return null;
  }
  let status = product.status;
  if (active) {
    status = (await changeStatusTx(tx, product.id, 'ACTIVE', userId, reason)).status;
  } else if (product.status === 'ACTIVE') {
    status = (await changeStatusTx(tx, product.id, 'INACTIVE', userId, reason)).status;
  }
  await syncSkuActive(tx, product.sku, status);
  return status;
}

/**
 * The history row for a part that is BORN live, as a nested write for
 * `product.create` — so it lands in the same statement as the product itself.
 *
 * Parts created ACTIVE (the catalog list's New part form, the tree import) never
 * went through changeStatus, so they had no status history — and "was it ever
 * active" was answered from that history alone, which is how a live part could be
 * hard-deleted.
 */
export function bornStatusHistory(
  status: ProductStatus,
  userId: string,
): Pick<Prisma.ProductUncheckedCreateInput, 'statusHistory'> {
  if (status === 'DRAFT') return {};
  return {
    statusHistory: {
      create: { fromStatus: null, toStatus: status, reason: 'created', changedById: userId },
    },
  };
}

/**
 * Resolve the category a part is filed under. By id when the caller has one —
 * category names are not unique — else by exact name, refusing a name that more
 * than one category carries rather than picking one of them arbitrarily.
 */
export async function resolveCategoryRef(
  db: Db,
  ref: { categoryId?: string | null; name?: string | null },
): Promise<{ id: string; name: string }> {
  if (ref.categoryId) {
    const c = await db.productCategory.findUnique({
      where: { id: ref.categoryId },
      select: { id: true, name: true },
    });
    if (!c) throw new ValidationError('That product category no longer exists');
    return c;
  }
  const name = (ref.name ?? '').trim();
  const found = await db.productCategory.findFirst({
    where: { name },
    select: { id: true, name: true },
  });
  if (!found) throw new ValidationError(`No product category named “${name}”`);
  const another = await db.productCategory.findFirst({
    where: { name, NOT: { id: found.id } },
    select: { id: true },
  });
  if (another && another.id !== found.id)
    throw new ValidationError(
      `More than one product category is named “${name}”, so the name alone cannot say ` +
        `which one is meant. Pick the category from the list (it sends the category's id).`,
    );
  return found;
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

/**
 * Whether a product has ever been live, and so must be kept for history.
 *
 * Not from the status history alone: parts created ACTIVE by the catalog list or
 * the tree import had no history row until recordCreatedStatus existed, and the
 * rows written before it still have none. The current status and the stamped
 * active window say the same thing and cannot be missing.
 */
export async function isEverActive(
  db: Db,
  product: { id: string; status: ProductStatus; activeFrom: Date | null },
): Promise<boolean> {
  if (product.status !== 'DRAFT' || product.activeFrom != null) return true;
  const n = await db.productStatusHistory.count({
    where: { productId: product.id, toStatus: 'ACTIVE' },
  });
  return n > 0;
}

/**
 * How many saved proposals reference this part. Proposal items are JSON, so this
 * scans them — the volume is small and the answer is what makes a delete safe.
 */
export async function proposalUsage(
  db: Db,
  part: string,
): Promise<{ count: number; numbers: string[] }> {
  const versions = await db.proposalVersion.findMany({
    select: { items: true, proposal: { select: { number: true } } },
  });
  const numbers = new Set<string>();
  for (const v of versions) {
    const items = Array.isArray(v.items) ? (v.items as { sku?: string; name?: string }[]) : [];
    if (items.some((i) => i && (i.sku === part || i.name === part))) numbers.add(v.proposal.number);
  }
  return { count: numbers.size, numbers: [...numbers].slice(0, 5) };
}

export interface PartDeletion {
  product: Product | null;
  sku: { id: string; active: boolean } | null;
  proposalCount: number;
  proposalNumbers: string[];
  everActive: boolean;
  /** Other products that list this one as a component, variant or accessory. */
  referencedBy: number;
  /** Why it cannot be deleted, or null when it can. */
  reason: string | null;
}

/**
 * Everything that decides whether a part may be hard-deleted, in one place, for
 * `GET /catalog/items/:part/usage`, `DELETE /catalog/items/:part` and
 * `DELETE /catalog/products/:id` — which used to answer the question three
 * different ways (the last skipped the proposal check and left the Sku behind).
 */
export async function partDeletion(db: Db, part: string): Promise<PartDeletion> {
  const [product, sku, usage] = await Promise.all([
    db.product.findUnique({ where: { sku: part } }),
    db.sku.findUnique({ where: { part }, select: { id: true, active: true } }),
    proposalUsage(db, part),
  ]);
  const [everActive, referencedBy] = product
    ? await Promise.all([
        isEverActive(db, product),
        db.productRelation.count({ where: { childId: product.id } }),
      ])
    : [false, 0];
  const reason =
    usage.count > 0
      ? `Used on ${usage.count} proposal${usage.count === 1 ? '' : 's'} (${usage.numbers.join(', ')}${usage.count > usage.numbers.length ? '…' : ''}) — deactivate it instead so historical proposals keep their pricing.`
      : everActive
        ? 'This product has been active, so its history is kept — deactivate or archive it instead.'
        : referencedBy > 0
          ? `Another product lists this part as one of its parts (${referencedBy} link${referencedBy === 1 ? '' : 's'}) — remove it from there first, or archive it instead.`
          : null;
  return {
    product,
    sku,
    proposalCount: usage.count,
    proposalNumbers: usage.numbers,
    everActive,
    referencedBy,
    reason,
  };
}

/** Both halves of a part, and what hangs off the catalog half, in one transaction. */
export async function deletePartRecords(
  tx: Db,
  d: { product: { id: string } | null; sku: { id: string } | null },
): Promise<void> {
  if (d.sku) await tx.sku.delete({ where: { id: d.sku.id } });
  if (d.product) {
    await tx.productCost.deleteMany({ where: { productId: d.product.id } });
    await tx.productSourcing.deleteMany({ where: { productId: d.product.id } });
    await tx.product.delete({ where: { id: d.product.id } });
  }
}

/**
 * Every node's tier as its parent chain says it is: 1 for a top-level node, parent
 * + 1 below that. `tierLevel` is stored, but it is a consequence of `parentId`, not
 * an independent fact — a node stored as tier 1 under a parent was the audit's
 * finding. A node whose chain loops, or reaches a parent that does not exist in
 * `nodes`, maps to null.
 */
export function deriveTiers(
  nodes: Array<{ id: string; parentId: string | null }>,
): Map<string, number | null> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, number | null>();
  const tierOf = (id: string): number | null => {
    if (out.has(id)) return out.get(id)!;
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = id;
    let base: number | null = 0;
    while (cur) {
      if (out.has(cur)) {
        base = out.get(cur)!;
        break;
      }
      if (seen.has(cur) || !byId.has(cur)) {
        base = null;
        break;
      }
      seen.add(cur);
      chain.push(cur);
      cur = byId.get(cur)!.parentId;
    }
    // Walk back down the chain: the last entry is the topmost node reached.
    for (let i = chain.length - 1; i >= 0; i--) {
      base = base == null ? null : base + 1;
      out.set(chain[i]!, base);
    }
    return out.get(id) ?? null;
  };
  for (const n of nodes) tierOf(n.id);
  return out;
}

/** Ids of every node below `id`, at any depth. */
export function descendantIds(
  nodes: Array<{ id: string; parentId: string | null }>,
  id: string,
): string[] {
  const kids = new Map<string, string[]>();
  for (const n of nodes)
    if (n.parentId) kids.set(n.parentId, (kids.get(n.parentId) ?? []).concat(n.id));
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const queue = [...(kids.get(id) ?? [])];
  while (queue.length) {
    const c = queue.shift()!;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    queue.push(...(kids.get(c) ?? []));
  }
  return out;
}

/** Throw if the product cannot be hard-deleted; the caller should archive instead. */
export async function assertDeletable(id: string): Promise<void> {
  const product = await prisma.product.findUnique({ where: { id }, select: { sku: true } });
  if (!product) throw new ValidationError('Product not found');
  const d = await partDeletion(prisma, product.sku);
  if (d.reason) throw new ConflictError(d.reason);
}
