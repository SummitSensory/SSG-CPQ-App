import type { ProposalStatus } from '@prisma/client';

/**
 * Proposal-version status lifecycle. A version becomes immutable ("frozen") the
 * moment it is RELEASED; further business outcomes (accepted/rejected/expired)
 * are recorded but the content stays frozen. Editing requires a NEW version.
 */
const TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  DRAFT: ['INTERNAL_REVIEW', 'RELEASED'],
  INTERNAL_REVIEW: ['DRAFT', 'RELEASED'],
  RELEASED: ['ACCEPTED', 'REJECTED', 'EXPIRED'],
  ACCEPTED: [],
  REJECTED: [],
  EXPIRED: [],
};

/** Statuses at/after which the version content is immutable. */
export const FROZEN_STATUSES: ProposalStatus[] = ['RELEASED', 'ACCEPTED', 'REJECTED', 'EXPIRED'];

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function becomesFrozen(to: ProposalStatus): boolean {
  return to === 'RELEASED';
}

export function isFrozenStatus(status: ProposalStatus): boolean {
  return FROZEN_STATUSES.includes(status);
}

/** Format a sequential proposal number, e.g. P-2026-000042. */
export function formatProposalNumber(year: number, seq: number): string {
  return `P-${year}-${String(seq).padStart(6, '0')}`;
}
