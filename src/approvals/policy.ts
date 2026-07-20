import type { ApprovalType } from '@prisma/client';
import { Permission } from '../authz/permissions.js';

/**
 * Each approval type maps to the permission an APPROVER must hold. Self-approval
 * and separation-of-duties are enforced separately in the service.
 */
export const APPROVAL_TYPES = [
  'DISCOUNT', 'MARGIN_EXCEPTION', 'CUSTOM_PRICING', 'CUSTOM_PRODUCT',
  'PRODUCT_RULE_OVERRIDE', 'FREIGHT_EXCEPTION', 'INSTALLATION_EXCEPTION',
  'LEGAL_EXCEPTION', 'PAYMENT_TERM_EXCEPTION', 'PROPOSAL_RELEASE',
] as const;
export type ApprovalTypeName = (typeof APPROVAL_TYPES)[number];

/** Permission required to DECIDE (approve/reject) each approval type. */
export const APPROVER_PERMISSION: Record<ApprovalTypeName, string> = {
  DISCOUNT: Permission.DISCOUNT_AUTHORIZE,
  MARGIN_EXCEPTION: Permission.MARGINS_READ,
  CUSTOM_PRICING: Permission.PRICING_OVERRIDE,
  CUSTOM_PRODUCT: Permission.PRODUCTS_ADMIN,
  PRODUCT_RULE_OVERRIDE: Permission.RULES_MANAGE,
  FREIGHT_EXCEPTION: Permission.PROPOSAL_REVIEW,
  INSTALLATION_EXCEPTION: Permission.PROPOSAL_REVIEW,
  LEGAL_EXCEPTION: Permission.PROPOSAL_REVIEW,
  PAYMENT_TERM_EXCEPTION: Permission.PROPOSAL_REVIEW,
  PROPOSAL_RELEASE: Permission.PROPOSAL_RELEASE,
};

/**
 * Approval types where the requester may NEVER be the approver, even if they
 * hold the approver permission (strict separation of duties).
 */
export const SELF_APPROVAL_PROHIBITED: Set<ApprovalTypeName> = new Set([
  'DISCOUNT', 'MARGIN_EXCEPTION', 'CUSTOM_PRICING', 'LEGAL_EXCEPTION',
  'PAYMENT_TERM_EXCEPTION', 'PROPOSAL_RELEASE',
]);

/** Default time-to-decision (hours) before an open request auto-expires. */
export const DEFAULT_EXPIRY_HOURS = 72;

export function approverPermissionFor(type: ApprovalType): string {
  return APPROVER_PERMISSION[type as ApprovalTypeName];
}

export function selfApprovalProhibited(type: ApprovalType): boolean {
  return SELF_APPROVAL_PROHIBITED.has(type as ApprovalTypeName);
}

/** Pure guard: may this user decide this request? */
export interface DecisionGuardInput {
  type: ApprovalType;
  requesterId: string;
  deciderId: string;
  deciderHasPermission: boolean;
  delegatedApproverIds?: string[];
}
export interface DecisionGuardResult {
  allowed: boolean;
  reason?: string;
}

export function canDecide(input: DecisionGuardInput): DecisionGuardResult {
  const isDelegate = (input.delegatedApproverIds ?? []).includes(input.deciderId);
  if (!input.deciderHasPermission && !isDelegate) {
    return { allowed: false, reason: 'decider lacks the required approver permission' };
  }
  if (input.deciderId === input.requesterId && selfApprovalProhibited(input.type)) {
    return { allowed: false, reason: 'self-approval is prohibited for this approval type' };
  }
  return { allowed: true };
}
