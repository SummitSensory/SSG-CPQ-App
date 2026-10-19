import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/**
 * Prismatic upcharge → QuickBooks invoice, against a real database
 * (src/integrations/quickbooks/colorUpcharge.ts).
 *
 * QuickBooks is replaced by an in-memory invoice that behaves like the real one where
 * it matters: an update with a stale SyncToken is refused, a payment can be applied,
 * and a create returns a new invoice. Every row is created under a per-run prefix and
 * removed in afterAll. Refuses to run against anything but a localhost database.
 */

type Line = Record<string, unknown>;
const qbo = {
  invoice: {
    Id: 'Q1',
    SyncToken: '0',
    DocNumber: '1050',
    Line: [] as Line[],
    CustomerMemo: { value: '' },
  },
  paidMinor: 0n,
  created: [] as Array<Record<string, unknown>>,
  updates: 0,
};

function dollars(lines: Line[]): bigint {
  return lines.reduce((a, l) => a + BigInt(Math.round(Number(l.Amount ?? 0) * 100)), 0n);
}

vi.mock('../../src/integrations/quickbooks/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/integrations/quickbooks/client.js')>();
  return {
    ...real,
    readById: vi.fn(async (_realm: string, _res: string, id: string) =>
      id === qbo.invoice.Id ? { Invoice: structuredClone(qbo.invoice) } : { Invoice: undefined },
    ),
    update: vi.fn(
      async (_realm: string, _res: string, body: { SyncToken: string; Line: Line[] }) => {
        if (body.SyncToken !== qbo.invoice.SyncToken) throw new Error('Stale Object Error (5010)');
        qbo.updates++;
        qbo.invoice.Line = body.Line;
        qbo.invoice.SyncToken = String(Number(qbo.invoice.SyncToken) + 1);
        return {
          Invoice: {
            Id: qbo.invoice.Id,
            SyncToken: qbo.invoice.SyncToken,
            DocNumber: qbo.invoice.DocNumber,
          },
        };
      },
    ),
    create: vi.fn(async (_realm: string, _res: string, body: Record<string, unknown>) => {
      qbo.created.push(body);
      return {
        Invoice: { Id: `S${qbo.created.length}`, SyncToken: '0', DocNumber: body.DocNumber },
      };
    }),
  };
});

let mainTxnId = '';
vi.mock('../../src/integrations/quickbooks/billing.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../src/integrations/quickbooks/billing.js')>();
  return {
    ...real,
    // What a real sync copies back from QuickBooks: the total and what has been paid.
    syncTransactionState: vi.fn(async (txnId: string) => {
      const { prisma } = await import('../../src/lib/prisma.js');
      if (txnId !== mainTxnId) return {};
      await prisma.qboTransaction.update({
        where: { id: txnId },
        data: { qboTotalMinor: dollars(qbo.invoice.Line), paidMinor: qbo.paidMinor },
      });
      return {};
    }),
  };
});
vi.mock('../../src/integrations/quickbooks/customers.js', () => ({
  findOrCreateCustomer: vi.fn(async () => ({ qboId: 'C1', email: 'pat@example.com' })),
}));
vi.mock('../../src/integrations/quickbooks/customFields.js', () => ({
  customFieldId: vi.fn(async () => null),
}));
vi.mock('../../src/integrations/quickbooks/terms.js', () => ({
  resolveTermForProposal: vi.fn(async () => ({ id: null, name: null })),
}));

const DB_URL = process.env.DATABASE_URL ?? '';
const LOCAL = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(DB_URL);
const RUN = Date.now().toString(36).toUpperCase();
const P = `ZCU${RUN}`;

const PRODUCT_LINE: Line = {
  Id: '1',
  DetailType: 'SalesItemLineDetail',
  Amount: 20000,
  Description: 'Adventure Series',
};

function answers(totalUpcharge: number, confirmed = true) {
  return {
    selections: {
      structure_frame_paint: {
        legs: { brand: 'prismatic', code: 'PRB-11039' },
        horizontal_beams: { brand: 'prismatic', code: 'PRB-2826' },
        ladder_rungs_and_leg: { brand: 'cardinal', code: 'T009-BG01' },
      },
    },
    totalUpcharge,
    confirmedAt: confirmed ? '2026-10-21T15:00:00.000Z' : null,
  };
}

let db: PrismaClient;
let cu: typeof import('../../src/integrations/quickbooks/colorUpcharge.js');
let userId = '';
let orgId = '';
let orderId = '';
let orderNumber = '';
let proposalId = '';
let connectionId = '';

async function setPortal(a: ReturnType<typeof answers>) {
  const contentHash = createHash('sha256').update(JSON.stringify(a)).digest('hex').slice(0, 32);
  await db.orderPortalItem.upsert({
    where: { orderId_kind: { orderId, kind: 'COLOR' } },
    create: { orderId, kind: 'COLOR', state: 'PROVIDED', answers: a, contentHash },
    update: { answers: a, contentHash },
  });
}

async function confirmFrom(preview: Awaited<ReturnType<typeof cu.colorUpchargePreview>>) {
  return {
    expectedCurrentTotalMinor: preview.invoice.currentTotalMinor,
    expectedNewTotalMinor: preview.newTotalMinor,
    expectedChargeMinor: preview.chargeMinor,
  };
}

describe.skipIf(!LOCAL)('Prismatic upcharge → QuickBooks invoice (real database)', () => {
  beforeAll(async () => {
    process.env.QBO_ITEM_ID_COLOR_UPCHARGE = '42';
    ({ prisma: db } = await import('../../src/lib/prisma.js'));
    cu = await import('../../src/integrations/quickbooks/colorUpcharge.js');

    userId = (
      await db.user.create({
        data: { email: `${P.toLowerCase()}@example.com`, passwordHash: 'x', name: 'Test' },
      })
    ).id;
    orgId = (
      await db.organization.create({
        data: { name: `${P} Gym`, normalizedName: `${P.toLowerCase()} gym` },
      })
    ).id;
    const proposal = await db.proposal.create({
      data: { number: `${P}-P`, organizationId: orgId, title: 'Test', createdById: userId },
    });
    proposalId = proposal.id;
    const version = await db.proposalVersion.create({
      data: { proposalId, version: 1, sections: [], items: [], createdById: userId },
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
    orderNumber = `${P}-SO`;
    orderId = (
      await db.acceptedOrder.create({
        data: {
          number: orderNumber,
          organizationId: orgId,
          proposalId,
          proposalVersionId: version.id,
          acceptedVersion: 1,
          priceSnapshotId: snap.id,
          currency: 'USD',
          grandTotalMinor: 2_000_000n,
          contentSnapshot: {},
          integrityHash: 'x',
          acceptedById: userId,
        },
      })
    ).id;
    mainTxnId = (
      await db.qboTransaction.create({
        data: {
          type: 'INVOICE',
          environment: 'SANDBOX',
          status: 'CREATED',
          proposalId,
          proposalVersionId: version.id,
          proposalVersion: 1,
          currency: 'USD',
          proposalTotalMinor: 2_000_000n,
          amountMinor: 2_000_000n,
          totalsSnapshot: {},
          idempotencyKey: `${P}-main`,
          qboId: 'Q1',
          qboDocNumber: '1050',
          initiatedById: userId,
        },
      })
    ).id;
    // activeRealmId only needs an active connection to exist.
    if (
      !(await db.qboConnection.findFirst({ where: { environment: 'SANDBOX', isActive: true } }))
    ) {
      connectionId = (
        await db.qboConnection.create({
          data: {
            realmId: `${P}-realm`,
            environment: 'SANDBOX',
            accessTokenEnc: 'x',
            refreshTokenEnc: 'x',
            accessTokenExpiresAt: new Date(),
            refreshTokenExpiresAt: new Date(),
            connectedById: userId,
          },
        })
      ).id;
    }
  }, 60_000);

  beforeEach(async () => {
    qbo.invoice = {
      Id: 'Q1',
      SyncToken: '0',
      DocNumber: '1050',
      Line: [structuredClone(PRODUCT_LINE)],
      CustomerMemo: { value: '' },
    };
    qbo.paidMinor = 0n;
    qbo.created = [];
    qbo.updates = 0;
    await db.colorUpchargePush.deleteMany({ where: { orderId } });
    await db.qboTransaction.deleteMany({ where: { proposalId, id: { not: mainTxnId } } });
    await db.qboTransaction.update({
      where: { id: mainTxnId },
      data: { amountMinor: 2_000_000n, qboTotalMinor: 2_000_000n, paidMinor: 0n },
    });
    await setPortal(answers(800));
  });

  afterAll(async () => {
    if (!db) return;
    await db.colorUpchargePush.deleteMany({ where: { orderId } });
    await db.orderPortalItem.deleteMany({ where: { orderId } });
    await db.qboTransaction.deleteMany({ where: { proposalId } });
    await db.integrationSyncLog.deleteMany({ where: { entityId: orderId } });
    await db.acceptedOrder.deleteMany({ where: { id: orderId } });
    await db.priceSnapshot.deleteMany({ where: { createdById: userId } });
    await db.proposalVersion.deleteMany({ where: { createdById: userId } });
    await db.proposal.deleteMany({ where: { createdById: userId } });
    if (connectionId) await db.qboConnection.deleteMany({ where: { id: connectionId } });
    await db.auditLog.deleteMany({ where: { actorId: userId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it('a confirmed upcharge nobody has billed is "to bill" and on the daily list', async () => {
    const s = await cu.colorUpchargeState(orderId);
    expect(s.status).toBe('TO_BILL');
    expect(s.deltaMinor).toBe('80000');
    const list = await cu.unbilledColorUpcharges();
    expect(list.find((u) => u.orderId === orderId)).toMatchObject({
      deltaMinor: '80000',
      customer: `${P} Gym`,
    });
  });

  it('a draft (not confirmed in the portal) is never billed', async () => {
    await setPortal(answers(800, false));
    expect((await cu.colorUpchargeState(orderId)).status).toBe('UNCONFIRMED');
    await expect(cu.colorUpchargePreview(orderId)).rejects.toThrow(/not confirmed/);
    expect((await cu.unbilledColorUpcharges()).find((u) => u.orderId === orderId)).toBeUndefined();
  });

  it('nothing paid: adds one row to the existing invoice, keeps every other line, and records it once', async () => {
    const p = await cu.colorUpchargePreview(orderId);
    expect(p.mode).toBe('AMEND');
    expect(p.blocked).toBeNull();
    expect(p.newTotalMinor).toBe('2080000');

    await cu.pushColorUpcharge(orderId, userId, await confirmFrom(p));
    expect(qbo.updates).toBe(1);
    expect(qbo.invoice.Line).toHaveLength(2);
    expect(qbo.invoice.Line[0]).toEqual(PRODUCT_LINE);
    expect(qbo.invoice.Line[1]).toMatchObject({
      Amount: 800,
      SalesItemLineDetail: { ItemRef: { value: '42' }, Qty: 1 },
    });
    expect(String(qbo.invoice.Line[1]!.Description)).toContain(`(order ${orderNumber})`);
    expect(String(qbo.invoice.Line[1]!.Description)).toContain('2 Prismatic colors');

    const s = await cu.colorUpchargeState(orderId);
    expect(s.status).toBe('BILLED');
    expect(s.pushes).toEqual([
      expect.objectContaining({ mode: 'AMEND', amountMinor: '80000', qboDocNumber: '1050' }),
    ]);
    expect(
      (await db.qboTransaction.findUniqueOrThrow({ where: { id: mainTxnId } })).amountMinor,
    ).toBe(2_080_000n);
    expect((await cu.unbilledColorUpcharges()).find((u) => u.orderId === orderId)).toBeUndefined();

    // A second click bills nothing.
    await expect(cu.colorUpchargePreview(orderId)).rejects.toThrow(/Nothing to bill/);
  });

  it('refuses when the figures moved since the preview — nothing is sent', async () => {
    const p = await cu.colorUpchargePreview(orderId);
    qbo.invoice.Line.push({
      Id: '2',
      DetailType: 'SalesItemLineDetail',
      Amount: 150,
      Description: 'Freight',
    });
    await expect(cu.pushColorUpcharge(orderId, userId, await confirmFrom(p))).rejects.toThrow(
      /changed while you were looking/,
    );
    expect(qbo.updates).toBe(0);
    expect(await db.colorUpchargePush.count({ where: { orderId } })).toBe(0);
  });

  it('deposit already paid: raises a separate upcharge-only invoice, which freight never mistakes for the main one', async () => {
    qbo.paidMinor = 1_000_000n;
    const p = await cu.colorUpchargePreview(orderId);
    expect(p.mode).toBe('SUPPLEMENT');
    expect(p.supplementDocNumber).toBe(`${P}-P-CLR`);
    expect(p.newTotalMinor).toBe('80000');

    await cu.pushColorUpcharge(orderId, userId, await confirmFrom(p));
    expect(qbo.updates).toBe(0);
    expect(qbo.created).toHaveLength(1);
    expect(qbo.created[0]).toMatchObject({ DocNumber: `${P}-P-CLR`, CustomerRef: { value: 'C1' } });
    expect(qbo.created[0]!.Line).toEqual([expect.objectContaining({ Amount: 800 })]);

    const supplement = await db.qboTransaction.findFirstOrThrow({
      where: { proposalId, id: { not: mainTxnId } },
    });
    expect(supplement.totalsSnapshot).toMatchObject({ kind: 'COLOR_UPCHARGE_SUPPLEMENT', orderId });
    const { invoiceForProposal } = await import('../../src/integrations/quickbooks/freightPush.js');
    expect((await invoiceForProposal(proposalId)).id).toBe(mainTxnId);
    expect((await cu.colorUpchargeState(orderId)).status).toBe('BILLED');
  });

  it('a Prismatic row someone added by hand stops it; "already billed by hand" clears it', async () => {
    qbo.invoice.Line.push({
      Id: '2',
      DetailType: 'SalesItemLineDetail',
      Amount: 800,
      Description: 'Prismatic paint upgrade',
    });
    const p = await cu.colorUpchargePreview(orderId);
    expect(p.blocked).toMatch(/added by hand/);
    await expect(cu.pushColorUpcharge(orderId, userId, await confirmFrom(p))).rejects.toThrow(
      /added by hand/,
    );
    expect(qbo.updates).toBe(0);

    await expect(
      cu.markColorUpchargeHandled(orderId, userId, { note: 'x', expectedChargeMinor: '80000' }),
    ).rejects.toThrow(/Say what was done/);
    await expect(
      cu.markColorUpchargeHandled(orderId, userId, {
        note: 'on 1050 by hand',
        expectedChargeMinor: '50000',
      }),
    ).rejects.toThrow(/changed/);
    const s = await cu.markColorUpchargeHandled(orderId, userId, {
      note: 'on 1050 by hand',
      expectedChargeMinor: '80000',
    });
    expect(s.status).toBe('BILLED');
    expect(s.pushes).toEqual([
      expect.objectContaining({ mode: 'MANUAL', note: 'on 1050 by hand' }),
    ]);
  });

  it('upcharge raised after billing: only the increase is billed', async () => {
    await cu.pushColorUpcharge(
      orderId,
      userId,
      await confirmFrom(await cu.colorUpchargePreview(orderId)),
    );
    await setPortal(answers(1100));
    const p = await cu.colorUpchargePreview(orderId);
    expect(p.mode).toBe('AMEND');
    expect(p.chargeMinor).toBe('30000');
    await cu.pushColorUpcharge(orderId, userId, await confirmFrom(p));
    // Still one upcharge row on the invoice, now for the full amount.
    const ours = qbo.invoice.Line.filter((l) =>
      String(l.Description).includes(`(order ${orderNumber})`),
    );
    expect(ours).toEqual([expect.objectContaining({ Amount: 1100 })]);
    expect((await cu.colorUpchargeState(orderId)).billedMinor).toBe('110000');
  });

  it('upcharge lowered by a staff color change: lowers the row while the invoice is unpaid', async () => {
    await cu.pushColorUpcharge(
      orderId,
      userId,
      await confirmFrom(await cu.colorUpchargePreview(orderId)),
    );
    await setPortal(answers(500));
    expect((await cu.colorUpchargeState(orderId)).status).toBe('TO_REDUCE');
    const p = await cu.colorUpchargePreview(orderId);
    expect(p.mode).toBe('REDUCE');
    expect(p.chargeMinor).toBe('-30000');
    expect(p.blocked).toBeNull();
    await cu.pushColorUpcharge(orderId, userId, await confirmFrom(p));
    const ours = qbo.invoice.Line.filter((l) =>
      String(l.Description).includes(`(order ${orderNumber})`),
    );
    expect(ours).toEqual([expect.objectContaining({ Amount: 500 })]);
    expect((await cu.colorUpchargeState(orderId)).status).toBe('BILLED');
  });

  it('upcharge lowered after the invoice was paid: never edits it — asks for a credit', async () => {
    await cu.pushColorUpcharge(
      orderId,
      userId,
      await confirmFrom(await cu.colorUpchargePreview(orderId)),
    );
    await setPortal(answers(0));
    qbo.paidMinor = 2_080_000n;
    const p = await cu.colorUpchargePreview(orderId);
    expect(p.blocked).toMatch(/credit/);
    const updatesBefore = qbo.updates;
    await expect(cu.pushColorUpcharge(orderId, userId, await confirmFrom(p))).rejects.toThrow(
      /credit/,
    );
    expect(qbo.updates).toBe(updatesBefore);
  });

  it('an upcharge row on the invoice the CRM did not record (a lost write) stops a second one', async () => {
    qbo.invoice.Line.push(cu.upchargeLine(orderNumber, 80_000n, 2));
    const p = await cu.colorUpchargePreview(orderId);
    expect(p.blocked).toMatch(/recorded/);
  });
});
