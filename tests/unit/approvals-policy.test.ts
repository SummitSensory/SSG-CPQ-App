import { describe, it, expect } from 'vitest';
import { canDecide, selfApprovalProhibited, approverPermissionFor, APPROVAL_TYPES } from '../../src/approvals/policy.js';
import { Permission } from '../../src/authz/permissions.js';

describe('approval policy — separation of duties & self-approval', () => {
  it('blocks self-approval where prohibited', () => {
    const r = canDecide({ type: 'DISCOUNT', requesterId: 'u1', deciderId: 'u1', deciderHasPermission: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/self-approval/);
  });

  it('allows self-approval where NOT prohibited (e.g. CUSTOM_PRODUCT) if permitted', () => {
    expect(selfApprovalProhibited('CUSTOM_PRODUCT')).toBe(false);
    const r = canDecide({ type: 'CUSTOM_PRODUCT', requesterId: 'u1', deciderId: 'u1', deciderHasPermission: true });
    expect(r.allowed).toBe(true);
  });

  it('blocks a decider without the required permission', () => {
    const r = canDecide({ type: 'DISCOUNT', requesterId: 'u1', deciderId: 'u2', deciderHasPermission: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/permission/);
  });

  it('allows a delegate even without the base permission', () => {
    const r = canDecide({ type: 'DISCOUNT', requesterId: 'u1', deciderId: 'u3', deciderHasPermission: false, delegatedApproverIds: ['u3'] });
    expect(r.allowed).toBe(true);
  });

  it('still blocks a delegate who is the requester when self-approval prohibited', () => {
    const r = canDecide({ type: 'PROPOSAL_RELEASE', requesterId: 'u1', deciderId: 'u1', deciderHasPermission: false, delegatedApproverIds: ['u1'] });
    expect(r.allowed).toBe(false);
  });

  it('permits an authorized, different approver', () => {
    const r = canDecide({ type: 'MARGIN_EXCEPTION', requesterId: 'u1', deciderId: 'u2', deciderHasPermission: true });
    expect(r.allowed).toBe(true);
  });

  it('maps every approval type to a defined approver permission', () => {
    const perms = new Set(Object.values(Permission));
    for (const t of APPROVAL_TYPES) {
      expect(perms.has(approverPermissionFor(t) as never)).toBe(true);
    }
  });
});
