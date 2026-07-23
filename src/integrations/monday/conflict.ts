/**
 * Source-of-truth registry and approved conflict rules for the monday.com sync.
 * The engine consults this before applying ANY inbound change so a CPQ
 * authoritative value is never silently overwritten.
 */

export type SourceOfTruth = 'CPQ' | 'MONDAY' | 'SHARED';

/** Per synced field: who wins in a conflict. */
export const FIELD_SOURCE_OF_TRUTH: Record<string, SourceOfTruth> = {
  'opportunity.stage': 'SHARED',
  'opportunity.owner': 'CPQ',
  'opportunity.amount': 'CPQ',
  'opportunity.closeDate': 'CPQ',
  'project.status': 'MONDAY',
  'contact.email': 'CPQ',
  'contact.phone': 'CPQ',
  'installation': 'CPQ',
  'shipping': 'CPQ',
  'files': 'CPQ',
};

/**
 * Approved conflict rules: a field may be updated FROM monday only if listed
 * here. This is the single, auditable place where inbound writes are allowed.
 */
export interface ConflictRule {
  field: string;
  /** Allow monday to write this field into CPQ. */
  allowInbound: boolean;
  note: string;
}

export const APPROVED_CONFLICT_RULES: ConflictRule[] = [
  { field: 'opportunity.stage', allowInbound: true, note: 'Sales may advance the deal stage in monday; mirrored to CPQ.' },
  { field: 'project.status', allowInbound: true, note: 'Delivery/project status is owned by the monday Projects board.' },
];

export type InboundDecision =
  | { allowed: true; rule: ConflictRule }
  | { allowed: false; reason: string };

/**
 * Decide whether an inbound change to `field` may be applied. Pure and
 * side-effect free — callers log the result.
 */
export function decideInbound(field: string): InboundDecision {
  const sot = FIELD_SOURCE_OF_TRUTH[field];
  if (sot === undefined) return { allowed: false, reason: `unknown field "${field}" — not synced` };
  if (sot === 'CPQ') return { allowed: false, reason: `field "${field}" is CPQ-authoritative; inbound write refused` };
  const rule = APPROVED_CONFLICT_RULES.find((r) => r.field === field && r.allowInbound);
  if (!rule) return { allowed: false, reason: `no approved conflict rule permits inbound write to "${field}"` };
  return { allowed: true, rule };
}

export function sourceOfTruth(field: string): SourceOfTruth | undefined {
  return FIELD_SOURCE_OF_TRUTH[field];
}
