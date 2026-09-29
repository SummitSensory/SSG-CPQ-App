import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A sent PO marks each of its parts on the order's Manufacturing Process row: Order
 * Status (color_mm58wahg) "PO Sent to Mfg", Purchase Order ID (text_mm7na5v3) the PO
 * number, Payment Status (color_mm7nc8d1) "Not Paid". Parts are matched to subitems by
 * SKU; a part with no subitem gets one.
 */

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({ env: { MONDAY_API_TOKEN: 'token' } }));

const state = { portalOrderItemId: 'mfg1' as string | null };
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    purchaseOrder: {
      findUnique: vi.fn(async () => ({
        id: 'po1',
        orderId: 'o1',
        status: 'SENT',
        projectId: '13144920202',
        reference: 'PO-13144920202-TFH',
        lines: [
          { sku: '8EMBLQ', name: 'Square Bolster Swing' },
          { sku: 'NEW-1', name: 'Part with no subitem yet' },
        ],
      })),
    },
    acceptedOrder: {
      findUnique: vi.fn(async () => ({ portalOrderItemId: state.portalOrderItemId })),
    },
  },
}));

const setColumnValues = vi.fn(async () => undefined);
const createSubitem = vi.fn(async () => 'sub-new');
const mondayQuery = vi.fn(async () => ({
  items: [
    {
      subitems: [
        {
          id: 'sub1',
          board: { id: '6533701061' },
          column_values: [{ id: 'text_mm587ez0', text: '8embLQ ' }],
        },
        // The same part twice on the row, as the live board has it: both are updated.
        {
          id: 'sub2',
          board: { id: '6533701061' },
          column_values: [{ id: 'text_mm587ez0', text: '8EMBLQ' }],
        },
      ],
    },
  ],
}));
vi.mock('../../src/integrations/monday/client.js', () => ({
  setColumnValues,
  createSubitem,
  mondayQuery,
}));
vi.mock('../../src/integrations/monday/portalDelivery.js', () => ({
  linkOrderByDeal: vi.fn(async () => null),
  manufacturingBoardId: () => '6533700776',
  MFG_DEAL_LINK_COL: 'link_to_deals__1',
  ordersForProjectIds: vi.fn(async () => []),
}));

const { pushPurchaseOrderToMonday } =
  await import('../../src/integrations/monday/purchaseOrderPush.js');

const EXPECTED = {
  color_mm58wahg: { label: 'PO Sent to Mfg' },
  text_mm7na5v3: 'PO-13144920202-TFH',
  color_mm7nc8d1: { label: 'Not Paid' },
};

beforeEach(() => {
  state.portalOrderItemId = 'mfg1';
  setColumnValues.mockClear();
  createSubitem.mockClear();
});

describe('pushPurchaseOrderToMonday', () => {
  it('updates the matching subitem and creates one for a part that has none', async () => {
    const out = await pushPurchaseOrderToMonday('po1');
    expect(out).toEqual(
      expect.objectContaining({
        pushed: true,
        itemId: 'mfg1',
        updated: ['8EMBLQ'],
        created: ['NEW-1'],
      }),
    );
    expect(setColumnValues).toHaveBeenCalledWith('6533701061', 'sub1', EXPECTED);
    expect(setColumnValues).toHaveBeenCalledWith('6533701061', 'sub2', EXPECTED);
    expect(createSubitem).toHaveBeenCalledWith('mfg1', 'Part with no subitem yet', {
      ...EXPECTED,
      text_mm587ez0: 'NEW-1',
    });
  });

  it('reports, rather than throws, when the order has no Manufacturing Process row', async () => {
    state.portalOrderItemId = null;
    const out = await pushPurchaseOrderToMonday('po1');
    expect(out.pushed).toBe(false);
    expect(out.skipped).toMatch(/No Manufacturing Process row/);
    expect(setColumnValues).not.toHaveBeenCalled();
  });
});
