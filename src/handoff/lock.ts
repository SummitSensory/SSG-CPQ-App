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
export function buildContentSnapshot(
  version: AcceptedVersionLike,
  snap: PriceSnapshotLike,
): ContentSnapshot {
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
    .update(
      JSON.stringify({
        v: snapshot.proposalVersionId,
        n: snapshot.acceptedVersion,
        p: snapshot.priceSnapshotId,
        g: snapshot.grandTotalMinor,
        s: snapshot.sections,
        i: snapshot.items,
      }),
    )
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
  if (depositRequired)
    tasks.push({
      title: 'Create QuickBooks deposit invoice',
      assigneeRole: 'ACCOUNTING',
      category: null,
    });
  tasks.push(
    {
      title: 'Create or update monday.com project',
      assigneeRole: 'PROJECT_MANAGER',
      category: null,
    },
    {
      title: 'Verify Bill of Materials & order parts',
      assigneeRole: 'OPERATIONS',
      category: 'PRODUCTION',
    },
    { title: 'Schedule shipping / delivery', assigneeRole: 'OPERATIONS', category: 'SHIPPING' },
    { title: 'Schedule installation', assigneeRole: 'PROJECT_MANAGER', category: 'INSTALLATION' },
    { title: 'Schedule training', assigneeRole: 'PROJECT_MANAGER', category: 'TRAINING' },
  );
  return tasks;
}

interface KitComponent {
  part?: string;
  name?: string;
  qty?: number;
  unitCostMinor?: number;
  weightLbs?: number;
}
interface ItemLike {
  ref?: string;
  sku?: string;
  productId?: string;
  name?: string;
  quantity?: number;
  kind?: string;
  components?: KitComponent[] | null;
}

export interface ProcurementSeed {
  productId: string | null;
  sku: string | null;
  name: string;
  quantity: number;
  /** True for a line produced by expanding a kit; groups it into the BOM's hardware block. */
  isHardwareComponent?: boolean;
  /** The kit this line came out of, e.g. 'H-1000'. */
  kitSku?: string | null;
  /** Cost/weight carried from the kit breakdown, since the fastener may not be in the SKU master. */
  unitCostMinor?: number | null;
  unitWeightLbs?: number | null;
}

/**
 * Build the initial procurement list from the accepted INCLUDED items. The part
 * number rides along (`sku`, falling back to `ref`) because it is the key the
 * vendor lookup uses — without it every line prints a blank vendor.
 *
 * A KIT line is expanded here. The proposal shows one "Hardware Kit" (H-1000)
 * because that is what the customer buys, but nobody can build from that — the shop
 * needs every fastener and its count.
 *
 * The kit line itself is REPLACED by its components rather than kept alongside
 * them. The kit's price is by definition the sum of its parts, so keeping both
 * would double the hardware on every BOM total. The proposal is untouched — the
 * customer still sees one line — and the BOM total comes out identical while
 * carrying real per-part weights, which also stops H-1000 contributing 0 lb to
 * freight.
 */
export function procurementFromItems(items: unknown): ProcurementSeed[] {
  if (!Array.isArray(items)) return [];
  const out: ProcurementSeed[] = [];
  for (const i of (items as ItemLike[]).filter((x) => (x.kind ?? 'INCLUDED') === 'INCLUDED')) {
    // `ref` is a random line id, NOT a part number — never let it into `sku`.
    const sku = (i.sku || '').trim() || null;
    const qty = i.quantity ?? 1;
    const parts = (i.components ?? []).filter((c) => (c.part || '').trim() && c.qty);

    if (!parts.length) {
      out.push({ productId: i.productId ?? null, sku, name: i.name ?? 'Item', quantity: qty });
      continue;
    }

    for (const c of parts) {
      out.push({
        productId: null,
        sku: (c.part as string).trim(),
        name: c.name || (c.part as string).trim(),
        // The kit's own quantity multiplies through: two kits means twice the bolts.
        quantity: (c.qty as number) * (qty || 1),
        isHardwareComponent: true,
        kitSku: sku,
        unitCostMinor: c.unitCostMinor ?? null,
        unitWeightLbs: c.weightLbs ?? null,
      });
    }
  }
  return out;
}
