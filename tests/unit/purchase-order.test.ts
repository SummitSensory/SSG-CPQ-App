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
  powderColor: '',
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
      powderColor: 'Vinyl Charcoal',
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
  pos: [] as Record<string, unknown>[],
  users: [] as Record<string, unknown>[],
  mfrProfile: null as Record<string, unknown> | null,
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
      findUnique: vi.fn(async () => db.mfrProfile),
    },
    organization: { findUnique: vi.fn(async () => ({ name: 'Miracles in Motion' })) },
    user: { findMany: vi.fn(async () => db.users) },
    proposalVersion: { findUnique: vi.fn(async () => ({ sections: [] })) },
    purchaseOrder: {
      findMany: vi.fn(async () => db.pos),
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

const { poReference, purchaseOrderSource, createPurchaseOrder, listOrderPurchaseOrders } =
  await import('../../src/handoff/purchaseOrder.js');
const { renderPurchaseOrderDocument } = await import('../../src/handoff/purchaseOrderDocument.js');
const { sendPurchaseOrder, purchaseOrderSendDefaults } =
  await import('../../src/handoff/purchaseOrderSend.js');

beforeEach(() => {
  db.order = { locked: true, status: 'RELEASED' };
  db.mfr = { poEnabled: true };
  db.created = null;
  db.po = null;
  db.pos = [];
  db.users = [];
  db.mfrProfile = null;
});

describe('the send record on the vendor section', () => {
  it('lists every emailing with recipient, sender, time and delivery confirmation', async () => {
    db.pos = [
      {
        id: 'po1',
        vendor: 'TFH Special Needs Toys',
        reference: 'PO-13144920202-TFH',
        status: 'SENT',
        totalMinor: 58820,
        sentAt: new Date('2026-09-30T15:00:00Z'),
        mondayResult: null,
        _count: { lines: 2 },
        sends: [
          {
            id: 's2',
            createdAt: new Date('2026-10-01T16:42:00Z'),
            toName: 'Pat Vendor',
            toEmail: 'orders@tfh.com',
            ccEmails: null,
            subject: 'PO again',
            sentById: 'u2',
            status: 'SENT',
            deliveredAt: null,
            error: null,
          },
          {
            id: 's1',
            createdAt: new Date('2026-09-30T15:00:00Z'),
            toName: null,
            toEmail: 'orders@tfh.com',
            ccEmails: 'sales@tfh.com',
            subject: 'PO',
            sentById: 'u1',
            status: 'DELIVERED',
            deliveredAt: new Date('2026-09-30T15:00:04Z'),
            error: null,
          },
        ],
      },
    ];
    db.users = [
      { id: 'u1', name: 'Bryan Shepherd', email: 'bryan@example.test' },
      { id: 'u2', name: null, email: 'ops@example.test' },
    ];
    const [po] = await listOrderPurchaseOrders('o1');
    expect(po?.sends).toEqual([
      expect.objectContaining({
        sentAt: '2026-10-01T16:42:00.000Z',
        toName: 'Pat Vendor',
        to: 'orders@tfh.com',
        sentBy: 'ops@example.test',
        status: 'SENT',
        deliveredAt: null,
      }),
      expect.objectContaining({
        toName: null,
        cc: 'sales@tfh.com',
        sentBy: 'Bryan Shepherd',
        status: 'DELIVERED',
        deliveredAt: '2026-09-30T15:00:04.000Z',
      }),
    ]);
  });

  it("offers the name of whoever owns the default address on the vendor's profile", async () => {
    db.po = {
      id: 'po1',
      manufacturerId: 'm1',
      vendor: 'TFH Special Needs Toys',
      reference: 'PO-13144920202-TFH',
      projectId: '13144920202',
      totalMinor: 0,
      status: 'DRAFT',
      order: { organizationId: 'org1' },
    };
    db.mfrProfile = {
      poEmailTo: 'Orders@TFH.com',
      contactName: 'Pat Primary',
      contactEmail: 'pat@tfh.com',
      altContactName: 'Alex Orders',
      altContactEmail: 'orders@tfh.com',
    };
    expect((await purchaseOrderSendDefaults('po1')).toName).toBe('Alex Orders');
    db.mfrProfile = { ...db.mfrProfile, altContactEmail: 'someone@tfh.com' };
    expect((await purchaseOrderSendDefaults('po1')).toName).toBe('Pat Primary');
  });
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
      expect.objectContaining({
        sku: 'SSTBW515',
        quantity: 2,
        unitCostMinor: 3450,
        powderColor: 'Vinyl Charcoal',
      }),
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
        powderColor: '',
      },
    ],
    subtotalMinor: 39920,
    freightMinor: 12000,
    noFreightCharge: false,
    totalMinor: 51920,
    sentAt: null,
    mondayResult: null,
  };

  it('prints no Color column when no part on the PO has a colour', () => {
    const html = renderPurchaseOrderDocument(model);
    expect(html).not.toContain('>Color<');
    expect(html).toContain('colspan="3"');
  });

  it('prints each part’s colour in a Color column when one has a colour', () => {
    const html = renderPurchaseOrderDocument({
      ...model,
      lines: [
        { ...model.lines[0]!, powderColor: 'Cardinal Blue Hammer T013-BL468' },
        {
          ...model.lines[0]!,
          id: 'l2',
          sku: 'BOLT-1',
          name: 'Bolt',
          powderColor: '',
        },
      ],
    });
    expect(html).toContain('>Color<');
    const row = html.slice(html.indexOf('Square Bolster Swing'));
    expect(row.slice(0, row.indexOf('</tr>'))).toContain('Cardinal Blue Hammer T013-BL468');
    // The uncoloured part prints a dash rather than leaving the column ragged.
    const bolt = html.slice(html.indexOf('>Bolt<'));
    expect(bolt.slice(0, bolt.indexOf('</tr>'))).toContain('—');
    // Totals still span the right number of columns.
    expect(html).toContain('colspan="4"');
  });

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
