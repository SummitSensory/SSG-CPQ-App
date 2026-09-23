import { describe, it, expect, vi } from 'vitest';
/**
 * An order's Project ID for portal matching: the order's own copy when accept
 * recorded one, otherwise the Project ID on its accepted proposal. In production a
 * third of orders (including SO-2026-000036) carried it on the proposal alone, so
 * their portal steps and delivery submissions never matched.
 */
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    acceptedOrder: {
      findMany: async () => [
        {
          id: 'recorded',
          mondayProjectId: '111',
          proposalVersionId: 'v1',
          portalOrderItemId: null,
        },
        {
          id: 'onProposal',
          mondayProjectId: null,
          proposalVersionId: 'v2',
          portalOrderItemId: null,
        },
        { id: 'noId', mondayProjectId: null, proposalVersionId: 'v3', portalOrderItemId: null },
      ],
    },
    proposalVersion: {
      findMany: async () => [
        { id: 'v2', sections: [{ id: 'meta', data: { projectId: ' 12876270330 ' } }] },
        { id: 'v3', sections: [{ id: 'meta', data: { projectId: 'not-an-id' } }] },
      ],
    },
  },
}));

import { ordersForProjectIds } from '../../src/integrations/monday/portalDelivery.js';

describe('ordersForProjectIds', () => {
  it("falls back to the accepted proposal's Project ID when the order has none", async () => {
    const r = await ordersForProjectIds(['12876270330']);
    expect(r).toEqual([{ id: 'onProposal', projectId: '12876270330', portalOrderItemId: null }]);
  });

  it("uses the order's own Project ID where it was recorded", async () => {
    expect((await ordersForProjectIds(['111'])).map((o) => o.id)).toEqual(['recorded']);
  });

  it('ignores a header value that is not an item id, and an empty request', async () => {
    expect(await ordersForProjectIds(['not-an-id'])).toEqual([]);
    expect(await ordersForProjectIds([])).toEqual([]);
  });
});
