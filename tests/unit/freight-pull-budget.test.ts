import { describe, it, expect, vi } from 'vitest';

/**
 * /cron/freight-pull on 2026-09-29: "Task timed out after 30 seconds" — the platform
 * killed the sweep mid-list and nothing was reported. The sweep now stops itself when
 * its time budget is spent and says how many jobs it did not reach.
 */
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  env: {},
  isMondayPushConfigured: () => true,
}));
const findMany = vi.fn(async () => [
  { id: 'v1', proposalId: 'p1' },
  { id: 'v2', proposalId: 'p2' },
  { id: 'v3', proposalId: 'p3' },
]);
const count = vi.fn(async () => 0);
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { proposalVersion: { findMany }, freightEntry: { count }, freightRfq: { count } },
}));

const { pullOutstanding } = await import('../../src/integrations/monday/freightPull.js');

describe('pullOutstanding time budget', () => {
  it('stops before the first job when the budget is already spent, and says so', async () => {
    const out = await pullOutstanding('system:cron', { budgetMs: 0 });
    expect(out.scanned).toBe(0);
    expect(out.notReached).toBe(3);
    expect(count).not.toHaveBeenCalled();
  });
});
