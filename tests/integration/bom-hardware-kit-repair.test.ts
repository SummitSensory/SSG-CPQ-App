import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';

/**
 * The repair for orders already locked with ONE bundled H-1000 "Hardware Kit" line
 * (src/handoff/kitRepair.ts, run by scripts/repair-bundled-hardware-kits.ts), against a
 * real local database. The BOM is read from stored procurement lines, not rebuilt from
 * the proposal, so those orders need their lines repaired.
 *
 * Every record is created under a per-run prefix and removed in afterAll.
 */

const LOCAL_DB = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '');
const RUN = Date.now().toString(36).toUpperCase();
const P = `ZK${RUN}`;
const VENDOR = `${P} Goldberg`;
const BOLT = `${P}-LA`;
const WASHER = `${P}-LB`;

let db: PrismaClient;
let repair: typeof import('../../src/handoff/kitRepair.js');
let userId = '';
let orgId = '';
const orderIds: string[] = [];
const proposalIds: string[] = [];
const snapIds: string[] = [];

async function makeOrder(
  tag: string,
  opts: { description: string; sectionStatus?: 'DRAFT' | 'SUBMITTED'; status?: 'NEW' | 'COMPLETE' },
) {
  const proposal = await db.proposal.create({
    data: { number: `${P}-${tag}-P`, organizationId: orgId, title: tag, createdById: userId },
  });
  proposalIds.push(proposal.id);
  const version = await db.proposalVersion.create({
    data: {
      proposalId: proposal.id,
      version: 1,
      status: 'ACCEPTED',
      sections: [],
      items: [
        {
          ref: 'f',
          lineType: 'PRODUCT',
          kind: 'INCLUDED',
          sku: `${P}-FRAME`,
          name: 'Frame',
          quantity: 1,
        },
        {
          ref: 'k',
          lineType: 'PRODUCT',
          kind: 'INCLUDED',
          sku: 'H-1000',
          name: 'Hardware Kit',
          description: opts.description,
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
  snapIds.push(snap.id);
  const order = await db.acceptedOrder.create({
    data: {
      number: `${P}-${tag}-SO`,
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
      status: opts.status ?? 'NEW',
    },
  });
  orderIds.push(order.id);
  await db.procurementLine.createMany({
    data: [
      {
        orderId: order.id,
        sku: `${P}-FRAME`,
        name: 'Frame',
        quantity: 1,
        quantityOriginal: 1,
        vendor: VENDOR,
        proposalLineOrder: 0,
      },
      {
        orderId: order.id,
        sku: 'H-1000',
        name: 'Hardware Kit',
        quantity: 1,
        quantityOriginal: 1,
        vendor: VENDOR,
        unitCostMinor: 0,
        proposalLineOrder: 1,
      },
    ],
  });
  await db.bomVendorSection.create({
    data: { orderId: order.id, vendor: VENDOR, status: opts.sectionStatus ?? 'DRAFT' },
  });
  return order;
}

const ITEMISED = `4× Hex Bolt (${BOLT}) · 9× Washer 1/2 Flat (${WASHER})`;

beforeAll(async () => {
  if (!LOCAL_DB) return;
  ({ prisma: db } = await import('../../src/lib/prisma.js'));
  repair = await import('../../src/handoff/kitRepair.js');
  const user = await db.user.create({
    data: { email: `${P.toLowerCase()}@example.com`, passwordHash: 'x', name: 'Kit Repair' },
  });
  userId = user.id;
  const org = await db.organization.create({
    data: { name: `${P} Gym`, normalizedName: `${P.toLowerCase()} gym` },
  });
  orgId = org.id;
  // One fastener in the catalog with its own vendor and cost; the other is not, and
  // has to fall back to the kit's vendor.
  await db.sku.create({
    data: {
      part: BOLT,
      description: 'Hex Bolt',
      unitCostMinor: 125,
      weightLbs: 0.5,
      manufacturer: VENDOR,
    },
  });
});

afterAll(async () => {
  if (!LOCAL_DB) return;
  await db.acceptedOrder.deleteMany({ where: { id: { in: orderIds } } });
  await db.priceSnapshot.deleteMany({ where: { id: { in: snapIds } } });
  await db.proposalVersion.deleteMany({ where: { proposalId: { in: proposalIds } } });
  await db.proposal.deleteMany({ where: { id: { in: proposalIds } } });
  await db.sku.deleteMany({ where: { part: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
});

describe.skipIf(!LOCAL_DB)('repair bundled H-1000 kit lines (local DB)', () => {
  it('replaces the bundled kit with one line per fastener, idempotently', async () => {
    const order = await makeOrder('OK', { description: ITEMISED });
    const [plan] = await repair.planKitRepairs({ orderNumbers: [order.number] });
    expect(plan?.action).toBe('repair');
    expect(plan?.source).toBe('description');

    expect(await repair.applyKitRepair(plan!)).toBe(true);
    const lines = await db.procurementLine.findMany({
      where: { orderId: order.id },
      orderBy: { sku: 'asc' },
    });
    expect(lines.find((l) => l.sku === 'H-1000')).toBeUndefined();
    const hw = lines.filter((l) => l.isHardwareComponent);
    expect(hw.map((l) => [l.sku, l.quantity, l.vendor, l.kitSku, l.proposalLineOrder])).toEqual([
      [BOLT, 4, VENDOR, 'H-1000', 1],
      [WASHER, 9, VENDOR, 'H-1000', 1],
    ]);
    // Catalog cost and weight on the catalogued part; the rest of the order untouched.
    expect(hw[0]?.unitCostMinor).toBe(125);
    expect(Number(hw[0]?.unitWeightLbs)).toBe(0.5);
    expect(lines.find((l) => l.sku === `${P}-FRAME`)?.quantity).toBe(1);
    const ev = await db.orderEvent.findFirst({
      where: { orderId: order.id, action: 'order.hardwareKitItemized' },
    });
    expect(ev).not.toBeNull();

    // Second run: nothing left to do, nothing changes.
    const [again] = await repair.planKitRepairs({ orderNumbers: [order.number] });
    expect(again).toBeUndefined();
    expect(await repair.applyKitRepair(plan!)).toBe(false);
    expect(await db.procurementLine.count({ where: { orderId: order.id } })).toBe(3);
  });

  it('skips a submitted vendor section, a finished order, and a kit it cannot itemise', async () => {
    const locked = await makeOrder('LOCKED', { description: ITEMISED, sectionStatus: 'SUBMITTED' });
    const done = await makeOrder('DONE', { description: ITEMISED, status: 'COMPLETE' });
    const vague = await makeOrder('VAGUE', {
      description: 'All mounting hardware for this structure — 13 pieces across 2 part numbers.',
    });
    const plans = await repair.planKitRepairs({
      orderNumbers: [locked.number, done.number, vague.number],
    });
    const by = new Map(plans.map((p) => [p.orderNumber, p]));
    expect(by.get(locked.number)?.action).toBe('skip');
    expect(by.get(locked.number)?.reason).toMatch(/SUBMITTED/);
    expect(by.get(done.number)?.reason).toMatch(/COMPLETE/);
    expect(by.get(vague.number)?.reason).toMatch(/no breakdown/);
    for (const p of plans) expect(await repair.applyKitRepair(p)).toBe(false);
    expect(
      await db.procurementLine.count({
        where: { orderId: { in: [locked.id, done.id, vague.id] }, sku: 'H-1000' },
      }),
    ).toBe(3);
  });
});
