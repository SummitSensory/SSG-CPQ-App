import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A released proposal that carries the W-9 as a reference document sets the deal's
 * W-9 column (color_mm6sjm74) to "W9 Sent". One without it leaves the column alone.
 *
 * The W-9 is recognised by name, not by a fixed key: each year's W-9 is a new upload
 * with a new key, so a hard-coded key would stop matching the next January.
 */

type Doc = { key: string; title: string; filename: string; active: boolean };

const state = vi.hoisted(() => ({
  writes: [] as Array<Record<string, unknown>>,
  failWhen: null as ((cols: Record<string, unknown>) => boolean) | null,
  logs: [] as Array<{ status: string; error?: string }>,
  selected: [] as string[],
  library: [] as Doc[],
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
        sections: [{ id: 'meta', data: { referenceDocKeys: state.selected } }],
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
    referenceDocument: {
      findMany: async (a: { where: { key: { in: string[] }; active: boolean } }) =>
        state.library.filter((d) => a.where.key.in.includes(d.key) && d.active === a.where.active),
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
  mondayQuery: async () => ({ items: [{ column_values: [{ id: 'deal_stage', text: '' }] }] }),
}));
vi.mock('../../src/crossborder/sellerCharges.js', () => ({
  sellerCollectedCharges: async () => ({ totalMinor: 0 }),
}));

import {
  pushReleasedProposal,
  DEAL_COLUMNS,
  W9_SENT_LABEL,
} from '../../src/integrations/monday/proposalPush.js';
import { metaOf } from '../../src/proposals/analytics.js';

const W9: Doc = {
  key: 'SUMMIT_SENSORY_GYM_2026_W9',
  title: 'Summit Sensory Gym - 2026 W9',
  filename: 'Summit-Sensory-Gym-2026-W9.pdf',
  active: true,
};
const CATALOG: Doc = {
  key: 'CUSTOMER_RECOMMENDATION_CATALOG_2026',
  title: 'Customer Recommendation Catalog (2026)',
  filename: '2026-SSG-Product-Recommendation-Catalog-v5_opt.pdf',
  active: true,
};

const w9Writes = () => state.writes.filter((w) => DEAL_COLUMNS.w9 in w);

beforeEach(() => {
  state.writes = [];
  state.failWhen = null;
  state.logs = [];
  state.selected = [];
  state.library = [W9, CATALOG];
});

describe('release push → W-9 column', () => {
  it('the test fixture really stores the selection where the push reads it', () => {
    state.selected = [W9.key];
    const meta = metaOf([{ id: 'meta', data: { referenceDocKeys: state.selected } }]) as {
      referenceDocKeys?: unknown;
    };
    expect(meta.referenceDocKeys).toEqual([W9.key]);
  });

  it('sets "W9 Sent" when the W-9 goes out with the proposal', async () => {
    state.selected = [CATALOG.key, W9.key];
    const r = await pushReleasedProposal({ versionId: 'v1' });
    expect(DEAL_COLUMNS.w9).toBe('color_mm6sjm74');
    expect(W9_SENT_LABEL).toBe('W9 Sent');
    expect(w9Writes()).toEqual([{ color_mm6sjm74: { label: 'W9 Sent' } }]);
    expect(r.w9Sent).toBe(true);
    expect(r.dealStage).toBe('Proposal Sent');
    expect(state.logs.at(-1)?.status).toBe('ok');
  });

  it('leaves the W-9 column alone when no W-9 is attached', async () => {
    state.selected = [CATALOG.key];
    const r = await pushReleasedProposal({ versionId: 'v1' });
    expect(w9Writes()).toHaveLength(0);
    expect(r.w9Sent).toBeUndefined();
  });

  it('leaves it alone when nothing is attached at all', async () => {
    const r = await pushReleasedProposal({ versionId: 'v1' });
    expect(w9Writes()).toHaveLength(0);
    expect(r.w9Sent).toBeUndefined();
  });

  it('does not count a retired W-9, which is not merged into the PDF either', async () => {
    state.selected = [W9.key];
    state.library = [{ ...W9, active: false }];
    await pushReleasedProposal({ versionId: 'v1' });
    expect(w9Writes()).toHaveLength(0);
  });

  it("recognises next year's W-9 under a new key and a hyphenated title", async () => {
    state.selected = ['SSG_TAX_FORM_2027'];
    state.library = [
      { key: 'SSG_TAX_FORM_2027', title: 'Form W-9 (2027)', filename: 'form.pdf', active: true },
    ];
    const r = await pushReleasedProposal({ versionId: 'v1' });
    expect(r.w9Sent).toBe(true);
  });

  it('does not mistake a "W9" buried in another word or number for the W-9', async () => {
    state.selected = ['PART_SW90'];
    state.library = [
      { key: 'PART_SW90', title: 'SW90 spec sheet', filename: 'sw90-w95.pdf', active: true },
    ];
    await pushReleasedProposal({ versionId: 'v1' });
    expect(w9Writes()).toHaveLength(0);
  });

  it('keeps the rest of the push when the board rejects the W-9 label, and says so', async () => {
    state.selected = [W9.key];
    state.failWhen = (cols) => DEAL_COLUMNS.w9 in cols;
    const r = await pushReleasedProposal({ versionId: 'v1' });
    expect(r.pushed).toBe(true);
    expect(r.dealStage).toBe('Proposal Sent');
    expect(r.w9Sent).toBeUndefined();
    expect(r.w9Error).toMatch(/label not found/);
    expect(state.logs.at(-1)).toMatchObject({ status: 'error' });
    expect(state.logs.at(-1)?.error).toMatch(/W-9 status not set/);
  });
});
