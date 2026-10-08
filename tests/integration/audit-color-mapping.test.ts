import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';

/**
 * AUDIT — portal colour areas → colours on specific Bill of Materials lines, against
 * a REAL database, through the same functions the order page calls
 * (reviewPortalItem → applyColorPicksToOrder, patchProcurementLine,
 * upsertProcurementLine, saveColorArea, checkOrderColors).
 *
 * tests/integration/portal-color-to-bom.test.ts proves the happy path reaches every
 * printed format. This file covers the edges of the MAPPING & APPLY stage: several
 * lines of one part, a part claimed by two areas, unmapped lines, resubmissions,
 * staff corrections, lines added after review, one part on two vendors' sheets, and
 * case/whitespace in part numbers and area keys. Every assertion names the exact
 * line (by id) and the exact colour text it must carry.
 *
 * Everything is created under a per-run prefix (part numbers, vendors, area keys,
 * colour codes) and removed in afterAll.
 *
 * Tests marked `it.fails` are DEFECTS found by the audit: they assert the behaviour
 * that should hold and currently fail. They are kept as `it.fails` so the suite stays
 * green until the defect is fixed — then they will flip to failing and must be
 * changed to `it`.
 */

const RUN = Date.now().toString(36);
const P = `ZQ${RUN.toUpperCase()}`;
const AK = `zq${RUN}`; // area-key prefix, snake_case like the portal's own keys
const GOLDBERG = `${P} Goldberg`;
const RESILITE = `${P} Resilite`;
const SECOND = `${P} Second Coater`;
const AMAZON = `${P} Amazon`;

const AREA = {
  legs: `${AK}_frame.legs`,
  beams: `${AK}_frame.beams`,
  rungs: `${AK}_frame.rungs`,
  mat: `${AK}_mat.system`,
  caseArea: `${AK}_frame.case_check`,
  dual: `${AK}_frame.dual_vendor`,
} as const;

const SKU = {
  leg: `${P}-A2245`,
  ladder: `${P}-A2246`,
  beam: `${P}-A2410`,
  rung: `${P}-P2330`,
  shared: `${P}-SHARED`, // mapped by BOTH beams and rungs
  pad: `${P}-SSG-1007CLM`, // reached by the pattern ${P}-SSG-*CLM*
  balls: `${P}-BALLS`, // on no area
  caseA: `${P}-CASE-A`,
  dual: `${P}-DUAL`, // one part on two vendors' sheets
} as const;

// Codes unique to this run, so a dev database's own Cardinal chart cannot collide.
const BLUE = `${P}-BL05`;
const ORANGE = `${P}-OG26`;
const BLUE_TEXT = `Cardinal Blue Test ${BLUE}`;
const ORANGE_TEXT = `Cardinal Orange Test ${ORANGE}`;

let db: PrismaClient;
let review: typeof import('../../src/portal/orderPortal.js');
let handoff: typeof import('../../src/handoff/service.js');
let mapping: typeof import('../../src/portal/colorAreaMapping.js');
let check: typeof import('../../src/portal/colorCheck.js');

let userId = '';
let orgId = '';
let cardinalId = '';
const createdBrandIds: string[] = [];
const mfrIds: string[] = [];
const orderIds: string[] = [];

type Pick = { brand: string; code: string };
const cardinal = (code: string): Pick => ({ brand: 'cardinal', code });

/** Build the portal's answers JSON from { areaKey: pick }. */
function answersOf(picks: Record<string, Pick>) {
  const selections: Record<string, Record<string, Pick>> = {};
  for (const [key, pick] of Object.entries(picks)) {
    const [group = '', area = ''] = key.split('.');
    (selections[group] ??= {})[area] = pick;
  }
  return { selections };
}

/** New customer answers on the portal item, exactly as a monday refresh writes them. */
async function receive(orderId: string, answers: unknown): Promise<string> {
  const hash = review.contentHashOf('PROVIDED', answers);
  await db.orderPortalItem.upsert({
    where: { orderId_kind: { orderId, kind: 'COLOR' } },
    create: {
      orderId,
      kind: 'COLOR',
      state: 'PROVIDED',
      answers: answers as object,
      contentHash: hash,
      obtainedAt: new Date(),
    },
    update: { answers: answers as object, contentHash: hash },
  });
  return hash;
}

/** Receive and click "Mark reviewed". */
async function receiveAndReview(orderId: string, picks: Record<string, Pick>) {
  const hash = await receive(orderId, answersOf(picks));
  return review.reviewPortalItem(orderId, 'COLOR', userId, hash);
}

interface LineSeed {
  key: string;
  sku: string;
  name: string;
  vendor: string;
  quantity?: number;
  hardware?: boolean;
}

/** A fresh accepted order with the given procurement lines; returns order id + line ids by key. */
async function makeOrder(tag: string, seeds: LineSeed[]) {
  const proposal = await db.proposal.create({
    data: {
      number: `${P}-${tag}-P`,
      organizationId: orgId,
      title: `Colour audit ${tag}`,
      createdById: userId,
    },
  });
  const version = await db.proposalVersion.create({
    data: { proposalId: proposal.id, version: 1, sections: [], items: [], createdById: userId },
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
    },
  });
  orderIds.push(order.id);
  const ids: Record<string, string> = {};
  for (const s of seeds) {
    const l = await db.procurementLine.create({
      data: {
        orderId: order.id,
        sku: s.sku,
        name: s.name,
        vendor: s.vendor,
        quantity: s.quantity ?? 1,
        quantityOriginal: s.quantity ?? 1,
        unitCostMinor: 1000,
        isHardwareComponent: !!s.hardware,
        ...(s.hardware ? { kitSku: 'H-1000' } : {}),
      },
    });
    ids[s.key] = l.id;
  }
  return { orderId: order.id, ids };
}

async function line(id: string) {
  return db.procurementLine.findUniqueOrThrow({ where: { id } });
}

/** Exact colour columns on one line. */
async function expectColor(id: string, text: string | null, label: string) {
  const l = await line(id);
  expect(l.powderColor, `${label}: powderColor`).toBe(text);
  if (text === BLUE_TEXT) {
    expect(l.powderBrandId, `${label}: brand`).toBe(cardinalId);
    expect(l.powderColorCode, `${label}: code`).toBe(BLUE);
  } else if (text === ORANGE_TEXT) {
    expect(l.powderBrandId, `${label}: brand`).toBe(cardinalId);
    expect(l.powderColorCode, `${label}: code`).toBe(ORANGE);
  } else if (text === null) {
    expect(l.powderBrandId, `${label}: brand`).toBeNull();
    expect(l.powderColorCode, `${label}: code`).toBeNull();
  }
}

beforeAll(async () => {
  ({ prisma: db } = await import('../../src/lib/prisma.js'));
  review = await import('../../src/portal/orderPortal.js');
  handoff = await import('../../src/handoff/service.js');
  mapping = await import('../../src/portal/colorAreaMapping.js');
  check = await import('../../src/portal/colorCheck.js');

  const user = await db.user.create({
    data: { email: `${P.toLowerCase()}@example.com`, passwordHash: 'x', name: 'Colour Audit' },
  });
  userId = user.id;
  const org = await db.organization.create({
    data: { name: `${P} Gym`, normalizedName: `${P.toLowerCase()} gym` },
  });
  orgId = org.id;

  const have = await db.powderColorBrand.findUnique({ where: { name: 'Cardinal' } });
  if (have) cardinalId = have.id;
  else {
    const b = await db.powderColorBrand.create({ data: { name: 'Cardinal' } });
    cardinalId = b.id;
    createdBrandIds.push(b.id);
  }

  for (const name of [GOLDBERG, RESILITE, SECOND, AMAZON]) {
    const m = await db.manufacturer.create({
      data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
    });
    mfrIds.push(m.id);
  }
  // The Cardinal chart as prisma/load-powder-charts.ts keeps it: a POWDER_COAT palette
  // named for the brand, under the powder coater.
  await db.vendorColorPalette.create({
    data: {
      manufacturerId: mfrIds[0]!,
      name: 'Cardinal',
      finishType: 'POWDER_COAT',
      colors: {
        create: [
          { name: 'Blue Test', vendorCode: BLUE, sortOrder: 0 },
          { name: 'Orange Test', vendorCode: ORANGE, sortOrder: 1 },
        ],
      },
    },
  });

  const rows: Array<{ areaKey: string; sku: string }> = [
    { areaKey: AREA.legs, sku: SKU.leg },
    { areaKey: AREA.legs, sku: SKU.ladder },
    { areaKey: AREA.beams, sku: SKU.beam },
    { areaKey: AREA.beams, sku: SKU.shared },
    { areaKey: AREA.rungs, sku: SKU.rung },
    { areaKey: AREA.rungs, sku: SKU.shared },
    { areaKey: AREA.mat, sku: `${P}-SSG-*CLM*` },
    { areaKey: AREA.dual, sku: SKU.dual },
  ];
  for (const r of rows) await db.portalColorAreaMapping.create({ data: r });
}, 60_000);

afterAll(async () => {
  if (!db) return;
  if (orderIds.length) {
    await db.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.acceptedOrder.deleteMany({ where: { id: { in: orderIds } } }); // cascades lines/items/sections
  }
  await db.portalColorAreaMapping.deleteMany({
    where: { areaKey: { startsWith: AK, mode: 'insensitive' } },
  });
  await db.vendorColorPalette.deleteMany({ where: { manufacturerId: { in: mfrIds } } });
  await db.priceSnapshot.deleteMany({ where: { createdById: userId } });
  await db.proposalVersion.deleteMany({ where: { createdById: userId } });
  await db.proposal.deleteMany({ where: { createdById: userId } });
  await db.manufacturer.deleteMany({ where: { id: { in: mfrIds } } });
  // Cardinal/Prismatic are shared reference rows — left in place so suites
  // running in parallel don't lose them mid-test.
  await db.auditLog.deleteMany({ where: { actorId: userId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe('AUDIT colour mapping & apply (real database)', () => {
  it('1. each pick lands on exactly its mapped lines — every line of the part, quantities untouched; hardware and unmapped lines stay blank', async () => {
    const { orderId, ids } = await makeOrder('T1', [
      { key: 'legBay1', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG, quantity: 3 },
      {
        key: 'legBay2',
        sku: SKU.leg,
        name: 'Vertical Post (bay 2)',
        vendor: GOLDBERG,
        quantity: 2,
      },
      { key: 'ladder', sku: SKU.ladder, name: 'Ladder Post', vendor: GOLDBERG },
      { key: 'beam', sku: SKU.beam, name: 'Horizontal Beam', vendor: GOLDBERG, quantity: 4 },
      { key: 'rung', sku: SKU.rung, name: 'Ladder Rung', vendor: GOLDBERG },
      { key: 'shared', sku: SKU.shared, name: 'Shared bracket', vendor: GOLDBERG },
      { key: 'kitFastener', sku: SKU.leg, name: 'Kit fastener', vendor: GOLDBERG, hardware: true },
      { key: 'pad', sku: SKU.pad, name: 'Floor padding', vendor: RESILITE },
      { key: 'balls', sku: SKU.balls, name: 'Ball pit balls', vendor: AMAZON },
    ]);
    const res = await receiveAndReview(orderId, {
      [AREA.legs]: cardinal(BLUE),
      [AREA.beams]: cardinal(ORANGE),
      [AREA.rungs]: cardinal(ORANGE), // agrees with beams on the shared part
      [AREA.mat]: { brand: 'vinyl', code: 'Charcoal' },
    });

    await expectColor(ids.legBay1!, BLUE_TEXT, 'leg bay 1');
    await expectColor(ids.legBay2!, BLUE_TEXT, 'leg bay 2');
    await expectColor(ids.ladder!, BLUE_TEXT, 'ladder post');
    await expectColor(ids.beam!, ORANGE_TEXT, 'beam');
    await expectColor(ids.rung!, ORANGE_TEXT, 'rung');
    await expectColor(ids.shared!, ORANGE_TEXT, 'shared part, two areas agreeing');
    await expectColor(ids.kitFastener!, null, 'hardware fastener sharing the leg part #');
    const pad = await line(ids.pad!);
    expect(pad.powderColor).toBe('Vinyl Charcoal');
    expect(pad.powderBrandId).toBeNull();
    expect(pad.powderColorCode).toBeNull();
    await expectColor(ids.balls!, null, 'unmapped part');

    // Colour never touches quantity.
    expect((await line(ids.legBay1!)).quantity).toBe(3);
    expect((await line(ids.legBay2!)).quantity).toBe(2);
    expect((await line(ids.beam!)).quantity).toBe(4);

    expect(res.colors?.linesUpdated).toBe(7);
    expect(res.colors?.conflicts).toEqual([]);
    expect(res.colors?.unmappedAreas).toEqual([]);
    expect(res.colors?.noMatchingLines).toEqual([]);
  });

  it('2. a part two areas claim with DIFFERENT picks is left blank and reported as a conflict; its other parts still apply', async () => {
    const { orderId, ids } = await makeOrder('T2', [
      { key: 'beam', sku: SKU.beam, name: 'Horizontal Beam', vendor: GOLDBERG },
      { key: 'rung', sku: SKU.rung, name: 'Ladder Rung', vendor: GOLDBERG },
      { key: 'shared', sku: SKU.shared, name: 'Shared bracket', vendor: GOLDBERG },
    ]);
    const res = await receiveAndReview(orderId, {
      [AREA.beams]: cardinal(ORANGE),
      [AREA.rungs]: cardinal(BLUE),
    });
    await expectColor(ids.shared!, null, 'conflicted part');
    await expectColor(ids.beam!, ORANGE_TEXT, 'beam');
    await expectColor(ids.rung!, BLUE_TEXT, 'rung');
    expect(res.colors?.conflicts).toEqual([
      {
        sku: SKU.shared,
        areas: [`${AREA.beams}: cardinal ${ORANGE}`, `${AREA.rungs}: cardinal ${BLUE}`].sort(),
      },
    ]);
    expect(res.colors?.linesUpdated).toBe(2);
  });

  it('3. a conflict arising on a RE-review CLEARS the superseded colour and reports it (was: left printing the old colour)', async () => {
    const { orderId, ids } = await makeOrder('T3', [
      { key: 'shared', sku: SKU.shared, name: 'Shared bracket', vendor: GOLDBERG },
    ]);
    await receiveAndReview(orderId, {
      [AREA.beams]: cardinal(BLUE),
      [AREA.rungs]: cardinal(BLUE),
    });
    await expectColor(ids.shared!, BLUE_TEXT, 'after first review (areas agree)');
    const res = await receiveAndReview(orderId, {
      [AREA.beams]: cardinal(ORANGE),
      [AREA.rungs]: cardinal(BLUE),
    });
    expect(res.colors?.conflicts?.map((c) => c.sku)).toEqual([SKU.shared]);
    // Cleared: printing BLUE would present a superseded answer as the customer's.
    await expectColor(ids.shared!, null, 'after conflicting re-review');
    expect(res.colors?.clearedLines).toHaveLength(1);
    expect(res.colors?.clearedLines?.[0]).toContain(SKU.shared);
    expect(res.colors?.clearedLines?.[0]).toContain(BLUE_TEXT);
    // The colour check still flags the part (conflict issue on both areas).
    const rep = await check.checkOrderColors(orderId);
    expect(rep.summary.problems).toBeGreaterThan(0);
  });

  it('3b. a conflict that already existed (only unchanged areas) leaves a staff resolution alone', async () => {
    const { orderId, ids } = await makeOrder('T3B', [
      { key: 'shared', sku: SKU.shared, name: 'Shared bracket', vendor: GOLDBERG },
      { key: 'leg', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG },
    ]);
    await receiveAndReview(orderId, {
      [AREA.beams]: cardinal(ORANGE),
      [AREA.rungs]: cardinal(BLUE),
      [AREA.legs]: cardinal(BLUE),
    });
    await expectColor(ids.shared!, null, 'conflict on first review: left blank');
    // Staff resolve the conflict by hand.
    await handoff.patchProcurementLine(
      ids.shared!,
      { powderBrandId: cardinalId, powderColorCode: ORANGE },
      userId,
    );
    // The customer changes only the legs.
    const res = await receiveAndReview(orderId, {
      [AREA.beams]: cardinal(ORANGE),
      [AREA.rungs]: cardinal(BLUE),
      [AREA.legs]: cardinal(ORANGE),
    });
    await expectColor(ids.shared!, ORANGE_TEXT, 'staff resolution kept');
    await expectColor(ids.leg!, ORANGE_TEXT, 'changed area applied');
    expect(res.colors?.clearedLines).toEqual([]);
  });

  it('4. a resubmitted answer replaces the old colour on every mapped line once reviewed, and the event keeps from → to', async () => {
    const { orderId, ids } = await makeOrder('T4', [
      { key: 'leg', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG },
      { key: 'ladder', sku: SKU.ladder, name: 'Ladder Post', vendor: GOLDBERG },
      { key: 'beam', sku: SKU.beam, name: 'Horizontal Beam', vendor: GOLDBERG },
    ]);
    await receiveAndReview(orderId, { [AREA.legs]: cardinal(BLUE), [AREA.beams]: cardinal(BLUE) });
    // New answers arrive but are NOT reviewed yet: the BOM keeps the reviewed colour.
    await receive(
      orderId,
      answersOf({ [AREA.legs]: cardinal(ORANGE), [AREA.beams]: cardinal(BLUE) }),
    );
    await expectColor(ids.leg!, BLUE_TEXT, 'leg before re-review');

    const res = await receiveAndReview(orderId, {
      [AREA.legs]: cardinal(ORANGE),
      [AREA.beams]: cardinal(BLUE),
    });
    await expectColor(ids.leg!, ORANGE_TEXT, 'leg after re-review');
    await expectColor(ids.ladder!, ORANGE_TEXT, 'ladder after re-review');
    await expectColor(ids.beam!, BLUE_TEXT, 'beam (answer unchanged)');
    expect(res.colors?.linesUpdated).toBe(2);
    expect(res.colors?.linesAlreadyCurrent).toBe(1);

    const ev = await db.orderEvent.findFirstOrThrow({
      where: { orderId, action: 'bom.colors.portal-review' },
      orderBy: { createdAt: 'desc' },
    });
    const changes = (ev.detail as { changes: Array<{ sku: string; from: string; to: string }> })
      .changes;
    expect(changes).toEqual(
      expect.arrayContaining([
        { sku: SKU.leg, area: AREA.legs, from: BLUE_TEXT, to: ORANGE_TEXT },
        { sku: SKU.ladder, area: AREA.legs, from: BLUE_TEXT, to: ORANGE_TEXT },
      ]),
    );
  });

  it('5. an area the customer DROPS on resubmission keeps its old colour, is reported by the review, and the colour check flags the line', async () => {
    const { orderId, ids } = await makeOrder('T5', [
      { key: 'leg', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG },
      { key: 'beam', sku: SKU.beam, name: 'Horizontal Beam', vendor: GOLDBERG },
    ]);
    await receiveAndReview(orderId, { [AREA.legs]: cardinal(BLUE), [AREA.beams]: cardinal(BLUE) });
    const res = await receiveAndReview(orderId, { [AREA.beams]: cardinal(ORANGE) });
    await expectColor(ids.beam!, ORANGE_TEXT, 'beam');
    await expectColor(ids.leg!, BLUE_TEXT, 'leg — area no longer answered, colour kept');
    expect(res.colors?.droppedAreas).toEqual([AREA.legs]);
    const rep = await check.checkOrderColors(orderId);
    // Explained by the dropped area, so not listed as an unexplained hand-set colour…
    expect(rep.handSet.map((h) => h.sku)).toEqual([]);
    // …but flagged as an issue on that area.
    const dropped = rep.areas.find((a) => a.areaKey === AREA.legs);
    expect(dropped?.dropped).toBe(true);
    expect(dropped?.issues.join(' ')).toContain(SKU.leg);
    expect(dropped?.issues.join(' ')).toContain('no longer answers');
    expect(rep.summary.problems).toBeGreaterThan(0);
    expect(rep.summary.areas).toBe(1);
  });

  it('6a. a staff colour edit is NOT touched while the customer answers are unchanged — a second review of the same version is refused', async () => {
    const { orderId, ids } = await makeOrder('T6A', [
      { key: 'leg', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG },
    ]);
    const first = await receiveAndReview(orderId, { [AREA.legs]: cardinal(BLUE) });
    await handoff.patchProcurementLine(
      ids.leg!,
      { powderBrandId: cardinalId, powderColorCode: ORANGE },
      userId,
    );
    await expectColor(ids.leg!, ORANGE_TEXT, 'leg after staff edit');
    await expect(
      review.reviewPortalItem(orderId, 'COLOR', userId, first.item.contentHash ?? ''),
    ).rejects.toThrow(/already been marked reviewed/);
    await expectColor(ids.leg!, ORANGE_TEXT, 'leg after refused re-review');
  });

  it('6b. re-review where the customer CHANGED that area overwrites a staff edit (reviewed pick wins) and records what was overwritten', async () => {
    const { orderId, ids } = await makeOrder('T6B', [
      { key: 'leg', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG },
      { key: 'beam', sku: SKU.beam, name: 'Horizontal Beam', vendor: GOLDBERG },
    ]);
    await receiveAndReview(orderId, { [AREA.legs]: cardinal(BLUE), [AREA.beams]: cardinal(BLUE) });
    await handoff.patchProcurementLine(
      ids.leg!,
      { powderBrandId: cardinalId, powderColorCode: ORANGE },
      userId,
    );
    // The customer changes the legs (to a third colour) — a new answer for that area.
    const GREEN = `${P}-GR01`;
    await receiveAndReview(orderId, {
      [AREA.legs]: cardinal(GREEN),
      [AREA.beams]: cardinal(BLUE),
    });
    expect((await line(ids.leg!)).powderColor).toBe(`Cardinal ${GREEN}`);
    await expectColor(ids.beam!, BLUE_TEXT, 'beam (unchanged)');
    const ev = await db.orderEvent.findFirstOrThrow({
      where: { orderId, action: 'bom.colors.portal-review' },
      orderBy: { createdAt: 'desc' },
    });
    const changes = (ev.detail as { changes: Array<{ sku: string; from: string; to: string }> })
      .changes;
    expect(changes).toContainEqual({
      sku: SKU.leg,
      area: AREA.legs,
      from: ORANGE_TEXT,
      to: `Cardinal ${GREEN}`,
    });
  });

  it('DEFECT A (fixed): a staff correction on an area the customer did NOT change survives a re-review of other answers', async () => {
    const { orderId, ids } = await makeOrder('T6C', [
      { key: 'leg', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG },
      { key: 'beam', sku: SKU.beam, name: 'Horizontal Beam', vendor: GOLDBERG },
    ]);
    await receiveAndReview(orderId, {
      [AREA.legs]: cardinal(BLUE),
      [AREA.beams]: cardinal(BLUE),
    });
    await handoff.patchProcurementLine(
      ids.leg!,
      { powderBrandId: cardinalId, powderColorCode: ORANGE },
      userId,
    );
    const res = await receiveAndReview(orderId, {
      [AREA.legs]: cardinal(BLUE), // unchanged
      [AREA.beams]: cardinal(ORANGE),
    });
    await expectColor(ids.leg!, ORANGE_TEXT, 'leg — staff correction should be kept');
    await expectColor(ids.beam!, ORANGE_TEXT, 'beam — changed area applied');
    expect(res.colors?.keptStaffEdits).toHaveLength(1);
    expect(res.colors?.keptStaffEdits?.[0]).toContain(SKU.leg);
    expect(res.colors?.keptStaffEdits?.[0]).toContain(ORANGE_TEXT);
  });

  it('DEFECT A: a review recorded before the answers were kept (legacy) re-applies every area, as before', async () => {
    const { orderId, ids } = await makeOrder('T6D', [
      { key: 'leg', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG },
    ]);
    await receiveAndReview(orderId, { [AREA.legs]: cardinal(BLUE) });
    // Strip the kept answers, as an event written before this change would look.
    const ev = await db.orderEvent.findFirstOrThrow({
      where: { orderId, action: 'portal.review' },
    });
    const { answers: _drop, ...legacy } = ev.detail as Record<string, unknown>;
    expect(_drop).toBeDefined();
    await db.orderEvent.update({ where: { id: ev.id }, data: { detail: legacy as object } });
    await handoff.patchProcurementLine(
      ids.leg!,
      { powderBrandId: cardinalId, powderColorCode: ORANGE },
      userId,
    );
    const res = await receiveAndReview(orderId, {
      [AREA.legs]: cardinal(BLUE),
      [AREA.beams]: cardinal(BLUE),
    });
    await expectColor(ids.leg!, BLUE_TEXT, 'unknown previous answers: reviewed pick wins');
    expect(res.colors?.keptStaffEdits).toEqual([]);
  });

  it('7. a line added AFTER review stays blank, review cannot be re-run, and the colour check flags it as a MISMATCH (documented gap — see report)', async () => {
    const { orderId } = await makeOrder('T7', [
      { key: 'leg', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG },
    ]);
    const first = await receiveAndReview(orderId, { [AREA.legs]: cardinal(BLUE) });
    const late = await handoff.upsertProcurementLine(
      orderId,
      { sku: SKU.leg, name: 'Vertical Post (added later)', quantity: 2, vendor: GOLDBERG },
      userId,
    );
    await expectColor(late.id, null, 'late-added leg');
    await expect(
      review.reviewPortalItem(orderId, 'COLOR', userId, first.item.contentHash ?? ''),
    ).rejects.toThrow(/already been marked reviewed/);

    const rep = await check.checkOrderColors(orderId);
    const area = rep.areas.find((a) => a.areaKey === AREA.legs);
    const lateRow = area?.lines.find((l) => l.lineId === late.id);
    expect(lateRow?.status).toBe('MISMATCH');
    expect(lateRow?.expected).toBe(BLUE_TEXT);
    expect(rep.summary.problems).toBeGreaterThan(0);
    // …and the check points to the tool that fixes exactly this.
    expect(rep.guidance.join(' ')).toContain('Re-apply reviewed colours');
  });

  it('7b. “Re-apply reviewed colours” fills only BLANK lines: late-added line coloured, staff edit and kit fastener untouched', async () => {
    const { orderId, ids } = await makeOrder('T7B', [
      { key: 'leg', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG },
      { key: 'ladder', sku: SKU.ladder, name: 'Ladder Post', vendor: GOLDBERG },
    ]);
    await receiveAndReview(orderId, { [AREA.legs]: cardinal(BLUE) });
    await handoff.patchProcurementLine(
      ids.ladder!,
      { powderBrandId: cardinalId, powderColorCode: ORANGE },
      userId,
    );
    const late = await handoff.upsertProcurementLine(
      orderId,
      { sku: SKU.leg, name: 'Vertical Post (added later)', quantity: 2, vendor: SECOND },
      userId,
    );
    const fastener = await db.procurementLine.create({
      data: {
        orderId,
        sku: SKU.leg,
        name: 'Kit fastener sharing the part number',
        vendor: GOLDBERG,
        quantity: 4,
        quantityOriginal: 4,
        unitCostMinor: 10,
        isHardwareComponent: true,
        kitSku: 'H-1000',
      },
    });

    const { colors } = await review.reapplyReviewedColors(orderId, userId);
    await expectColor(late.id, BLUE_TEXT, 'late-added line filled');
    await expectColor(ids.ladder!, ORANGE_TEXT, 'staff edit kept');
    await expectColor(ids.leg!, BLUE_TEXT, 'already coloured');
    await expectColor(fastener.id, null, 'kit fastener never painted');
    expect(colors.linesUpdated).toBe(1);
    expect(colors.keptStaffEdits?.join(' ')).toContain(SKU.ladder);
    const ev = await db.orderEvent.findFirstOrThrow({
      where: { orderId, action: 'bom.colors.portal-reapply' },
    });
    expect((ev.detail as { linesUpdated: number }).linesUpdated).toBe(1);

    // Answers that changed since review must be reviewed, not re-applied.
    await receive(orderId, answersOf({ [AREA.legs]: cardinal(ORANGE) }));
    await expect(review.reapplyReviewedColors(orderId, userId)).rejects.toThrow(
      /changed their colours since/,
    );
  });

  it('7c. re-apply is refused when nothing has been reviewed', async () => {
    const { orderId } = await makeOrder('T7C', [
      { key: 'leg', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG },
    ]);
    await expect(review.reapplyReviewedColors(orderId, userId)).rejects.toThrow(/marked reviewed/);
    await receive(orderId, answersOf({ [AREA.legs]: cardinal(BLUE) }));
    await expect(review.reapplyReviewedColors(orderId, userId)).rejects.toThrow(/marked reviewed/);
  });

  it('7d. a re-review of answers the customer did not change for an area fills a blank (late-added) line of that area', async () => {
    const { orderId, ids } = await makeOrder('T7D', [
      { key: 'leg', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG },
      { key: 'beam', sku: SKU.beam, name: 'Horizontal Beam', vendor: GOLDBERG },
    ]);
    await receiveAndReview(orderId, { [AREA.legs]: cardinal(BLUE), [AREA.beams]: cardinal(BLUE) });
    const late = await handoff.upsertProcurementLine(
      orderId,
      { sku: SKU.ladder, name: 'Ladder Post (added later)', quantity: 1, vendor: GOLDBERG },
      userId,
    );
    await receiveAndReview(orderId, {
      [AREA.legs]: cardinal(BLUE),
      [AREA.beams]: cardinal(ORANGE),
    });
    await expectColor(late.id, BLUE_TEXT, 'blank line of an unchanged area filled');
    await expectColor(ids.beam!, ORANGE_TEXT, 'changed area applied');
  });

  it('inactive palettes do not name colours: a retired chart prints brand + code only', async () => {
    const { orderId, ids } = await makeOrder('TPAL', [
      { key: 'leg', sku: SKU.leg, name: 'Vertical Post', vendor: GOLDBERG },
    ]);
    await db.vendorColorPalette.updateMany({
      where: { manufacturerId: mfrIds[0]!, name: 'Cardinal' },
      data: { active: false },
    });
    try {
      await receiveAndReview(orderId, { [AREA.legs]: cardinal(BLUE) });
      expect((await line(ids.leg!)).powderColor).toBe(`Cardinal ${BLUE}`);
    } finally {
      await db.vendorColorPalette.updateMany({
        where: { manufacturerId: mfrIds[0]!, name: 'Cardinal' },
        data: { active: true },
      });
    }
  });

  it('8. one part on two vendors’ sheets: both coloured; once one vendor is submitted only the open vendor changes', async () => {
    const { orderId, ids } = await makeOrder('T8', [
      { key: 'primary', sku: SKU.dual, name: 'Dual-sourced frame', vendor: GOLDBERG },
      { key: 'secondary', sku: SKU.dual, name: 'Dual-sourced frame', vendor: SECOND },
    ]);
    await receiveAndReview(orderId, { [AREA.dual]: cardinal(BLUE) });
    await expectColor(ids.primary!, BLUE_TEXT, 'primary vendor line');
    await expectColor(ids.secondary!, BLUE_TEXT, 'second vendor line');

    await db.bomVendorSection.create({ data: { orderId, vendor: SECOND, status: 'SUBMITTED' } });
    const res = await receiveAndReview(orderId, { [AREA.dual]: cardinal(ORANGE) });
    await expectColor(ids.primary!, ORANGE_TEXT, 'primary vendor line after re-review');
    await expectColor(ids.secondary!, BLUE_TEXT, 'submitted vendor line — frozen');
    expect(res.colors?.skippedVendors).toEqual([SECOND]);
  });

  it('9a. part numbers match regardless of case and surrounding whitespace, on the line and in the saved mapping', async () => {
    // Saved through the admin service exactly as an admin might type it.
    const saved = await mapping.saveColorArea(
      AREA.caseArea,
      [`   ${SKU.caseA.toLowerCase()}   `],
      userId,
    );
    expect(saved.parts.map((p) => p.sku)).toEqual([SKU.caseA.toLowerCase()]);
    expect(saved.unknownSkus).toEqual([SKU.caseA.toLowerCase()]);

    const { orderId, ids } = await makeOrder('T9A', [
      { key: 'messy', sku: `  ${SKU.caseA}  `, name: 'Messy part #', vendor: GOLDBERG },
      { key: 'lower', sku: SKU.caseA.toLowerCase(), name: 'Lower part #', vendor: GOLDBERG },
    ]);
    const res = await receiveAndReview(orderId, { [AREA.caseArea]: cardinal(BLUE) });
    await expectColor(ids.messy!, BLUE_TEXT, 'whitespace-padded part #');
    await expectColor(ids.lower!, BLUE_TEXT, 'lower-case part #');
    expect(res.colors?.noMatchingLines).toEqual([]);
  });

  it('9b. an area key typed in a different CASE is saved lower-case and matches the portal’s key', async () => {
    const upperKey = `${AK.toUpperCase()}_FRAME.UPPER_CASE`;
    const portalKey = upperKey.toLowerCase();
    const saved = await mapping.saveColorArea(upperKey, [SKU.caseA], userId);
    expect(saved.areaKey).toBe(portalKey);
    const rows = await db.portalColorAreaMapping.findMany({
      where: { areaKey: { equals: portalKey, mode: 'insensitive' } },
    });
    expect(rows.map((r) => r.areaKey)).toEqual([portalKey]);
    const { orderId, ids } = await makeOrder('T9B', [
      { key: 'part', sku: SKU.caseA, name: 'Part', vendor: GOLDBERG },
    ]);
    const res = await receiveAndReview(orderId, { [portalKey]: cardinal(BLUE) });
    expect(res.colors?.unmappedAreas).toEqual([]);
    await expectColor(ids.part!, BLUE_TEXT, 'line under a case-insensitively matched area key');
  });

  it('9c. a mis-cased key already stored (before keys were lower-cased) still matches, and re-saving folds it into the lower-case key', async () => {
    const legacyKey = `${AK.toUpperCase()}_FRAME.LEGACY_CASE`;
    const portalKey = legacyKey.toLowerCase();
    await db.portalColorAreaMapping.create({ data: { areaKey: legacyKey, sku: SKU.caseA } });
    const { orderId, ids } = await makeOrder('T9C', [
      { key: 'part', sku: SKU.caseA, name: 'Part', vendor: GOLDBERG },
    ]);
    const res = await receiveAndReview(orderId, { [portalKey]: cardinal(BLUE) });
    expect(res.colors?.unmappedAreas).toEqual([]);
    await expectColor(ids.part!, BLUE_TEXT, 'legacy mis-cased key');

    const listed = (await mapping.listColorAreas()).filter(
      (a) => a.areaKey.toLowerCase() === portalKey,
    );
    expect(listed.map((a) => a.areaKey)).toEqual([portalKey]);

    await mapping.saveColorArea(portalKey, [SKU.caseA], userId);
    const rows = await db.portalColorAreaMapping.findMany({
      where: { areaKey: { equals: portalKey, mode: 'insensitive' } },
    });
    expect(rows.map((r) => r.areaKey)).toEqual([portalKey]);
  });
});
