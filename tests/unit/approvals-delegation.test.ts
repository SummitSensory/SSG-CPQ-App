import { describe, it, expect, vi } from 'vitest';

/**
 * createDelegation must refuse to hand away authority the delegator does not
 * hold. Before this guard, POST /approvals/delegations required only
 * requireAuth (any authenticated role) and performed no permission check at
 * all — any two accounts, including READ_ONLY/INSTALLER, could create a
 * no-type ("blanket") delegation, which activeDelegateIds' own
 * `OR: [{ type }, { type: null }]` treats as covering every approval type,
 * including PROPOSAL_RELEASE. See src/approvals/service.ts assertMayDelegate.
 */

const created: unknown[] = [];

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    approvalDelegation: {
      create: async ({ data }: { data: unknown }) => {
        created.push(data);
        return { id: 'del-1', ...(data as object) };
      },
    },
  },
}));

vi.mock('../../src/lib/audit.js', () => ({
  recordAudit: async () => {},
}));

vi.mock('../../src/approvals/notify.js', () => ({
  notifier: { send: async () => {} },
}));

const { createDelegation } = await import('../../src/approvals/service.js');

describe('createDelegation — cannot delegate authority you do not hold', () => {
  it('refuses a specific-type delegation from a role lacking that approver permission', async () => {
    await expect(
      createDelegation('u1', 'READ_ONLY' as never, 'u2', 'DISCOUNT', null, 'u1'),
    ).rejects.toThrow(/lacks that authority|cannot delegate/i);
  });

  it('allows a specific-type delegation from a role that holds the approver permission', async () => {
    // SALES_MANAGER holds DISCOUNT_AUTHORIZE per src/authz/permissions.ts.
    const result = await createDelegation(
      'u1',
      'SALES_MANAGER' as never,
      'u2',
      'DISCOUNT',
      null,
      'u1',
    );
    expect(result.id).toBe('del-1');
  });

  it('refuses a blanket (no-type) delegation from a role that does not hold every approver permission', async () => {
    await expect(
      createDelegation('u1', 'SALES_MANAGER' as never, 'u2', null, null, 'u1'),
    ).rejects.toThrow(/blanket/i);
  });

  it('rejects an unrecognized approval type before any authority check', async () => {
    await expect(
      createDelegation('u1', 'SYSTEM_ADMIN' as never, 'u2', 'NOT_A_REAL_TYPE' as never, null, 'u1'),
    ).rejects.toThrow(/unknown approval type/i);
  });

  it('still refuses delegating to yourself, independent of the authority check', async () => {
    await expect(
      createDelegation('u1', 'SYSTEM_ADMIN' as never, 'u1', 'DISCOUNT', null, 'u1'),
    ).rejects.toThrow(/yourself/i);
  });

  it('allows a blanket delegation from a role holding every approver permission (SYSTEM_ADMIN)', async () => {
    const result = await createDelegation('u1', 'SYSTEM_ADMIN' as never, 'u2', null, null, 'u1');
    expect(result.id).toBe('del-1');
  });
});
