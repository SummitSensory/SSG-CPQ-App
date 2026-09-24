import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The deal board's Taxes column (numbers99__1) on release.
 *
 * The proposal's Tax field is the Mat Freight Tax Pass-Through, which the deal board
 * already computes itself in formula_mkzde17n. Pushing it into numbers99__1 as well
 * put the same money on the deal twice, so the column now carries only the
 * cross-border charges Summit collects — and nothing is written when those could not
 * be read, rather than wiping a correct figure with 0.
 */

const state = vi.hoisted(() => ({
  border: { totalMinor: 0 } as { totalMinor: number } | Error,
  writes: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...orig,
    env: { ...orig.env, MONDAY_API_TOKEN: 't', MONDAY_DEALS_BOARD_ID: '6527740233' },
    isMondayPushConfigured: () => true,
  };
});
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    proposalVersion: {
      findUnique: async () => ({
        id: 'v1',
        expirationDate: null,
        // $10,000 of product, and a $250.00 mat freight tax pass-through.
        sections: [{ id: 'meta', data: { taxAmountMinor: 25000 } }],
        items: [
          { ref: 'a', lineType: 'PRODUCT', quantity: 1, unitPriceMinor: 1000000, costEach: 0 },
        ],
        proposal: {
          id: 'p1',
          number: 'P-2026-000148',
          title: 'SQ-2MBL2Z',
          organizationId: 'o1',
          opportunityId: null,
        },
      }),
    },
    integrationSyncLog: { create: async () => ({}) },
  },
}));
vi.mock('../../src/integrations/monday/dealLink.js', () => ({
  dealItemIdFor: async () => ({ itemId: '123', note: '' }),
}));
vi.mock('../../src/integrations/monday/client.js', () => ({
  setColumnValues: async (_b: string, _i: string, cols: Record<string, unknown>) => {
    state.writes.push(cols);
  },
  uploadFileToColumn: async () => undefined,
}));
vi.mock('../../src/crossborder/sellerCharges.js', () => ({
  sellerCollectedCharges: async () => {
    if (state.border instanceof Error) throw state.border;
    return state.border;
  },
}));

import { pushReleasedProposal, DEAL_COLUMNS } from '../../src/integrations/monday/proposalPush.js';

beforeEach(() => {
  state.writes = [];
  state.border = { totalMinor: 0 };
});

describe('release push → numbers99__1', () => {
  it('never carries the mat freight tax pass-through', async () => {
    const r = await pushReleasedProposal({ versionId: 'v1' });
    expect(r.pushed).toBe(true);
    expect(DEAL_COLUMNS.taxes).toBe('numbers99__1');
    // $250.00 of pass-through on the proposal, and the column says 0.00.
    expect(state.writes[0]![DEAL_COLUMNS.taxes]).toBe('0.00');
    expect(r.taxesMinor).toBe(0);
  });

  it('carries only the collected border charges on a Canadian job', async () => {
    state.border = { totalMinor: 123456 };
    const r = await pushReleasedProposal({ versionId: 'v1' });
    expect(state.writes[0]![DEAL_COLUMNS.taxes]).toBe('1234.56'); // not 1484.56
    expect(r.taxesMinor).toBe(123456);
  });

  it('leaves the column alone when the border charges cannot be read', async () => {
    state.border = new Error('snapshot unavailable');
    const r = await pushReleasedProposal({ versionId: 'v1' });
    expect(r.pushed).toBe(true);
    expect(DEAL_COLUMNS.taxes in state.writes[0]!).toBe(false);
    // The rest of the row still goes.
    expect(state.writes[0]![DEAL_COLUMNS.title]).toBe('SQ-2MBL2Z');
  });
});
