import { createHash } from 'node:crypto';

/**
 * Pure helpers for locking an accepted proposal into an operational order.
 * Kept side-effect free so the immutability logic (snapshot + integrity hash +
 * default handoff scaffold) is fully unit-testable.
 */

export interface AcceptedVersionLike {
  id: string;
  version: number;
  proposalId: string;
  sections: unknown;
  items: unknown;
  priceSnapshotId: string | null;
  status: string;
  frozen: boolean;
}

export interface PriceSnapshotLike {
  id: string;
  currency: string;
  grandTotal: bigint;
  breakdown: unknown;
}

export interface ContentSnapshot {
  proposalVersionId: string;
  acceptedVersion: number;
  priceSnapshotId: string;
  currency: string;
  grandTotalMinor: string;
  depositDueMinor: string;
  sections: unknown;
  items: unknown;
}

function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.round(v));
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

/** Deposit due comes from the frozen payment schedule; 0 means none required. */
export function depositFromSnapshot(snap: PriceSnapshotLike): bigint {
  const b = (snap.breakdown ?? {}) as { payment?: { deposit?: unknown } };
  return toBig(b.payment?.deposit ?? 0);
}

/** Build the frozen content snapshot stored on the order. */
export function buildContentSnapshot(version: AcceptedVersionLike, snap: PriceSnapshotLike): ContentSnapshot {
  return {
    proposalVersionId: version.id,
    acceptedVersion: version.version,
    priceSnapshotId: snap.id,
    currency: snap.currency,
    grandTotalMinor: snap.grandTotal.toString(),
    depositDueMinor: depositFromSnapshot(snap).toString(),
    sections: version.sections,
    items: version.items,
  };
}

/**
 * Deterministic integrity hash over the accepted content. Recomputing it later
 * from the live proposal version detects any drift from what was accepted.
 */
export function computeIntegrityHash(snapshot: ContentSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify({
      v: snapshot.proposalVersionId,
      n: snapshot.acceptedVersion,
      p: snapshot.priceSnapshotId,
      g: snapshot.grandTotalMinor,
      s: snapshot.sections,
      i: snapshot.items,
    }))
    .digest('hex');
}

export interface SeededRequirement {
  category: string;
  title: string;
}

/** Baseline operational requirements seeded on every new order. */
export function defaultRequirements(): SeededRequirement[] {
  return [
    { category: 'PRODUCTION', title: 'Confirm production requirements' },
    { category: 'CUSTOM_PRODUCT', title: 'Confirm custom product specifications' },
    { category: 'SHIPPING', title: 'Confirm shipping requirements & freight' },
    { category: 'INSTALLATION', title: 'Confirm installation requirements' },
    { category: 'TRAINING', title: 'Confirm training requirements' },
    { category: 'CUSTOMER_RESPONSIBILITY', title: 'Document customer responsibilities' },
    { category: 'FACILITY_ACCESS', title: 'Collect facility access information' },
    { category: 'REQUIRED_DOCUMENT', title: 'Collect required documents (COI, W-9, PO)' },
  ];
}

export interface SeededTask {
  title: string;
  assigneeRole: string | null;
  category: string | null;
}

/** Baseline internal tasks seeded on every new order (owners are roles). */
export function defaultTasks(depositRequired: boolean): SeededTask[] {
  const tasks: SeededTask[] = [];
  if (depositRequired) tasks.push({ title: 'Create QuickBooks deposit invoice', assigneeRole: 'ACCOUNTING', category: null });
  tasks.push(
    { title: 'Create or update monday.com project', assigneeRole: 'PROJECT_MANAGER', category: null },
    { title: 'Verify procurement list & source items', assigneeRole: 'OPERATIONS', category: 'PRODUCTION' },
    { title: 'Schedule shipping / delivery', assigneeRole: 'OPERATIONS', category: 'SHIPPING' },
    { title: 'Schedule installation', assigneeRole: 'PROJECT_MANAGER', category: 'INSTALLATION' },
    { title: 'Schedule training', assigneeRole: 'PROJECT_MANAGER', category: 'TRAINING' },
  );
  return tasks;
}

interface ItemLike { ref?: string; productId?: string; name?: string; quantity?: number; kind?: string }

/** Build the initial procurement list from the accepted INCLUDED items. */
export function procurementFromItems(items: unknown): Array<{ productId: string | null; name: string; quantity: number }> {
  if (!Array.isArray(items)) return [];
  return (items as ItemLike[])
    .filter((i) => (i.kind ?? 'INCLUDED') === 'INCLUDED')
    .map((i) => ({ productId: i.productId ?? null, name: i.name ?? i.ref ?? 'Item', quantity: i.quantity ?? 1 }));
}
