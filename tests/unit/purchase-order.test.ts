import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Purchase orders raised from a vendor's section of a locked order's Bill of
 * Materials. The lines come from buildBom for that vendor (so the PO and the BOM can
 * never disagree); the number is PO-<Project ID>-<vendor code>; and a PO cannot be
 * emailed until its freight is decided.
 */

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const bomLine = (over: Record<string, unknown>) => ({
  id: 'pl1',
  lineNo: '8EMBLQ',
  sku: '8EMBLQ',
  vendorSku: '',
  name: 'Square Bolster Swing',
  quantity: 1,
  unitCostMinor: 39920,
  extendedCostMinor: 39920,
  freeIssue: false,
  ...over,
});
const BOM = {
  lines: [
    bomLine({}),
    bomLine({
      id: 'pl2',
      sku: 'SSTBW515',
      name: 'Cable Cover',
      quantity: 2,
      unitCostMinor: 3450,
      extendedCostMinor: 6900,
    }),
    // Already bought elsewhere and shipped to this vendor: never orderable.
    bomLine({ id: 'pl3', sku: 'FREE-1', name: 'Free-issue part', freeIssue: true }),
    bomLine({ id: 'pl4', sku: 'ZERO', name: 'Zero quantity', quantity: 0 }),
  ],
  financials: { shipmentQuote: '$120.00', shipmentMinor: 12000 },
  shipTo: {
    name: 'Miracles in Motion',
    lines: ['39 Avenue at the commons, Suite 104', 'Shrewsbury, NJ 07702'],
    contactName: 'Bryan Shepherd',
    phone: '720-440-7850',
  },
};
vi.mock('../../src/handoff/bom.js', () => ({
  buildBom: vi.fn(async () => BOM),
  COMPANY: {
    name: 'Summit Sensory Gym',
    addressLine1: '6150 S Geneva Court',
    city: 'Englewood',
    region: 'CO',
    postalCode: '80111',
    phone: '720-457-5500',
    email: 'Orders@SummitSensory.com',
  },
}));

const db = {
  order: { locked: true, status: 'RELEASED' } as Record<string, unknown>,
  mfr: { poEnabled: true } as Record<string, unknown> | null,
  created: null as Record<string, unknown> | null,
  po: null as Record<string, unknown> | null,
};
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    acceptedOrder: {
      findUnique: vi.fn(async () => ({
        id: 'o1',
        number: 'SO-2026-000173',
        organizationId: 'org1',
        mondayProjectId: '13144920202',
        proposalVersionId: 'v1',
        ...db.order,
      })),
    },
    manufacturer: {
      findFirst: vi.fn(async () =>
        db.mfr ? { id: 'm1', name: 'TFH Special Needs Toys', rfqAbbrev: 'TFH', ...db.mfr } : null,
      ),
    },
    proposalVersion: { findUnique: vi.fn(async () => ({ sections: [] })) },
    purchaseOrder: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => db.po),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        db.created = args.data;
        return { id: 'po1', ...args.data };
      }),
      update: vi.fn(async () => ({})),
    },
  },
}));

const { poReference, purchaseOrderSource, createPurchaseOrder } =
  await import('../../src/handoff/purchaseOrder.js');
const { renderPurchaseOrderDocument } = await import('../../src/handoff/purchaseOrderDocument.js');
const { sendPurchaseOrder } = await import('../../src/handoff/purchaseOrderSend.js');

beforeEach(() => {
  db.order = { locked: true, status: 'RELEASED' };
  db.mfr = { poEnabled: true };
  db.created = null;
  db.po = null;
});

describe('poReference', () => {
  it('is PO-<Project ID>-<vendor code>, with a suffix for a second PO to the same vendor', () => {
    expect(poReference('13144920202', 'TFH')).toBe('PO-13144920202-TFH');
    expect(poReference('13144920202', 'TFH', 2)).toBe('PO-13144920202-TFH-2');
  });
});

describe('purchaseOrderSource', () => {
  it("offers the vendor's orderable lines and the BOM's freight figure", async () => {
    const src = await purchaseOrderSource('o1', 'TFH Special Needs Toys');
    expect(src.poEnabled).toBe(true);
    expect(src.lines.map((l) => l.sku)).toEqual(['8EMBLQ', 'SSTBW515']);
    expect(src.freight).toEqual({ text: '$120.00', minor: 12000 });
  });
});

describe('createPurchaseOrder', () => {
  const input = { lineIds: ['pl1', 'pl2'], freightMinor: 12000, noFreightCharge: false };

  it('snapshots the chosen lines, freight, totals and the ship-to', async () => {
    await createPurchaseOrder('o1', 'TFH Special Needs Toys', { ...input, lineIds: ['pl2'] }, 'u1');
    const d = db.created!;
    expect(d.reference).toBe('PO-13144920202-TFH');
    expect(d.projectId).toBe('13144920202');
    expect(d.subtotalMinor).toBe(6900);
    expect(d.freightMinor).toBe(12000);
    expect(d.totalMinor).toBe(18900);
    expect(d.shipToName).toBe('Miracles in Motion');
    const lines = (d.lines as { create: Array<Record<string, unknown>> }).create;
    expect(lines).toEqual([
      expect.objectContaining({ sku: 'SSTBW515', quantity: 2, unitCostMinor: 3450 }),
    ]);
  });

  it('never puts a free-issue part on a PO', async () => {
    await expect(
      createPurchaseOrder('o1', 'TFH Special Needs Toys', { ...input, lineIds: ['pl3'] }, 'u1'),
    ).rejects.toThrow(/at least one product/);
  });

  it('refuses a vendor whose profile does not allow purchase orders', async () => {
    db.mfr = { poEnabled: false };
    await expect(createPurchaseOrder('o1', 'TFH Special Needs Toys', input, 'u1')).rejects.toThrow(
      /not set up to receive purchase orders/,
    );
  });

  it('refuses an order that is not locked', async () => {
    db.order = { locked: false, status: 'NEW' };
    await expect(createPurchaseOrder('o1', 'TFH Special Needs Toys', input, 'u1')).rejects.toThrow(
      /locked order/,
    );
  });

  it('records "no freight charge" as zero freight', async () => {
    await createPurchaseOrder(
      'o1',
      'TFH Special Needs Toys',
      { lineIds: ['pl1'], freightMinor: null, noFreightCharge: true },
      'u1',
    );
    expect(db.created).toEqual(
      expect.objectContaining({ freightMinor: 0, noFreightCharge: true, totalMinor: 39920 }),
    );
  });
});

describe('sendPurchaseOrder', () => {
  it('will not email a PO whose freight has not been decided', async () => {
    db.po = {
      id: 'po1',
      status: 'DRAFT',
      freightMinor: null,
      noFreightCharge: false,
      lines: [{ sku: 'X' }],
    };
    await expect(
      sendPurchaseOrder('po1', { to: 'orders@vendor.com', subject: 'PO', body: '' }, 'u1'),
    ).rejects.toThrow(/shipping \/ freight/);
  });
});

describe('the Purchase Order document', () => {
  const model = {
    id: 'po1',
    orderId: 'o1',
    orderNumber: 'SO-2026-000173',
    reference: 'PO-13144920202-TFH',
    status: 'DRAFT' as const,
    vendor: 'TFH Special Needs Toys',
    vendorBlock: { lines: [], paymentTerms: 'Net 30', accountNumber: '' },
    projectId: '13144920202',
    notes: '',
    todayLabel: 'September 29, 2026',
    submittedLabel: 'Tuesday, September 29, 2026 at 9:00 AM',
    company: {
      name: 'Summit Sensory Gym',
      addressLine1: '6150 S Geneva Court',
      city: 'Englewood',
      region: 'CO',
      postalCode: '80111',
      phone: '720-457-5500',
      email: 'Orders@SummitSensory.com',
    } as const,
    replyEmail: 'Orders@SummitSensory.com',
    customerName: 'Miracles in Motion',
    shipTo: { name: 'Miracles in Motion', lines: ['39 Avenue at the commons'] },
    contact: { name: 'Bryan Shepherd', phone: '720-440-7850' },
    orderedBy: { name: 'Bryan Shepherd' },
    lines: [
      {
        id: 'l1',
        sku: '8EMBLQ',
        vendorSku: '',
        name: 'Square Bolster Swing',
        quantity: 1,
        unitCostMinor: 39920,
        extendedCostMinor: 39920,
      },
    ],
    subtotalMinor: 39920,
    freightMinor: 12000,
    noFreightCharge: false,
    totalMinor: 51920,
    sentAt: null,
    mondayResult: null,
  };

  it('reads as a purchase order laid out like the Request for Freight', () => {
    const html = renderPurchaseOrderDocument(model);
    expect(html).toContain('>Purchase</span>');
    expect(html).toContain('PO Number');
    expect(html).toContain('PO-13144920202-TFH');
    expect(html).toContain('Items Ordered');
    expect(html).toContain('Shipping / Freight');
    expect(html).toContain('$120.00');
    expect(html).toContain('$519.20');
    expect(html).toContain('Net 30');
    expect(html).toContain('Communication with our client is strictly prohibited');
    expect(html).toContain('Bryan Shepherd, MBA');
    expect(html).not.toContain('Request for Freight');
    expect(html).not.toContain('Requiring Freight');
  });
});
