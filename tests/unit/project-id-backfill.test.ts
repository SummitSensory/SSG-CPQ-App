import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * backfillProjectIdOnVersions asks monday.com only when the answer will be kept.
 *
 * Frozen versions are annotated, never written, so a proposal whose only gaps were
 * frozen versions used to make a live monday call (20 s timeout, retries on rate
 * limit) on every single open. Now that case is answered from the local link — the
 * linked deal's item id, which the Project ID column holds by convention — and the
 * live read is kept for drafts, where the value is saved.
 */

const fetchItemById = vi.fn();
const versionUpdate = vi.fn();

vi.mock('../../src/integrations/monday/discovery.js', () => ({
  fetchItemById: (...a: unknown[]) => fetchItemById(...a),
}));
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    opportunity: {
      findFirst: async () => ({ mondayItemId: '12414494509' }),
      findMany: async () => [],
    },
    proposalVersion: { update: (...a: unknown[]) => versionUpdate(...a) },
  },
}));

const blank = (id: string, status: string, frozen: boolean) => ({
  id,
  status,
  frozen,
  sections: [] as unknown,
});

beforeEach(() => {
  fetchItemById.mockReset();
  versionUpdate.mockReset();
  fetchItemById.mockResolvedValue({ text: { pulse_id_mm5kc9f8: '7777' } });
  versionUpdate.mockResolvedValue({});
});

describe('backfillProjectIdOnVersions', () => {
  it('does not call monday when only frozen versions are missing the number', async () => {
    const { backfillProjectIdOnVersions, projectIdOfSections } =
      await import('../../src/crm/projectId.js');
    const out = await backfillProjectIdOnVersions('org1', [
      blank('v1', 'RELEASED', true),
      blank('v2', 'ACCEPTED', true),
    ]);
    expect(fetchItemById).not.toHaveBeenCalled();
    expect(versionUpdate).not.toHaveBeenCalled();
    expect(out.map((v) => projectIdOfSections(v.sections))).toEqual(['12414494509', '12414494509']);
  });

  it('still reads monday live when a draft will store the answer', async () => {
    const { backfillProjectIdOnVersions, projectIdOfSections } =
      await import('../../src/crm/projectId.js');
    const out = await backfillProjectIdOnVersions('org1', [
      blank('v1', 'RELEASED', true),
      blank('v2', 'DRAFT', false),
    ]);
    expect(fetchItemById).toHaveBeenCalledTimes(1);
    expect(versionUpdate).toHaveBeenCalledTimes(1);
    expect(projectIdOfSections(out[1]!.sections)).toBe('7777');
  });

  it('makes no lookup at all when every version already carries one', async () => {
    const { backfillProjectIdOnVersions } = await import('../../src/crm/projectId.js');
    const withId = {
      id: 'v1',
      status: 'DRAFT',
      frozen: false,
      sections: [{ id: 'meta', data: { projectId: '4821' } }] as unknown,
    };
    const out = await backfillProjectIdOnVersions('org1', [withId]);
    expect(out[0]).toBe(withId);
    expect(fetchItemById).not.toHaveBeenCalled();
  });
});
