import { prisma } from './prisma.js';
import { logger } from './logger.js';

/**
 * Recording a change with both sides of it.
 *
 * `recordAudit` answers who touched a record and when. It stores the fields that were
 * SENT, so it cannot answer what the value was before — and that is the question people
 * actually arrive with: this cost looks wrong, what was it in March, who changed it.
 *
 * The formula editor solved this years ago with its own revision table holding complete
 * snapshots either side of every change. This is the same approach, generalised, for the
 * records where the previous value is worth keeping.
 *
 * Two rules:
 *
 *   1. **Snapshots, not diffs.** A diff is only readable against the shape of the record
 *      at the time it was written. A snapshot stays readable after a column is added,
 *      renamed or dropped.
 *   2. **Never throw.** A history write must not be able to fail the operation it is
 *      recording. Losing one revision row is bad; refusing a price change because the
 *      history table hiccuped is worse.
 */

export type RevisionAction = 'create' | 'update' | 'delete' | 'restore';

export interface RevisionInput {
  entity: string;
  entityId: string;
  /** SKU or name AS IT READ AT THE TIME, so the row survives a rename. */
  label?: string | null;
  action: RevisionAction;
  actorId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  note?: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Field names whose values differ.
 *
 * Compared as JSON, so nested shapes (a bundle's component list) count as one field
 * that either changed or did not. That is the right granularity here: nobody asks
 * which array index moved, they ask whether the components changed.
 */
export function changedFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  if (!before || !after) return [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.filter((k) => {
    const a = before[k];
    const b = after[k];
    if (a instanceof Date || b instanceof Date) {
      return String(a ?? '') !== String(b ?? '');
    }
    return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  });
}

/**
 * BigInt and Date do not survive JSON.stringify, and Prisma hands back both. Converted
 * here rather than at every call site, so a snapshot is always storable.
 */
function serializable(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(serializable);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = serializable(val);
    return out;
  }
  return v;
}

/** Append a revision. Never throws — see rule 2 above. */
export async function recordRevision(input: RevisionInput): Promise<void> {
  try {
    const before = (input.before ? serializable(input.before) : null) as object | null;
    const after = (input.after ? serializable(input.after) : null) as object | null;
    const changed = changedFields(
      before as Record<string, unknown> | null,
      after as Record<string, unknown> | null,
    );
    // An update that changed nothing is not history, it is noise — someone opened a
    // form and saved it. Creates and deletes are always recorded.
    if (input.action === 'update' && !changed.length) return;
    await prisma.entityRevision.create({
      data: {
        entity: input.entity,
        entityId: input.entityId,
        label: input.label ?? null,
        action: input.action,
        actorId: input.actorId,
        before,
        after,
        changed: changed as object,
        note: input.note ?? null,
      },
    });
  } catch (err) {
    logger.warn(
      { err, entity: input.entity, entityId: input.entityId },
      'revision not recorded — the change itself succeeded',
    );
  }
}

/**
 * The fields worth keeping for a catalog product. Everything else on the record is
 * either derived, a relation, or noise in a history view.
 */
export function productSnapshot(p: Record<string, unknown>): Record<string, unknown> {
  const keep = [
    'sku',
    'name',
    'kind',
    'status',
    'categoryId',
    'familyId',
    'listPriceMinor',
    'unitCostMinor',
    'currency',
    'uom',
    'shortDescription',
    'longDescription',
    'activeFrom',
    'activeTo',
    'version',
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (k in p) out[k] = p[k];
  return out;
}

/** The fields worth keeping for a SKU — the catalog record the BOM prices from. */
export function skuSnapshot(s: Record<string, unknown>): Record<string, unknown> {
  const keep = [
    'part',
    'description',
    'manufacturer',
    'vendorPartNumber',
    'unitCostMinor',
    'listPriceMinor',
    'unitWeightLbs',
    'uom',
    'active',
    'requiresPowderColor',
    'freeIssueVendor',
    'leadTimeDays',
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (k in s) out[k] = s[k];
  return out;
}
