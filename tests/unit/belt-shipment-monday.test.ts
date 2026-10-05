import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A printed belt slip becomes a "UEU Belt(s)" subitem on the customer's Manufacturing
 * Process row — Vendor "Internal", SKU blank, Freight Cost "N/A", Order Status
 * "Obtained", Payment Status "N/A" — and its Freight Carrier / Freight Tracking ID are
 * written through to color_mm51tf2w / text_mm5125q0 on that subitem.
 */

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({ env: { MONDAY_API_TOKEN: 'token' } }));

const state = {
  portalOrderItemId: null as string | null,
  mondayProjectId: '555' as string | null,
};
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    procurementLine: {
      findFirst: vi.fn(async () => ({
        order: {
          portalOrderItemId: state.portalOrderItemId,
          mondayProjectId: state.mondayProjectId,
          contentSnapshot: null,
        },
      })),
    },
    opportunity: { findFirst: vi.fn(async () => null) },
  },
}));

const setColumnValues = vi.fn(async () => undefined);
const mondayQuery = vi.fn(async (query: string, _vars?: Record<string, unknown>) => {
  void _vars;
  if (query.includes('create_subitem')) {
    return { create_subitem: { id: 'sub-1', board: { id: '6533701061' } } };
  }
  if (query.includes('items (ids')) return { items: [{ name: 'Sunny Days School' }] };
  if (query.includes('types: [subtasks]')) {
    return { boards: [{ columns: [{ settings_str: '{"boardIds":[6533701061]}' }] }] };
  }
  if (query.includes('columns (ids')) {
    return {
      boards: [
        {
          columns: [
            {
              settings_str: JSON.stringify({
                labels: [
                  { label: 'FedEx', index: 2 },
                  { label: 'UPS', index: 1 },
                  { label: 'Gone', index: 3, is_deactivated: true },
                ],
              }),
            },
          ],
        },
      ],
    };
  }
  throw new Error('unexpected query ' + query);
});
vi.mock('../../src/integrations/monday/client.js', () => ({ setColumnValues, mondayQuery }));

const searchItemsByName = vi.fn(async (_board: string, _term: string) => [
  { id: '100', name: 'Sunny Days School', text: {}, raw: {}, titles: {} },
  { id: '200', name: 'Sunny Days School (Phase 2)', text: {}, raw: {}, titles: {} },
]);
vi.mock('../../src/integrations/monday/discovery.js', () => ({ searchItemsByName }));
vi.mock('../../src/integrations/monday/portalInvite.js', () => ({
  manufacturingBoardId: () => '6533700776',
}));

const { syncBeltSlipToMonday, carrierOptions, resetCarrierCache, BELT_SUBITEM_COL } =
  await import('../../src/integrations/monday/beltShipmentPush.js');

const slip = (over: Record<string, unknown> = {}) => ({
  number: 'PS-0001',
  orgId: 'org1',
  customer: 'Sunny Days School',
  carrier: '',
  trackingId: '',
  mondaySubitemId: '',
  mondaySubitemBoardId: '',
  lines: [{ lineId: 'line-1' }],
  ...over,
});

function createCall() {
  const call = mondayQuery.mock.calls.find((c) => String(c[0]).includes('create_subitem'));
  if (!call) throw new Error('no create_subitem call');
  const vars = call[1] as { parent: string; name: string; cols: string };
  return { ...vars, cols: JSON.parse(vars.cols) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.portalOrderItemId = null;
  state.mondayProjectId = '555';
  resetCarrierCache();
});

describe('syncBeltSlipToMonday', () => {
  it('creates the UEU Belt(s) subitem with the fixed values on the newest matching row', async () => {
    const r = await syncBeltSlipToMonday(slip({ carrier: 'UPS', trackingId: '1Z999' }));
    expect(r).toMatchObject({ ok: true, subitemId: 'sub-1', subitemBoardId: '6533701061' });
    // Searched by the deal's own name first.
    expect(searchItemsByName).toHaveBeenCalledWith('6533700776', 'Sunny Days School', 25);
    const c = createCall();
    expect(c.parent).toBe('200');
    expect(c.name).toBe('UEU Belt(s)');
    expect(c.cols).toEqual({
      color_mm58zwvr: { label: 'Internal' },
      text_mm587ez0: '',
      color_mm587bkw: { label: 'N/A' },
      color_mm58wahg: { label: 'Obtained' },
      color_mm7nc8d1: { label: 'N/A' },
      color_mm51tf2w: { label: 'UPS' },
      text_mm5125q0: '1Z999',
    });
    expect(r.note).toMatch(/newest was used/);
  });

  it('uses the Manufacturing row recorded on the order without searching', async () => {
    state.portalOrderItemId = '777';
    await syncBeltSlipToMonday(slip());
    expect(searchItemsByName).not.toHaveBeenCalled();
    expect(createCall().parent).toBe('777');
  });

  it('falls back to the customer name and reports when no row matches', async () => {
    state.mondayProjectId = null;
    searchItemsByName.mockResolvedValueOnce([]);
    const r = await syncBeltSlipToMonday(slip({ lines: [{ lineId: '' }], orgId: '' }));
    expect(r.ok).toBe(false);
    expect(r.subitemId).toBe('');
    expect(r.note).toMatch(/No Manufacturing Process row matches “Sunny Days School”/);
    expect(mondayQuery.mock.calls.some((c) => String(c[0]).includes('create_subitem'))).toBe(false);
  });

  it('only writes carrier and tracking once the subitem exists', async () => {
    const r = await syncBeltSlipToMonday(
      slip({
        carrier: 'FedEx',
        trackingId: 'ABC',
        mondaySubitemId: 'sub-1',
        mondaySubitemBoardId: '6533701061',
      }),
    );
    expect(r.ok).toBe(true);
    expect(setColumnValues).toHaveBeenCalledWith('6533701061', 'sub-1', {
      [BELT_SUBITEM_COL.carrier]: { label: 'FedEx' },
      [BELT_SUBITEM_COL.tracking]: 'ABC',
    });
    expect(mondayQuery).not.toHaveBeenCalled();
  });

  it('clears the carrier when it is unset', async () => {
    await syncBeltSlipToMonday(
      slip({ mondaySubitemId: 'sub-1', mondaySubitemBoardId: '6533701061' }),
    );
    expect(setColumnValues).toHaveBeenCalledWith('6533701061', 'sub-1', {
      color_mm51tf2w: '',
      text_mm5125q0: '',
    });
  });

  it('never throws when monday fails', async () => {
    setColumnValues.mockRejectedValueOnce(new Error('boom'));
    const r = await syncBeltSlipToMonday(
      slip({ mondaySubitemId: 'sub-1', mondaySubitemBoardId: '6533701061' }),
    );
    expect(r).toMatchObject({ ok: false, subitemId: 'sub-1' });
    expect(r.note).toMatch(/Could not update monday/);
  });
});

describe('carrierOptions', () => {
  it('reads the live Freight Carrier labels in board order, skipping deactivated ones', async () => {
    const r = await carrierOptions();
    expect(r).toEqual({ labels: ['UPS', 'FedEx'], live: true });
  });
});
