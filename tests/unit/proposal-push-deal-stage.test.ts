import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * "Ready to Send to Customer" (the release) moves the monday deal's Deal Phase
 * (deal_stage) to "Proposal Sent".
 *
 * Written in a call of its own, after the deal figures: monday rejects a whole
 * change_multiple_column_values over a status label the column does not have, so a
 * label renamed on the board must cost the push only the stage, never the subtotal,
 * title or expiration.
 */

const state = vi.hoisted(() => ({
  writes: [] as Array<Record<string, unknown>>,
  failWhen: null as ((cols: Record<string, unknown>) => boolean) | null,
  logs: [] as Array<{ status: string; error?: string }>,
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
        sections: [],
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
    integrationSyncLog: {
      create: async (a: { data: { status: string; error?: string } }) => {
        state.logs.push(a.data);
        return {};
      },
    },
  },
}));
vi.mock('../../src/integrations/monday/dealLink.js', () => ({
  dealItemIdFor: async () => ({ itemId: '123', note: '' }),
}));
vi.mock('../../src/integrations/monday/client.js', () => ({
  setColumnValues: async (_b: string, _i: string, cols: Record<string, unknown>) => {
    if (state.failWhen?.(cols)) throw new Error('ColumnValueException: label not found');
    state.writes.push(cols);
  },
  uploadFileToColumn: async () => undefined,
}));
vi.mock('../../src/crossborder/sellerCharges.js', () => ({
  sellerCollectedCharges: async () => ({ totalMinor: 0 }),
}));

import {
  pushReleasedProposal,
  DEAL_COLUMNS,
  RELEASED_DEAL_STAGE,
} from '../../src/integrations/monday/proposalPush.js';

beforeEach(() => {
  state.writes = [];
  state.failWhen = null;
  state.logs = [];
});

describe('release push → Deal Phase', () => {
  it('sets deal_stage to "Proposal Sent", separately from the deal figures', async () => {
    const r = await pushReleasedProposal({ versionId: 'v1' });
    expect(DEAL_COLUMNS.stage).toBe('deal_stage');
    expect(RELEASED_DEAL_STAGE).toBe('Proposal Sent');
    expect(state.writes).toHaveLength(2);
    expect(DEAL_COLUMNS.stage in state.writes[0]!).toBe(false);
    expect(state.writes[1]).toEqual({ deal_stage: { label: 'Proposal Sent' } });
    expect(r.pushed).toBe(true);
    expect(r.dealStage).toBe('Proposal Sent');
    expect(r.dealStageError).toBeUndefined();
    expect(state.logs.at(-1)?.status).toBe('ok');
  });

  it('keeps the deal figures when the board rejects the stage label, and says so', async () => {
    state.failWhen = (cols) => DEAL_COLUMNS.stage in cols;
    const r = await pushReleasedProposal({ versionId: 'v1' });
    expect(r.pushed).toBe(true);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]![DEAL_COLUMNS.title]).toBe('SQ-2MBL2Z');
    expect(r.dealStage).toBeUndefined();
    expect(r.dealStageError).toMatch(/label not found/);
    expect(state.logs.at(-1)).toMatchObject({ status: 'error' });
    expect(state.logs.at(-1)?.error).toMatch(/Deal Phase not set/);
  });

  it('does not touch the stage when the deal figures themselves could not be written', async () => {
    state.failWhen = () => true;
    const r = await pushReleasedProposal({ versionId: 'v1' });
    expect(r.pushed).toBe(false);
    expect(state.writes).toHaveLength(0);
    expect(r.dealStage).toBeUndefined();
  });
});
