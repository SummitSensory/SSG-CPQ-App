import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

/**
 * Audit (handoff domain), against a REAL database: accepted proposal -> locked order
 * -> procurement lines -> vendor BOM -> purchase orders, plus the editing, cost
 * refresh and catalog re-sourcing paths that act on a locked order.
 *
 * Every row is created under a per-run prefix and removed in afterAll. Nothing leaves
 * the process: monday, the PDF renderer and the order-locked email are stubbed, and
 * the one email send stubs `fetch` for its duration.
 *
 * Tests named "BUG:" are `it.fails` — they assert the CORRECT behaviour and are
 * expected to fail until the defect is fixed.
 *
 * Run only against a local database:
 *   DATABASE_URL=postgresql://app:app@localhost:5432/<db> DIRECT_URL=... npx vitest run <this file>
 */

// Refuse anything that is not a local database — .env in this repo is production.
const LOCAL_DB = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.DATABASE_URL ?? '');
process.env.RESEND_API_KEY ??= 're_audit_handoff_not_real';

vi.mock('../../src/handoff/orderLockedNotice.js', () => ({
  sendOrderLockedNotice: vi.fn(async () => null),
}));
vi.mock('../../src/integrations/monday/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/integrations/monday/client.js')>();
  const refuse = async (): Promise<never> => {
    throw new Error('monday is stubbed in the handoff audit');
  };
  return {
    ...real,
    mondayQuery: refuse,
    createItem: refuse,
    createSubitem: refuse,
    setColumnValues: refuse,
    uploadFileToColumn: refuse,
    updateItem: refuse,
  };
});
vi.mock('../../src/integrations/monday/purchaseOrderPush.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../src/integrations/monday/purchaseOrderPush.js')>();
  return {
    ...real,
    pushPurchaseOrderToMonday: vi.fn(async () => ({ pushed: false, error: 'audit stub' })),
  };
});
vi.mock('../../src/render/pdf.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/render/pdf.js')>();
  return {
    ...real,
    pdfAvailable: vi.fn(async () => true),
    renderPdf: vi.fn(async () => Buffer.from('%PDF-1.4 audit')),
  };
});

const RUN = Date.now().toString(36).toUpperCase();
const P = `ZH${RUN}`;
const PROJECT_ID = `9${Date.now()}`;

const V = {
  acme: `${P} Acme Fab`,
  southpaw: `${P} Southpaw Enterprises`,
  summitElectric: `${P} Summit Electric`,
  sourced: `${P} Sourcing Vendor`, // ProductSourcing primary
  override: `${P} Override Vendor`, // Sku.manufacturer (the BOM ordering override)
  powder: `${P} Powder Coater`, // secondary vendor
  receiver: `${P} Receiver`, // free-issue receiving vendor
  nonPrimary: `${P} Non Primary`,
  primary: `${P} Primary`,
};

const PART = {
  frame: `${P}-FRAME`,
  bolt: `${P}-BOLT`,
  kit: `${P}-KIT`,
  kitBolt: `${P}-KB1`,
  ovr: `${P}-OVR`,
  se1: `${P}-SE1`,
  se2: `${P}-SE2`,
  kitParent: `${P}-KP`,
  kitChild: `${P}-KC`,
};

let db: PrismaClient;
let service: typeof import('../../src/handoff/service.js');
let bomMod: typeof import('../../src/handoff/bom.js');
let po: typeof import('../../src/handoff/purchaseOrder.js');
let poSend: typeof import('../../src/handoff/purchaseOrderSend.js');
let costRefresh: typeof import('../../src/handoff/costRefresh.js');
let reassign: typeof import('../../src/handoff/vendorReassign.js');
let bomBuild: typeof import('../../src/handoff/bomBuild.js');
let vendorRes: typeof import('../../src/handoff/vendorResolution.js');

let userId = '';
let orgId = '';
let categoryId = '';
const mfrIds: Record<string, string> = {};
const productIds: string[] = [];
const orderIds: string[] = [];
const proposalIds: string[] = [];
let orderId = '';

const approval = {
  method: 'SIGNATURE',
  approverName: 'Audit Approver',
  approvedAt: new Date('2026-10-01T12:00:00Z'),
} as const;

/** An ACCEPTED proposal version carrying these builder items, locked into an order. */
async function lockOrder(items: unknown[], projectId = PROJECT_ID): Promise<string> {
  const n = proposalIds.length + 1;
  const proposal = await db.proposal.create({
    data: {
      number: `${P}-P${n}`,
      organizationId: orgId,
      title: `Handoff audit ${n}`,
      createdById: userId,
    },
  });
  proposalIds.push(proposal.id);
  const version = await db.proposalVersion.create({
    data: {
      proposalId: proposal.id,
      version: 1,
      status: 'ACCEPTED',
      frozen: true,
      sections: [{ id: 'meta', data: { projectId } }],
      items: items as object,
      createdById: userId,
    },
  });
  const order = await service.createAcceptedOrder(version.id, approval, userId);
  orderIds.push(order.id);
  return order.id;
}

async function lines(id = orderId) {
  return db.procurementLine.findMany({
    where: { orderId: id },
    orderBy: [{ proposalLineOrder: 'asc' }, { sku: 'asc' }],
  });
}

const suite = LOCAL_DB ? describe : describe.skip;

beforeAll(async () => {
  if (!LOCAL_DB) return;
  ({ prisma: db } = await import('../../src/lib/prisma.js'));
  service = await import('../../src/handoff/service.js');
  bomMod = await import('../../src/handoff/bom.js');
  po = await import('../../src/handoff/purchaseOrder.js');
  poSend = await import('../../src/handoff/purchaseOrderSend.js');
  costRefresh = await import('../../src/handoff/costRefresh.js');
  reassign = await import('../../src/handoff/vendorReassign.js');
  bomBuild = await import('../../src/handoff/bomBuild.js');
  vendorRes = await import('../../src/handoff/vendorResolution.js');

  userId = (
    await db.user.create({
      data: { email: `${P.toLowerCase()}@example.com`, passwordHash: 'x', name: 'Handoff Audit' },
    })
  ).id;
  orgId = (
    await db.organization.create({
      data: { name: `${P} Gym`, normalizedName: `${P.toLowerCase()} gym` },
    })
  ).id;
  categoryId = (
    await db.productCategory.create({
      data: { name: `${P} Cat`, slug: `${P.toLowerCase()}-cat` },
    })
  ).id;

  for (const [k, name] of Object.entries(V)) {
    const m = await db.manufacturer.create({
      data: {
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        poEnabled: true,
        isSteelFabricator: k === 'acme',
        // Acme gets an explicit code; the two "SE" vendors derive theirs.
        rfqAbbrev: k === 'acme' ? 'ACM' : null,
      },
    });
    mfrIds[k] = m.id;
  }

  await db.sku.createMany({
    data: [
      {
        part: PART.frame,
        description: 'Frame',
        unitCostMinor: 10000,
        weightLbs: 50,
        manufacturer: V.acme,
      },
      {
        part: PART.bolt,
        description: 'Bolt',
        unitCostMinor: 50,
        weightLbs: 0.25,
        manufacturer: V.acme,
      },
      {
        part: PART.kitBolt,
        description: 'Kit bolt',
        unitCostMinor: 30,
        weightLbs: 0.1,
        manufacturer: V.acme,
      },
      {
        part: PART.ovr,
        description: 'Override part',
        unitCostMinor: 700,
        weightLbs: 2,
        manufacturer: V.override,
      },
      { part: PART.se1, description: 'SE one', unitCostMinor: 100, manufacturer: V.southpaw },
      { part: PART.se2, description: 'SE two', unitCostMinor: 200, manufacturer: V.summitElectric },
      { part: PART.kitParent, description: 'Kit parent', unitCostMinor: 0, manufacturer: V.acme },
    ],
  });

  // PART.ovr also lives in the product tree, sourced (primary) from a DIFFERENT vendor.
  const ovr = await db.product.create({
    data: {
      sku: PART.ovr,
      name: 'Override part',
      categoryId,
      status: 'ACTIVE',
      createdById: userId,
    },
  });
  productIds.push(ovr.id);
  await db.productSourcing.create({
    data: { productId: ovr.id, manufacturerId: mfrIds.sourced!, isPrimary: true },
  });

  // PART.kitChild exists ONLY as a Product with two sourcing rows: a non-primary one
  // created first, then the primary.
  const child = await db.product.create({
    data: {
      sku: PART.kitChild,
      name: 'Kit child',
      categoryId,
      status: 'ACTIVE',
      createdById: userId,
      weightOz: 32,
    },
  });
  productIds.push(child.id);
  await db.productSourcing.create({
    data: { productId: child.id, manufacturerId: mfrIds.nonPrimary!, isPrimary: false },
  });
  await db.productSourcing.create({
    data: { productId: child.id, manufacturerId: mfrIds.primary!, isPrimary: true },
  });

  // The order every flow test below works on.
  orderId = await lockOrder([
    { lineType: 'GROUP', kind: 'GROUP', name: 'STRUCTURE', quantity: 0 },
    { lineType: 'PRODUCT', kind: 'INCLUDED', sku: PART.frame, name: 'Frame', quantity: 1 },
    { lineType: 'PRODUCT', kind: 'INCLUDED', sku: PART.bolt, name: 'Bolt', quantity: 4 },
    {
      lineType: 'PRODUCT',
      kind: 'INCLUDED',
      sku: PART.kit,
      name: 'Hardware kit',
      quantity: 3,
      components: [{ part: PART.kitBolt, name: 'Kit bolt', qty: 2, unitCostMinor: 99 }],
    },
    { lineType: 'GROUP', kind: 'GROUP', name: 'SECOND SECTION', quantity: 0 },
    // The same bolt again in a second section.
    { lineType: 'PRODUCT', kind: 'INCLUDED', sku: PART.bolt, name: 'Bolt', quantity: 6 },
    { lineType: 'PRODUCT', kind: 'OPTIONAL', sku: PART.frame, name: 'Spare frame', quantity: 1 },
    { lineType: 'PRODUCT', kind: 'INCLUDED', sku: PART.ovr, name: 'Override part', quantity: 1 },
    { lineType: 'PRODUCT', kind: 'INCLUDED', sku: PART.se1, name: 'SE one', quantity: 1 },
    { lineType: 'PRODUCT', kind: 'INCLUDED', sku: PART.se2, name: 'SE two', quantity: 1 },
  ]);
}, 120_000);

afterAll(async () => {
  if (!db) return;
  for (const id of orderIds) {
    await db.purchaseOrder.deleteMany({ where: { orderId: id } });
    await db.bomVendorSection.deleteMany({ where: { orderId: id } });
    await db.orderEvent.deleteMany({ where: { orderId: id } });
    await db.acceptedOrder.deleteMany({ where: { id } });
  }
  await db.priceSnapshot.deleteMany({ where: { createdById: userId } });
  await db.proposal.deleteMany({ where: { id: { in: proposalIds } } });
  await db.skuComponent.deleteMany({ where: { parentPart: { startsWith: P } } });
  await db.sku.deleteMany({ where: { part: { startsWith: P } } });
  await db.productSourcing.deleteMany({ where: { productId: { in: productIds } } });
  await db.product.deleteMany({ where: { id: { in: productIds } } });
  await db.productCategory.deleteMany({ where: { id: categoryId } });
  await db.manufacturer.deleteMany({ where: { id: { in: Object.values(mfrIds) } } });
  await db.auditLog.deleteMany({ where: { actorId: userId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
}, 120_000);

suite('audit: accepted order -> procurement snapshot (real database)', () => {
  it('locks one line per INCLUDED product, expands the kit, and snapshots catalog cost/weight', async () => {
    const ls = await lines();
    const summary = ls.map((l) => [l.sku, l.quantity, l.vendor]);
    expect(summary).toEqual(
      expect.arrayContaining([
        [PART.frame, 1, V.acme],
        [PART.bolt, 4, V.acme],
        [PART.bolt, 6, V.acme],
        [PART.kitBolt, 6, V.acme], // 2 per kit x 3 kits
        [PART.se1, 1, V.southpaw],
        [PART.se2, 1, V.summitElectric],
      ]),
    );
    // Optional item and section headings never become purchase lines; the kit parent is replaced.
    expect(ls.filter((l) => l.sku === PART.frame)).toHaveLength(1);
    expect(ls.some((l) => l.sku === PART.kit)).toBe(false);
    expect(ls).toHaveLength(7);

    const frame = ls.find((l) => l.sku === PART.frame)!;
    expect(frame.unitCostMinor).toBe(10000);
    expect(Number(frame.unitWeightLbs)).toBe(50);
    // A catalogued kit component takes the catalog cost over the kit breakdown's.
    expect(ls.find((l) => l.sku === PART.kitBolt)!.unitCostMinor).toBe(30);
    expect(ls.find((l) => l.sku === PART.kitBolt)!.kitSku).toBe(PART.kit);
  });

  it('is idempotent: locking the same accepted version again returns the same order', async () => {
    const order = await db.acceptedOrder.findUniqueOrThrow({ where: { id: orderId } });
    const again = await service.createAcceptedOrder(order.proposalVersionId, approval, userId);
    expect(again.id).toBe(orderId);
    expect(await db.procurementLine.count({ where: { orderId } })).toBe(7);
  });

  it.fails(
    'BUG: Sku.manufacturer (the BOM ordering override) loses to ProductSourcing at lock time',
    async () => {
      // resolveCatalogRefs merges `vendor: priorPart.vendor ?? ref.vendor` — Product
      // first (src/handoff/service.ts:221-229) — while partInfo (bomBuild.ts) and
      // resolveVendors (freight RFQ) both let Sku win. The same part goes to one vendor
      // on the BOM and is quoted for freight by another.
      const { vendorBySku } = await vendorRes.resolveVendors([PART.ovr]);
      expect(vendorBySku.get(PART.ovr.toLowerCase())).toBe(V.override); // freight side: Sku wins
      const ovr = (await lines()).find((l) => l.sku === PART.ovr)!;
      expect(ovr.vendor).toBe(V.override); // BOM side: actually V.sourced
    },
  );

  it('the catalog changing after lock does not move the BOM (snapshot, not live lookup)', async () => {
    const before = await bomMod.buildBom(orderId, { vendor: V.acme });
    await db.sku.update({ where: { part: PART.frame }, data: { unitCostMinor: 12345 } });
    const after = await bomMod.buildBom(orderId, { vendor: V.acme });
    expect(after.lines.find((l) => l.sku === PART.frame)!.unitCostMinor).toBe(10000);
    expect(after.totals.extendedCostMinor).toBe(before.totals.extendedCostMinor);
    await db.sku.update({ where: { part: PART.frame }, data: { unitCostMinor: 10000 } });
  });
});

suite('audit: vendor Bill of Materials (real database)', () => {
  it('builds the Acme sheet with the same part from two sections as two lines, in proposal order', async () => {
    const bom = await bomMod.buildBom(orderId, { vendor: V.acme });
    expect(bom.lines.map((l) => [l.sku, l.quantity])).toEqual([
      [PART.frame, 1],
      [PART.bolt, 4],
      [PART.kitBolt, 6],
      [PART.bolt, 6],
    ]);
    expect(bom.lines.find((l) => l.sku === PART.kitBolt)!.isHardware).toBe(true);
    // 10000 + 4*50 + 6*30 + 6*50
    expect(bom.totals.extendedCostMinor).toBe(10000 + 200 + 180 + 300);
    expect(bom.totals.unitCount).toBe(17);
    // Acme is the steel fabricator: 50 + 10*0.25 + 6*0.1 = 53.1 lb
    expect(bom.totals.steelWeightLbs).toBe(53.1);
    expect(bom.totals.totalWeightLbs).toBe(53.1);
    // Freight TBD -> no grand total rather than a partial one.
    expect(bom.financials.grandTotalMinor).toBeNull();
    expect(bom.vendors).toEqual(expect.arrayContaining([V.acme, V.southpaw, V.summitElectric]));
  });

  it('prints a free-issue line at zero cost on the receiving vendor sheet, keeping the real cost on the line', async () => {
    const free = await db.procurementLine.create({
      data: {
        orderId,
        sku: `${P}-FREE`,
        name: 'Free issue part',
        quantity: 2,
        vendor: V.receiver,
        purchaseVendor: V.acme,
        freeIssue: true,
        unitCostMinor: 900,
      },
    });
    const bom = await bomMod.buildBom(orderId, { vendor: V.receiver });
    const l = bom.lines.find((x) => x.id === free.id)!;
    expect(l.unitCostMinor).toBe(0);
    expect(l.extendedCostMinor).toBe(0);
    expect(l.vendorNotes).toContain('do not invoice');
    expect(bom.totals.extendedCostMinor).toBe(0);
    expect(
      (await db.procurementLine.findUniqueOrThrow({ where: { id: free.id } })).unitCostMinor,
    ).toBe(900);
    await db.procurementLine.delete({ where: { id: free.id } });
  });
});

suite('audit: purchase orders (real database)', () => {
  it('raises PO-<project>-<code>, totals the chosen lines, then numbers the next one -2', async () => {
    const src = await po.purchaseOrderSource(orderId, V.acme);
    expect(src.poEnabled).toBe(true);
    expect(src.lines).toHaveLength(4);
    const frame = src.lines.find((l) => l.sku === PART.frame)!;
    const first = await po.createPurchaseOrder(
      orderId,
      V.acme,
      { lineIds: [frame.id], freightMinor: 2500, noFreightCharge: false },
      userId,
    );
    expect(first.reference).toBe(`PO-${PROJECT_ID}-ACM`);
    expect(first.subtotalMinor).toBe(10000);
    expect(first.totalMinor).toBe(12500);
    expect(first.lines.map((l) => [l.sku, l.quantity, l.unitCostMinor])).toEqual([
      [PART.frame, 1, 10000],
    ]);

    const second = await po.createPurchaseOrder(
      orderId,
      V.acme,
      {
        lineIds: [src.lines.find((l) => l.sku === PART.kitBolt)!.id],
        freightMinor: 999,
        noFreightCharge: true,
      },
      userId,
    );
    expect(second.reference).toBe(`PO-${PROJECT_ID}-ACM-2`);
    // "No freight charge" wins over a typed figure.
    expect(second.freightMinor).toBe(0);
    expect(second.totalMinor).toBe(180);
  });

  it('a PO line is frozen: a later cost refresh moves the order line but not the PO', async () => {
    const [draftPo] = await db.purchaseOrder.findMany({
      where: { orderId, vendor: V.acme, sequence: 1 },
      include: { lines: true },
    });
    await db.sku.update({ where: { part: PART.frame }, data: { unitCostMinor: 11000 } });
    const preview = await costRefresh.previewCostRefresh(orderId);
    const row = preview.rows.find((r) => r.sku === PART.frame)!;
    expect(row).toMatchObject({
      currentMinor: 10000,
      catalogMinor: 11000,
      extendedDeltaMinor: 1000,
    });
    const res = await costRefresh.applyCostRefresh(orderId, [row.lineId], userId);
    expect(res.applied).toBe(1);
    const poAfter = await db.purchaseOrderLine.findFirstOrThrow({ where: { poId: draftPo!.id } });
    expect(poAfter.unitCostMinor).toBe(10000);
    // Restore for later tests.
    await db.procurementLine.update({ where: { id: row.lineId }, data: { unitCostMinor: 10000 } });
    await db.sku.update({ where: { part: PART.frame }, data: { unitCostMinor: 10000 } });
  });

  it('cost refresh refuses lines on a SUBMITTED vendor section', async () => {
    await db.sku.update({ where: { part: PART.se1 }, data: { unitCostMinor: 150 } });
    await db.bomVendorSection.upsert({
      where: { orderId_vendor: { orderId, vendor: V.southpaw } },
      create: { orderId, vendor: V.southpaw, status: 'SUBMITTED' },
      update: { status: 'SUBMITTED' },
    });
    const preview = await costRefresh.previewCostRefresh(orderId);
    const row = preview.rows.find((r) => r.sku === PART.se1)!;
    expect(row.blocked).toMatch(/submitted/);
    const res = await costRefresh.applyCostRefresh(orderId, [row.lineId], userId);
    expect(res.applied).toBe(0);
    expect(res.skipped).toHaveLength(1);
    await db.bomVendorSection.update({
      where: { orderId_vendor: { orderId, vendor: V.southpaw } },
      data: { status: 'DRAFT' },
    });
    await db.sku.update({ where: { part: PART.se1 }, data: { unitCostMinor: 100 } });
  });

  it.fails(
    'BUG: cost refresh offers to reprice a real cost to $0 when the catalog cost is blank (0)',
    async () => {
      // Sku.unitCostMinor is NOT NULL DEFAULT 0, and elsewhere a 0 means "the catalog
      // records no cost" (vendorResolution.ts resolvePartDetails). previewCostRefresh
      // compares against it as a real price (costRefresh.ts:123,139-143), so one click
      // of "apply" zeroes the line's cost and the job's COGS.
      await db.sku.update({ where: { part: PART.se1 }, data: { unitCostMinor: 0 } });
      try {
        const preview = await costRefresh.previewCostRefresh(orderId);
        expect(
          preview.rows.find((r) => r.sku === PART.se1 && r.catalogMinor === 0),
        ).toBeUndefined();
      } finally {
        await db.sku.update({ where: { part: PART.se1 }, data: { unitCostMinor: 100 } });
      }
    },
  );

  it('a sent PO cannot be edited or deleted', async () => {
    const p = await db.purchaseOrder.findFirstOrThrow({
      where: { orderId, vendor: V.acme, sequence: 2 },
    });
    await db.purchaseOrder.update({
      where: { id: p.id },
      data: { status: 'SENT', sentAt: new Date() },
    });
    await expect(po.deletePurchaseOrder(p.id)).rejects.toThrow(/can no longer be changed/);
    await expect(
      po.updatePurchaseOrder(p.id, { lineIds: [], freightMinor: 0, noFreightCharge: true }),
    ).rejects.toThrow(/can no longer be changed/);
  });

  it.fails(
    'BUG: two vendors whose codes collide on one order cannot both receive a PO (unique reference)',
    async () => {
      // Sequence is counted per (order, vendor) (purchaseOrder.ts:216-221) but
      // `reference` is globally @unique, so "Southpaw Enterprises" and "Summit
      // Electric" — both coded ZSE here — produce the same PO-<project>-ZSE and the
      // second create throws a raw Prisma P2002.
      const a = await po.purchaseOrderSource(orderId, V.southpaw);
      const b = await po.purchaseOrderSource(orderId, V.summitElectric);
      const poA = await po.createPurchaseOrder(
        orderId,
        V.southpaw,
        { lineIds: [a.lines[0]!.id], freightMinor: 0, noFreightCharge: true },
        userId,
      );
      const poB = await po.createPurchaseOrder(
        orderId,
        V.summitElectric,
        { lineIds: [b.lines[0]!.id], freightMinor: 0, noFreightCharge: true },
        userId,
      );
      expect(poA.reference).not.toBe(poB.reference);
    },
  );

  it.fails(
    'BUG: a second order on the same Project ID cannot raise a PO to the same vendor',
    async () => {
      // Same root cause across orders: a change order / second order on one monday
      // project restarts the vendor sequence at 1 and collides with the first order's PO.
      const second = await lockOrder([
        { lineType: 'PRODUCT', kind: 'INCLUDED', sku: PART.frame, name: 'Frame', quantity: 1 },
      ]);
      const src = await po.purchaseOrderSource(second, V.acme);
      const created = await po.createPurchaseOrder(
        second,
        V.acme,
        { lineIds: [src.lines[0]!.id], freightMinor: 0, noFreightCharge: true },
        userId,
      );
      expect(created.reference).toMatch(/^PO-/);
    },
  );

  it.fails(
    'BUG: once ONE bolt line is on a sent PO, the other bolt line (same part, other section) shows as already ordered',
    async () => {
      // purchaseOrderSource keys "already on a sent PO" by SKU (purchaseOrder.ts:128-131),
      // and sendPurchaseOrder stamps poNumber by SKU too, so the second bolt line looks
      // ordered when it is not — a rep skipping it under-orders by 6.
      const src = await po.purchaseOrderSource(orderId, V.acme);
      const bolts = src.lines.filter((l) => l.sku === PART.bolt);
      expect(bolts).toHaveLength(2);
      const sent = await po.createPurchaseOrder(
        orderId,
        V.acme,
        { lineIds: [bolts[0]!.id], freightMinor: 0, noFreightCharge: true },
        userId,
      );
      await db.purchaseOrder.update({ where: { id: sent.id }, data: { status: 'SENT' } });
      const again = await po.purchaseOrderSource(orderId, V.acme);
      const other = again.lines.find((l) => l.id === bolts[1]!.id)!;
      expect(other.onPurchaseOrder).toBeNull();
    },
  );
});

suite('audit: editing a locked order (real database)', () => {
  it('a SUBMITTED section freezes its lines for patch and delete, except status/invoice fields', async () => {
    await db.bomVendorSection.upsert({
      where: { orderId_vendor: { orderId, vendor: V.summitElectric } },
      create: { orderId, vendor: V.summitElectric, status: 'SUBMITTED' },
      update: { status: 'SUBMITTED' },
    });
    const line = (await lines()).find((l) => l.sku === PART.se2)!;
    await expect(service.patchProcurementLine(line.id, { quantity: 9 }, userId)).rejects.toThrow(
      /submitted/,
    );
    await expect(service.deleteProcurementLine(line.id, userId)).rejects.toThrow(/submitted/);
    const ok = await service.patchProcurementLine(line.id, { sourced: true }, userId);
    expect(ok.sourced).toBe(true);
    await expect(service.patchProcurementLine(line.id, { quantity: 0 }, userId)).rejects.toThrow();
  });

  it.fails(
    'BUG: upsertProcurementLine can move a line OFF a submitted section by changing its vendor',
    async () => {
      // assertSectionOpen is only checked for the NEW vendor (service.ts:1217-1218); the
      // existing line's own (submitted) section is never consulted on update.
      const line = (await lines()).find((l) => l.sku === PART.se2)!;
      await expect(
        service.upsertProcurementLine(
          orderId,
          { id: line.id, sku: PART.se2, name: line.name, quantity: line.quantity, vendor: V.acme },
          userId,
        ),
      ).rejects.toThrow(/submitted/);
    },
  );

  it.fails(
    "BUG: upsertProcurementLine with another order's line id moves that line into this order",
    async () => {
      // The update is `where: { id }` with `data.orderId = orderId` and no ownership check.
      const other = await lockOrder(
        [{ lineType: 'PRODUCT', kind: 'INCLUDED', sku: PART.bolt, name: 'Bolt', quantity: 2 }],
        `8${Date.now()}`,
      );
      const foreign = (await lines(other))[0]!;
      await expect(
        service.upsertProcurementLine(
          orderId,
          { id: foreign.id, sku: PART.bolt, name: 'Bolt', quantity: 2 },
          userId,
        ),
      ).rejects.toThrow();
      const after = await db.procurementLine.findUniqueOrThrow({ where: { id: foreign.id } });
      expect(after.orderId).toBe(other);
    },
  );

  it('purchase orders cannot be raised on an unlocked (cancelled) order', async () => {
    const cancelled = await lockOrder(
      [{ lineType: 'PRODUCT', kind: 'INCLUDED', sku: PART.frame, name: 'Frame', quantity: 1 }],
      `7${Date.now()}`,
    );
    const src = await po.purchaseOrderSource(cancelled, V.acme);
    const draft = await po.createPurchaseOrder(
      cancelled,
      V.acme,
      { lineIds: [src.lines[0]!.id], freightMinor: 100, noFreightCharge: false },
      userId,
    );
    await service.unlockOrder(cancelled, { reason: 'audit', createRevision: false }, userId);
    await expect(po.purchaseOrderSource(cancelled, V.acme)).rejects.toThrow(/cancelled/);
    await expect(
      po.createPurchaseOrder(
        cancelled,
        V.acme,
        { lineIds: [src.lines[0]!.id], freightMinor: 0, noFreightCharge: true },
        userId,
      ),
    ).rejects.toThrow(/cancelled/);
    // Kept for the next test.
    (globalThis as { __auditCancelledDraft?: string }).__auditCancelledDraft = draft.id;
  });

  it.fails(
    'BUG: a draft PO raised before the order was unlocked can still be emailed to the vendor',
    async () => {
      // sendPurchaseOrder never re-reads the order's status (purchaseOrderSend.ts:135-170).
      const draftId = (globalThis as { __auditCancelledDraft?: string }).__auditCancelledDraft!;
      const fetchStub = vi.fn(
        async () =>
          new Response(JSON.stringify({ id: 'audit-not-sent' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchStub);
      try {
        await expect(
          poSend.sendPurchaseOrder(
            draftId,
            { to: 'vendor@example.com', subject: 'PO', body: 'Please supply' },
            userId,
          ),
        ).rejects.toThrow(/cancel/i);
        expect(fetchStub).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});

suite('audit: catalog re-sourcing of open orders (real database)', () => {
  it('moves an ordinary line to the new manufacturer and leaves submitted sections alone', async () => {
    const id = await lockOrder(
      [{ lineType: 'PRODUCT', kind: 'INCLUDED', sku: PART.se1, name: 'SE one', quantity: 1 }],
      `6${Date.now()}`,
    );
    const res = await reassign.reassignSkuVendor(PART.se1, V.acme, userId);
    expect(res?.moved).toBeGreaterThanOrEqual(1);
    expect((await lines(id))[0]!.vendor).toBe(V.acme);
    // The main order's SE1 line was in a DRAFT section, so it moved too.
    expect((await lines()).find((l) => l.sku === PART.se1)!.vendor).toBe(V.acme);
  });

  it.fails(
    'BUG: re-sourcing a part drags its secondary-vendor and free-issue lines onto the new manufacturer',
    async () => {
      // reassignSkuVendor selects every line with the SKU (vendorReassign.ts:65-73) with
      // no regard for `secondaryOfSku` or `freeIssue`, whose vendor differs from the
      // manufacturer ON PURPOSE. The powder coater / receiving vendor loses the line and
      // the manufacturer's sheet gains a duplicate (or a zero-cost free-issue line).
      const id = await lockOrder(
        [{ lineType: 'PRODUCT', kind: 'INCLUDED', sku: PART.frame, name: 'Frame', quantity: 1 }],
        `5${Date.now()}`,
      );
      await db.procurementLine.createMany({
        data: [
          {
            orderId: id,
            sku: PART.frame,
            name: 'Frame',
            quantity: 1,
            vendor: V.powder,
            unitCostMinor: 1500,
            secondaryOfSku: PART.frame.toUpperCase(),
          },
          {
            orderId: id,
            sku: PART.frame,
            name: 'Frame (free issue)',
            quantity: 1,
            vendor: V.receiver,
            purchaseVendor: V.acme,
            freeIssue: true,
            unitCostMinor: 10000,
          },
        ],
      });
      await reassign.reassignSkuVendor(PART.frame, V.override, userId);
      const after = await lines(id);
      expect(after.find((l) => l.secondaryOfSku)!.vendor).toBe(V.powder);
      expect(after.find((l) => l.freeIssue)!.vendor).toBe(V.receiver);
    },
  );

  it.fails('BUG: re-sourcing rewrites lines on CANCELLED orders too', async () => {
    const id = await lockOrder(
      [{ lineType: 'PRODUCT', kind: 'INCLUDED', sku: PART.se2, name: 'SE two', quantity: 1 }],
      `4${Date.now()}`,
    );
    await service.unlockOrder(id, { reason: 'audit', createRevision: false }, userId);
    await reassign.reassignSkuVendor(PART.se2, V.override, userId);
    expect((await lines(id))[0]!.vendor).toBe(V.summitElectric);
  });
});

suite('audit: BOM build rules re-applied to a locked order (real database)', () => {
  it.fails(
    'BUG: a Product-only kit component gets a NON-primary vendor (partInfo ignores isPrimary)',
    async () => {
      // bomBuild.ts partInfo reads productSourcing with no orderBy and keeps the first
      // row (bomBuild.ts:224-231), unlike resolveVendors which orders isPrimary desc.
      const id = await lockOrder(
        [
          {
            lineType: 'PRODUCT',
            kind: 'INCLUDED',
            sku: PART.kitParent,
            name: 'Kit parent',
            quantity: 2,
          },
        ],
        `3${Date.now()}`,
      );
      await db.skuComponent.create({
        data: { parentPart: PART.kitParent, childPart: PART.kitChild, quantity: 3 },
      });
      try {
        const res = await bomBuild.applyBomBuildToOrder(id, userId);
        expect(res.exploded).toEqual([PART.kitParent.toUpperCase()]);
        const child = (await lines(id)).find((l) => l.sku === PART.kitChild.toUpperCase())!;
        expect(child.quantity).toBe(6);
        expect(Number(child.unitWeightLbs)).toBe(2);
        expect(child.vendor).toBe(V.primary);
      } finally {
        await db.skuComponent.deleteMany({ where: { parentPart: PART.kitParent } });
      }
    },
  );
});
