import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

/**
 * The Processing Service Supplier (Catalog → BOM setup), end to end against a REAL
 * database: a part bought from its Procurement Supplier and shipped to a processing
 * supplier who repackages it must appear on BOTH vendors' Bills of Materials — the
 * purchase at catalog cost on the procurement supplier's sheet, and one processing line
 * at the Repackaging Service Fee on the processing supplier's — and the two must stay
 * in step as the purchase lines are edited.
 *
 * Every row is created under a per-run prefix and removed in afterAll.
 *
 * Run only against a local database:
 *   DATABASE_URL=postgresql://app:app@localhost:5432/app DIRECT_URL=... npx vitest run <this file>
 */

// Refuse anything that is not a local database — .env in this repo is production.
const LOCAL_DB = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.DATABASE_URL ?? '');

vi.mock('../../src/handoff/orderLockedNotice.js', () => ({
  sendOrderLockedNotice: vi.fn(async () => null),
}));

const RUN = Date.now().toString(36).toUpperCase();
const P = `ZPS${RUN}`;
const AMAZON = `${P} Amazon`;
const GOLDBERG = `${P} Goldberg`;
const PART = {
  perUnit: `${P}-PU`,
  perOrder: `${P}-PO`,
  plain: `${P}-PL`,
  legacy: `${P}-LG`,
};
const RPK_UNIT = `${P}-RPK-U`;
const RPK_ORDER = `${P}-RPK-O`;

let db: PrismaClient;
let service: typeof import('../../src/handoff/service.js');
let bomMod: typeof import('../../src/handoff/bom.js');
let bomBuild: typeof import('../../src/handoff/bomBuild.js');
let app: FastifyInstance;
let token = '';
let userId = '';
let orgId = '';
const mfrIds: string[] = [];
const orderIds: string[] = [];
const proposalIds: string[] = [];

const approval = {
  method: 'SIGNATURE',
  approverName: 'Processing Approver',
  approvedAt: new Date('2026-10-01T12:00:00Z'),
} as const;

const product = (sku: string, quantity: number) => ({
  lineType: 'PRODUCT',
  kind: 'INCLUDED',
  sku,
  name: sku + ' part',
  quantity,
});

/** An ACCEPTED proposal version carrying these builder items, locked into an order. */
async function lockOrder(items: unknown[]): Promise<string> {
  const n = proposalIds.length + 1;
  const proposal = await db.proposal.create({
    data: {
      number: `${P}-P${n}`,
      organizationId: orgId,
      title: `Processing ${n}`,
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
      sections: [{ id: 'meta', data: {} }],
      items: items as object,
      createdById: userId,
    },
  });
  const order = await service.createAcceptedOrder(version.id, approval, userId);
  orderIds.push(order.id);
  return order.id;
}

const linesOf = (orderId: string) =>
  db.procurementLine.findMany({
    where: { orderId },
    orderBy: [{ proposalLineOrder: 'asc' }, { id: 'asc' }],
  });
const processingLine = async (orderId: string, sku: string) =>
  (await linesOf(orderId)).find((l) => l.secondaryOfSku === sku.toUpperCase()) ?? null;
const purchaseLines = async (orderId: string, sku: string) =>
  (await linesOf(orderId)).filter((l) => l.sku === sku && !l.secondaryOfSku);

const suite = LOCAL_DB ? describe : describe.skip;

beforeAll(async () => {
  if (!LOCAL_DB) return;
  ({ prisma: db } = await import('../../src/lib/prisma.js'));
  service = await import('../../src/handoff/service.js');
  bomMod = await import('../../src/handoff/bom.js');
  bomBuild = await import('../../src/handoff/bomBuild.js');

  userId = (
    await db.user.create({
      data: {
        email: `${P.toLowerCase()}@example.com`,
        passwordHash: 'x',
        name: 'Processing Test',
        role: 'SYSTEM_ADMIN',
      },
    })
  ).id;
  orgId = (
    await db.organization.create({
      data: { name: `${P} Gym`, normalizedName: `${P.toLowerCase()} gym` },
    })
  ).id;
  for (const name of [AMAZON, GOLDBERG]) {
    const m = await db.manufacturer.create({
      data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
    });
    mfrIds.push(m.id);
  }
  await db.sku.createMany({
    data: [
      {
        part: PART.perUnit,
        description: 'Per-unit processed part',
        unitCostMinor: 1000,
        weightLbs: 1,
        manufacturer: AMAZON,
        processingEnabled: true,
        secondaryVendor: GOLDBERG,
        secondaryVendorCostMinor: 150,
        processingFeeBasis: 'PER_UNIT',
        processingSku: RPK_UNIT,
      },
      {
        part: PART.perOrder,
        description: 'Per-order processed part',
        unitCostMinor: 2000,
        weightLbs: 2,
        manufacturer: AMAZON,
        processingEnabled: true,
        secondaryVendor: GOLDBERG,
        secondaryVendorCostMinor: 2500,
        processingFeeBasis: 'PER_ORDER',
        processingSku: RPK_ORDER,
      },
      { part: PART.plain, description: 'Plain part', unitCostMinor: 500, manufacturer: AMAZON },
      { part: PART.legacy, description: 'Legacy part', unitCostMinor: 500, manufacturer: AMAZON },
    ],
  });

  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerBomSetupRoutes } = await import('../../src/routes/bomSetup.js');
  const { registerBomBuildRoutes } = await import('../../src/routes/bomBuild.js');
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  app = Fastify();
  registerErrorHandler(app);
  registerBomSetupRoutes(app);
  registerBomBuildRoutes(app);
  await app.ready();
  token = await signAccessToken({ sub: userId, role: 'SYSTEM_ADMIN' });
}, 120_000);

afterAll(async () => {
  if (!db) return;
  await app?.close();
  for (const id of orderIds) {
    await db.purchaseOrder.deleteMany({ where: { orderId: id } });
    await db.bomVendorSection.deleteMany({ where: { orderId: id } });
    await db.orderEvent.deleteMany({ where: { orderId: id } });
    await db.acceptedOrder.deleteMany({ where: { id } });
  }
  await db.priceSnapshot.deleteMany({ where: { createdById: userId } });
  await db.proposal.deleteMany({ where: { id: { in: proposalIds } } });
  await db.sku.deleteMany({ where: { part: { startsWith: P } } });
  await db.manufacturer.deleteMany({ where: { id: { in: mfrIds } } });
  await db.entityRevision.deleteMany({ where: { actorId: userId } });
  await db.auditLog.deleteMany({ where: { actorId: userId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
}, 120_000);

suite('processing service supplier — lock and Bill of Materials (real database)', () => {
  let orderId = '';

  beforeAll(async () => {
    if (!LOCAL_DB) return;
    orderId = await lockOrder([
      product(PART.perOrder, 3),
      product(PART.perUnit, 4),
      // The same per-order part again: still ONE processing line, for both.
      product(PART.perOrder, 3),
    ]);
  }, 120_000);

  it('locks the purchase on the procurement supplier AND one processing line on the processing supplier', async () => {
    const ls = await linesOf(orderId);
    expect(ls).toHaveLength(5);

    const bought = ls.filter((l) => !l.secondaryOfSku);
    expect(bought.map((l) => [l.sku, l.quantity, l.vendor, l.unitCostMinor]).sort()).toEqual(
      [
        [PART.perOrder, 3, AMAZON, 2000],
        [PART.perOrder, 3, AMAZON, 2000],
        [PART.perUnit, 4, AMAZON, 1000],
      ].sort(),
    );
    for (const l of bought) {
      expect(l.costPerOrder).toBe(false);
      expect(l.vendorPartNo).toBeNull();
    }

    expect(await processingLine(orderId, PART.perOrder)).toMatchObject({
      sku: PART.perOrder,
      quantity: 6,
      vendor: GOLDBERG,
      purchaseVendor: AMAZON,
      unitCostMinor: 2500,
      costPerOrder: true,
      vendorPartNo: RPK_ORDER,
      freeIssue: false,
    });
    expect(await processingLine(orderId, PART.perUnit)).toMatchObject({
      quantity: 4,
      vendor: GOLDBERG,
      purchaseVendor: AMAZON,
      unitCostMinor: 150,
      costPerOrder: false,
      vendorPartNo: RPK_UNIT,
    });
  });

  it('buildBom: the processing supplier is billed the fee — once for a per-order line — under the Repackaging SKU', async () => {
    const gb = await bomMod.buildBom(orderId, { vendor: GOLDBERG });
    const perOrder = gb.lines.find((l) => l.sku === PART.perOrder);
    const perUnit = gb.lines.find((l) => l.sku === PART.perUnit);
    expect(perOrder).toMatchObject({
      quantity: 6,
      unitCostMinor: 2500,
      extendedCostMinor: 2500,
      vendorSku: RPK_ORDER,
      lineNo: RPK_ORDER,
      processing: true,
      costPerOrder: true,
    });
    expect(perOrder?.vendorNotes).toContain('Repackaging service');
    expect(perOrder?.vendorNotes).toContain(`from ${AMAZON}`);
    expect(perOrder?.vendorNotes).toContain('once for this order');
    expect(perUnit).toMatchObject({
      quantity: 4,
      extendedCostMinor: 600,
      vendorSku: RPK_UNIT,
      processing: true,
      costPerOrder: false,
    });
    expect(perUnit?.vendorNotes).toContain('per unit');

    // …and the part never falls off the procurement supplier's sheet.
    const amazon = await bomMod.buildBom(orderId, { vendor: AMAZON });
    const amazonSkus = amazon.lines.map((l) => l.sku);
    expect(amazonSkus.filter((s) => s === PART.perOrder)).toHaveLength(2);
    expect(amazonSkus).toContain(PART.perUnit);
    expect(amazon.lines.every((l) => !l.processing)).toBe(true);
    expect(
      amazon.lines.filter((l) => l.sku === PART.perOrder).map((l) => l.extendedCostMinor),
    ).toEqual([6000, 6000]);
  });

  it('a purchase-line quantity edit moves the processing line with it', async () => {
    const [first] = await purchaseLines(orderId, PART.perOrder);
    if (!first) throw new Error('expected a purchase line');
    const res = await service.patchProcurementLine(first.id, { quantity: 5 }, userId);
    expect(res).not.toHaveProperty('processingWarning');
    expect((await processingLine(orderId, PART.perOrder))?.quantity).toBe(8);
  });

  it('a purchase line added by hand raises the processing line too', async () => {
    const res = await service.upsertProcurementLine(
      orderId,
      { sku: PART.perUnit, name: 'Extra per-unit part', quantity: 2, vendor: AMAZON },
      userId,
    );
    expect(res).not.toHaveProperty('processingWarning');
    expect((await processingLine(orderId, PART.perUnit))?.quantity).toBe(6);
  });

  it('deleting the purchase lines lowers, then removes, the processing line', async () => {
    const bought = await purchaseLines(orderId, PART.perOrder);
    expect(bought.map((l) => l.quantity).sort()).toEqual([3, 5]);
    const five = bought.find((l) => l.quantity === 5)!;
    const three = bought.find((l) => l.quantity === 3)!;

    await service.deleteProcurementLine(five.id, userId);
    expect((await processingLine(orderId, PART.perOrder))?.quantity).toBe(3);

    await service.deleteProcurementLine(three.id, userId);
    // None of the part is left on the order: its processing line goes with it.
    expect(await processingLine(orderId, PART.perOrder)).toBeNull();
    expect(await purchaseLines(orderId, PART.perOrder)).toHaveLength(0);
  });

  it('a submitted processing sheet is left alone, and the edit says so', async () => {
    const before = await processingLine(orderId, PART.perUnit);
    expect(before?.quantity).toBe(6);
    await db.bomVendorSection.upsert({
      where: { orderId_vendor: { orderId, vendor: GOLDBERG } },
      create: { orderId, vendor: GOLDBERG, status: 'SUBMITTED' },
      update: { status: 'SUBMITTED' },
    });
    try {
      const [line] = await purchaseLines(orderId, PART.perUnit);
      if (!line) throw new Error('expected a purchase line');
      const res = (await service.patchProcurementLine(
        line.id,
        { quantity: line.quantity + 3 },
        userId,
      )) as { processingWarning?: string; quantity: number };
      expect(res.quantity).toBe(line.quantity + 3);
      expect(res.processingWarning).toMatch(/submitted/);
      expect(res.processingWarning).toContain(GOLDBERG);
      expect((await processingLine(orderId, PART.perUnit))?.quantity).toBe(6);
    } finally {
      await db.bomVendorSection.update({
        where: { orderId_vendor: { orderId, vendor: GOLDBERG } },
        data: { status: 'DRAFT' },
      });
    }
  });
});

suite('processing service supplier — re-applying the rules (real database)', () => {
  it('creates a missing processing line, and is idempotent on re-run', async () => {
    const orderId = await lockOrder([product(PART.perOrder, 2)]);
    const made = await processingLine(orderId, PART.perOrder);
    if (!made) throw new Error('expected a processing line at lock');
    // As if the order were locked before the rule existed.
    await db.procurementLine.delete({ where: { id: made.id } });
    expect(await linesOf(orderId)).toHaveLength(1);

    const first = await bomBuild.applyBomBuildToOrder(orderId, userId);
    expect(first.secondaryAdded).toBe(1);
    expect(first.secondarySkipped).toEqual([]);
    expect(await processingLine(orderId, PART.perOrder)).toMatchObject({
      quantity: 2,
      quantityOriginal: 2,
      vendor: GOLDBERG,
      purchaseVendor: AMAZON,
      unitCostMinor: 2500,
      costPerOrder: true,
      vendorPartNo: RPK_ORDER,
    });
    const [bought] = await purchaseLines(orderId, PART.perOrder);
    expect(bought).toMatchObject({ vendor: AMAZON, quantity: 2, unitCostMinor: 2000 });

    const second = await bomBuild.applyBomBuildToOrder(orderId, userId);
    expect(second.secondaryAdded).toBe(0);
    expect(second.secondaryTopUps).toEqual([]);
    expect(await linesOf(orderId)).toHaveLength(2);
  });
});

suite('Catalog → BOM setup and BOM build routes (real database)', () => {
  const auth = () => ({ authorization: 'Bearer ' + token });
  const importRows = (rows: Array<Record<string, unknown>>, dryRun: boolean) =>
    app.inject({
      method: 'POST',
      url: '/bom-setup/import',
      headers: auth(),
      payload: { rows, dryRun },
    });
  const sku = (part: string) => db.sku.findUniqueOrThrow({ where: { part } });

  it('imports the new processing columns: dry run writes nothing, the real run writes them', async () => {
    const rows = [
      {
        part: PART.plain,
        processing: 'Yes',
        processingSupplier: GOLDBERG.toLowerCase(),
        repackagingSku: `${P}-RPK-PL`,
        repackagingFee: '3.25',
        repackagingFeeBasis: 'per order',
      },
    ];
    const dry = await importRows(rows, true);
    expect(dry.statusCode).toBe(200);
    expect(dry.json().issues).toEqual([]);
    expect(dry.json().changes).toHaveLength(1);
    expect(await sku(PART.plain)).toMatchObject({
      processingEnabled: false,
      secondaryVendor: null,
    });

    const real = await importRows(rows, false);
    expect(real.json()).toMatchObject({ dryRun: false, updated: 1, issues: [] });
    expect(await sku(PART.plain)).toMatchObject({
      processingEnabled: true,
      secondaryVendor: GOLDBERG,
      processingSku: `${P}-RPK-PL`,
      secondaryVendorCostMinor: 325,
      processingFeeBasis: 'PER_ORDER',
      manufacturer: AMAZON,
    });
  });

  it('imports a legacy "also on vendor" sheet as the processing supplier', async () => {
    const rows = [{ part: PART.legacy, alsoOnVendor: GOLDBERG, alsoOnVendorCost: '1.10' }];
    const dry = await importRows(rows, true);
    expect(dry.json().issues).toEqual([]);
    expect(dry.json().changes[0]?.part).toBe(PART.legacy);
    expect((await sku(PART.legacy)).secondaryVendor).toBeNull();

    const real = await importRows(rows, false);
    expect(real.json()).toMatchObject({ updated: 1, issues: [] });
    expect(await sku(PART.legacy)).toMatchObject({
      processingEnabled: true,
      secondaryVendor: GOLDBERG,
      secondaryVendorCostMinor: 110,
      processingFeeBasis: 'PER_UNIT',
    });
  });

  it('PATCH /bom-build/settings/:part refuses a secondaryVendor with a 400, changing nothing', async () => {
    const before = await sku(PART.perUnit);
    const res = await app.inject({
      method: 'PATCH',
      url: `/bom-build/settings/${PART.perUnit}`,
      headers: auth(),
      payload: { secondaryVendor: AMAZON },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('BOM setup');
    expect(await sku(PART.perUnit)).toMatchObject({
      secondaryVendor: before.secondaryVendor,
      secondaryVendorCostMinor: before.secondaryVendorCostMinor,
    });
  });
});

suite(
  'processing service supplier — moving a purchase line to the processing supplier (real database)',
  () => {
    it('leaves the processing supplier with just the moved line, no stray fee line', async () => {
      const orderId = await lockOrder([product(PART.perUnit, 4)]);
      expect((await processingLine(orderId, PART.perUnit))?.quantity).toBe(4);
      const [bought] = await purchaseLines(orderId, PART.perUnit);
      if (!bought) throw new Error('expected a purchase line');

      const res = await service.upsertProcurementLine(
        orderId,
        { id: bought.id, sku: PART.perUnit, name: bought.name, quantity: 4, vendor: GOLDBERG },
        userId,
      );
      expect(res).not.toHaveProperty('processingWarning');
      const ls = await linesOf(orderId);
      expect(ls.map((l) => [l.sku, l.vendor, l.quantity, l.secondaryOfSku])).toEqual([
        [PART.perUnit, GOLDBERG, 4, null],
      ]);

      // …and back to Amazon: the processing line returns with it.
      await service.upsertProcurementLine(
        orderId,
        { id: bought.id, sku: PART.perUnit, name: bought.name, quantity: 4, vendor: AMAZON },
        userId,
      );
      expect(await processingLine(orderId, PART.perUnit)).toMatchObject({
        vendor: GOLDBERG,
        quantity: 4,
        unitCostMinor: 150,
      });
      expect(await purchaseLines(orderId, PART.perUnit)).toHaveLength(1);
    });
  },
);

suite('processing service supplier — H-1000 kit repair (real database)', () => {
  it('repairs the kit without a processing seed in the plan, then adds the processing line', async () => {
    const kitRepair = await import('../../src/handoff/kitRepair.js');
    const n = proposalIds.length + 1;
    const proposal = await db.proposal.create({
      data: { number: `${P}-P${n}`, organizationId: orgId, title: 'Kit', createdById: userId },
    });
    proposalIds.push(proposal.id);
    const description = `4× Per-unit processed part (${PART.perUnit})`;
    const version = await db.proposalVersion.create({
      data: {
        proposalId: proposal.id,
        version: 1,
        status: 'ACCEPTED',
        sections: [],
        items: [
          {
            ref: 'k',
            lineType: 'PRODUCT',
            kind: 'INCLUDED',
            sku: 'H-1000',
            name: 'Hardware Kit',
            description,
            quantity: 1,
            components: null,
          },
        ],
        createdById: userId,
      },
    });
    const snap = await db.priceSnapshot.create({
      data: {
        currency: 'USD',
        engineVersion: 'test',
        input: {},
        breakdown: {},
        grandTotal: 0n,
        createdById: userId,
      },
    });
    const order = await db.acceptedOrder.create({
      data: {
        number: `${P}-KIT-SO`,
        organizationId: orgId,
        proposalId: proposal.id,
        proposalVersionId: version.id,
        acceptedVersion: 1,
        priceSnapshotId: snap.id,
        currency: 'USD',
        grandTotalMinor: 0n,
        contentSnapshot: {},
        integrityHash: 'x',
        acceptedById: userId,
      },
    });
    orderIds.push(order.id);
    await db.procurementLine.create({
      data: {
        orderId: order.id,
        sku: 'H-1000',
        name: 'Hardware Kit',
        quantity: 1,
        quantityOriginal: 1,
        vendor: AMAZON,
        unitCostMinor: 0,
        proposalLineOrder: 0,
      },
    });

    const [plan] = await kitRepair.planKitRepairs({ orderNumbers: [order.number] });
    expect(plan?.action).toBe('repair');
    expect(plan?.lines.map((l) => [l.sku, l.quantity, l.vendor, l.unitCostMinor])).toEqual([
      [PART.perUnit, 4, AMAZON, 1000],
    ]);

    expect(await kitRepair.applyKitRepair(plan!, userId)).toBe(true);
    const [bought] = await purchaseLines(order.id, PART.perUnit);
    expect(bought).toMatchObject({ vendor: AMAZON, quantity: 4, kitSku: 'H-1000' });
    expect(await processingLine(order.id, PART.perUnit)).toMatchObject({
      vendor: GOLDBERG,
      purchaseVendor: AMAZON,
      quantity: 4,
      unitCostMinor: 150,
      vendorPartNo: RPK_UNIT,
    });
    expect(await linesOf(order.id)).toHaveLength(2);
  });
});
