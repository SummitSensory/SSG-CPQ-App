import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { PrismaClient } from '@prisma/client';

/**
 * Audit: the customer-colour pipeline as staff drive it — over HTTP, against a REAL
 * database.
 *
 * portal-color-to-bom.test.ts proves the review FUNCTION writes the right colours
 * into every vendor format. This file proves the ROUTES the order page and the
 * Administration screen call: who may call them, what they refuse, what a second
 * click does, and that each response carries the fields the browser code reads
 * (public/order-portal.js, public/portal-color-areas.js, openColorCheck and the BOM
 * table in public/app.js). A renamed field there would render as a silent blank.
 *
 * Nothing here talks to monday, QuickBooks, Docuseal or email: the COLOR review
 * touches only the database (monday is ticked for DELIVERY only), the colour check
 * reads the board id from env without calling it, and no route that sends is
 * invoked. Area keys, part numbers and vendors are all under a per-run prefix and
 * removed in afterAll.
 */

const RUN = Date.now().toString(36).toLowerCase();
const P = `ZR${RUN.toUpperCase()}`;
const FRAME = `zr${RUN}_frame`; // a portal group of its own, so no other mapping interferes
const MAT = `zr${RUN}_mat`;
const AREA = {
  legs: `${FRAME}.legs`,
  beams: `${FRAME}.beams`,
  mat: `${MAT}.system`,
  extra: `${FRAME}.slide`, // answered later, never mapped
};
const GOLDBERG = `${P} Goldberg`;
const RESILITE = `${P} Resilite`;
const SKU = {
  leg: `${P}-A2245`,
  beam: `${P}-A2410`,
  pad: `${P}-PAD`,
  balls: `${P}-BALLS`, // on no area: must stay blank
};

type Answers = { selections: Record<string, Record<string, { brand: string; code: string }>> };
const ANSWERS: Answers = {
  selections: {
    [FRAME]: {
      legs: { brand: 'cardinal', code: 'T009-BL05' },
      beams: { brand: 'cardinal', code: 'T009-OG26' },
    },
    [MAT]: { system: { brand: 'vinyl', code: 'Charcoal' } },
  },
};

let db: PrismaClient;
let app: FastifyInstance;
let portal: typeof import('../../src/portal/orderPortal.js');

const users: Record<'admin' | 'ops' | 'mgr' | 'rep' | 'ro', { id: string; token: string }> = {
  admin: { id: '', token: '' },
  ops: { id: '', token: '' },
  mgr: { id: '', token: '' },
  rep: { id: '', token: '' },
  ro: { id: '', token: '' },
};
const ROLE = {
  admin: 'SYSTEM_ADMIN',
  ops: 'OPERATIONS',
  mgr: 'SALES_MANAGER',
  rep: 'SALES_REP',
  ro: 'READ_ONLY',
} as const;

let orgId = '';
let orderId = '';
let cardinalId = '';
const createdBrandIds: string[] = [];
const mfrIds: string[] = [];

type Who = keyof typeof users | null;

async function call(
  who: Who,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: who ? { authorization: `Bearer ${users[who].token}` } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

const json = <T>(r: LightMyRequestResponse): T => r.json() as T;

/** Put new customer answers on the COLOR step, as a monday refresh would. */
async function receive(answers: unknown): Promise<string> {
  const hash = portal.contentHashOf('PROVIDED', answers);
  await db.orderPortalItem.upsert({
    where: { orderId_kind: { orderId, kind: 'COLOR' } },
    create: {
      orderId,
      kind: 'COLOR',
      state: 'PROVIDED',
      answers: answers as object,
      contentHash: hash,
      obtainedAt: new Date(),
      sourceItemId: '1',
    },
    update: { answers: answers as object, contentHash: hash },
  });
  return hash;
}

async function lineColor(sku: string): Promise<string | null> {
  return (await db.procurementLine.findFirstOrThrow({ where: { orderId, sku } })).powderColor;
}

const reviewUrl = (kind = 'color', id = orderId) => `/orders/${id}/portal/${kind}/review`;

// The shapes the browser reads. Kept here as types so a test that reads a field the
// server stopped sending fails to compile, not just to match.
interface PortalItemView {
  kind: string;
  display: string;
  mondayStatus: string | null;
  answers: unknown;
  obtainedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  lastSyncedAt: string | null;
  contentHash: string | null;
}
interface ColorsResult {
  linesUpdated: number;
  unmappedAreas: string[];
  noMatchingLines: string[];
  skippedVendors: string[];
  conflicts?: Array<{ sku: string; areas: string[] }>;
  offChart?: string[];
}
interface ReviewResponse {
  item: PortalItemView;
  mondayNote: string | null;
  colors: ColorsResult | null;
}
interface CheckLine {
  vendor: string;
  sku: string;
  name: string;
  expected: string;
  onLine: string | null;
  onBom: string | null;
  columnShown: boolean;
  vendorSubmitted: boolean;
  status: string;
}
interface ColorCheck {
  source: { boardId: string; itemId: string | null; columnId: string; columnTitle: string };
  portal: { found: boolean; state: string | null; reviewed: boolean; lastSyncedAt: string | null };
  areas: Array<{
    areaKey: string;
    label: string;
    kind: string;
    pick: { brand: string; code: string };
    source: { columnId: string; path: string };
    mappedParts: string[];
    lines: CheckLine[];
    issues: string[];
  }>;
  handSet: Array<{ vendor: string; sku: string; name: string; onLine: string }>;
  bomErrors: string[];
  summary: { ok: number; problems: number; areas: number };
}
interface AreaRow {
  areaKey: string;
  label: string;
  orderCount: number;
  samples: Array<{ brand: string; code: string; count: number }>;
  parts: Array<{ sku: string; name: string | null; piece: number | null }>;
}

beforeAll(async () => {
  ({ prisma: db } = await import('../../src/lib/prisma.js'));
  portal = await import('../../src/portal/orderPortal.js');
  const { signAccessToken } = await import('../../src/auth/tokens.js');

  for (const k of Object.keys(users) as Array<keyof typeof users>) {
    const u = await db.user.create({
      data: {
        email: `${P.toLowerCase()}-${k}@example.com`,
        passwordHash: 'x',
        name: `Audit ${ROLE[k]}`,
        role: ROLE[k],
      },
    });
    users[k] = { id: u.id, token: await signAccessToken({ sub: u.id, role: ROLE[k] }) };
  }

  const org = await db.organization.create({
    data: { name: `${P} Gym`, normalizedName: `${P.toLowerCase()} gym` },
  });
  orgId = org.id;

  const have = await db.powderColorBrand.findUnique({ where: { name: 'Cardinal' } });
  if (have) cardinalId = have.id;
  else {
    cardinalId = (await db.powderColorBrand.create({ data: { name: 'Cardinal' } })).id;
    createdBrandIds.push(cardinalId);
  }

  for (const name of [GOLDBERG, RESILITE]) {
    const m = await db.manufacturer.create({
      data: {
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        isSteelFabricator: name === GOLDBERG,
      },
    });
    mfrIds.push(m.id);
  }
  await db.vendorColorPalette.create({
    data: {
      manufacturerId: mfrIds[0]!,
      name: 'Cardinal',
      finishType: 'POWDER_COAT',
      colors: {
        create: [
          { name: 'Blue 90 Gloss (T009-BL05)', vendorCode: 'T009-BL05', sortOrder: 0 },
          { name: 'International Orange 90 Gloss', vendorCode: 'T009-OG26', sortOrder: 1 },
        ],
      },
    },
  });

  // Catalog rows, so the send blockers have nothing to say about unknown part numbers
  // and the only thing that COULD block a send is the colour review under audit.
  for (const [sku, desc, mfr] of [
    [SKU.leg, 'Vertical Post', GOLDBERG],
    [SKU.beam, 'Horizontal Beam', GOLDBERG],
    [SKU.pad, 'Floor padding', RESILITE],
    [SKU.balls, 'Ball pit balls', RESILITE],
  ] as const) {
    await db.sku.create({ data: { part: sku, description: desc, manufacturer: mfr } });
  }

  const creator = users.admin.id;
  const proposal = await db.proposal.create({
    data: { number: `${P}-P`, organizationId: orgId, title: 'Audit', createdById: creator },
  });
  const version = await db.proposalVersion.create({
    data: { proposalId: proposal.id, version: 1, sections: [], items: [], createdById: creator },
  });
  const snap = await db.priceSnapshot.create({
    data: {
      currency: 'USD',
      engineVersion: 'test',
      input: {},
      breakdown: {},
      grandTotal: 0n,
      createdById: creator,
    },
  });
  const order = await db.acceptedOrder.create({
    data: {
      number: `${P}-SO`,
      organizationId: orgId,
      proposalId: proposal.id,
      proposalVersionId: version.id,
      acceptedVersion: 1,
      priceSnapshotId: snap.id,
      currency: 'USD',
      grandTotalMinor: 0n,
      contentSnapshot: {},
      integrityHash: 'x',
      acceptedById: creator,
    },
  });
  orderId = order.id;
  const L = (sku: string, name: string, vendor: string) => ({
    orderId,
    sku,
    name,
    vendor,
    quantity: 1,
    unitCostMinor: 1000,
  });
  await db.procurementLine.createMany({
    data: [
      L(SKU.leg, 'Vertical Post', GOLDBERG),
      L(SKU.beam, 'Horizontal Beam', GOLDBERG),
      L(SKU.pad, 'Floor padding', RESILITE),
      L(SKU.balls, 'Ball pit balls', RESILITE),
    ],
  });

  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerOrderRoutes } = await import('../../src/routes/orders.js');
  const { registerBomRoutes } = await import('../../src/routes/bom.js');
  const { registerPortalColorAreaRoutes } = await import('../../src/routes/portalColorAreas.js');
  app = Fastify();
  registerErrorHandler(app);
  registerOrderRoutes(app);
  registerBomRoutes(app);
  registerPortalColorAreaRoutes(app);
  await app.ready();
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (!db) return;
  const ids = Object.values(users)
    .map((u) => u.id)
    .filter(Boolean);
  if (orderId) {
    await db.orderEvent.deleteMany({ where: { orderId } });
    await db.acceptedOrder.deleteMany({ where: { id: orderId } }); // cascades lines/items/sections
  }
  await db.portalColorAreaMapping.deleteMany({
    where: { OR: [{ areaKey: { startsWith: `zr${RUN}_` } }, { sku: { startsWith: P } }] },
  });
  await db.sku.deleteMany({ where: { part: { startsWith: P } } });
  await db.vendorColorPalette.deleteMany({ where: { manufacturerId: { in: mfrIds } } });
  await db.priceSnapshot.deleteMany({ where: { createdById: { in: ids } } });
  await db.proposalVersion.deleteMany({ where: { createdById: { in: ids } } });
  await db.proposal.deleteMany({ where: { createdById: { in: ids } } });
  await db.manufacturer.deleteMany({ where: { id: { in: mfrIds } } });
  // Cardinal/Prismatic are shared reference rows — left in place so suites
  // running in parallel don't lose them mid-test.
  await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

describe('Administration → Portal colour areas: who may read and change the mapping', () => {
  it('refuses an anonymous caller (401) on both routes', async () => {
    expect((await call(null, 'GET', '/admin/portal-color-areas')).statusCode).toBe(401);
    expect(
      (await call(null, 'PUT', `/admin/portal-color-areas/${AREA.legs}`, { parts: [] })).statusCode,
    ).toBe(401);
  });

  it('refuses every role without PRODUCTS_ADMIN (403), and saves nothing', async () => {
    for (const who of ['ops', 'mgr', 'rep', 'ro'] as const) {
      expect((await call(who, 'GET', '/admin/portal-color-areas')).statusCode, who).toBe(403);
      const put = await call(who, 'PUT', `/admin/portal-color-areas/${AREA.legs}`, {
        parts: [{ sku: SKU.leg }],
      });
      expect(put.statusCode, who).toBe(403);
    }
    expect(await db.portalColorAreaMapping.count({ where: { areaKey: AREA.legs } })).toBe(0);
  });
});

describe('Administration → Portal colour areas: input validation', () => {
  it.each([
    ['no dot', 'legs'],
    ['three parts', 'a.b.c'],
    ['a space', encodeURIComponent('frame paint.legs')],
    ['a quote', encodeURIComponent("frame'.legs")],
    ['an empty half', 'frame.'],
  ])('rejects an area key with %s (400)', async (_why, key) => {
    const r = await call('admin', 'PUT', `/admin/portal-color-areas/${key}`, { parts: [] });
    expect(r.statusCode).toBe(400);
  });

  it.each([
    ['no part list at all', {}],
    ['a piece of 0', { parts: [{ sku: SKU.leg, piece: 0 }] }],
    ['a piece of 8 (a colour spec holds at most 7)', { parts: [{ sku: SKU.leg, piece: 8 }] }],
    ['a fractional piece', { parts: [{ sku: SKU.leg, piece: 1.5 }] }],
    ['a blank part number', { parts: [{ sku: '   ' }] }],
    ['an 81-character part number', { parts: [{ sku: 'X'.repeat(81) }] }],
    ['a pattern too broad to be safe', { parts: [{ sku: 'R*' }] }],
  ])('rejects a body with %s (400)', async (_why, body) => {
    const r = await call('admin', 'PUT', `/admin/portal-color-areas/${AREA.legs}`, body);
    expect(r.statusCode).toBe(400);
    expect(json<{ message: string }>(r).message).toBeTruthy();
  });

  it('saves a part number the catalog does not know, and names it back as unknown', async () => {
    const ghost = `${P}-NOPE`;
    const r = await call('admin', 'PUT', `/admin/portal-color-areas/${AREA.extra}`, {
      parts: [{ sku: ghost }],
    });
    expect(r.statusCode).toBe(200);
    expect(json<{ unknownSkus: string[] }>(r).unknownSkus).toEqual([ghost]);
    // Cleared again: AREA.extra is the "never mapped" area later on.
    const clear = await call('admin', 'PUT', `/admin/portal-color-areas/${AREA.extra}`, {
      parts: [],
    });
    expect(clear.statusCode).toBe(200);
    expect(await db.portalColorAreaMapping.count({ where: { areaKey: AREA.extra } })).toBe(0);
  });
});

describe('the full staff path: map → customer answers → Mark reviewed → BOM → colour check', () => {
  let hash = '';

  it('an admin maps each area; the response carries what the screen reads', async () => {
    for (const [area, sku] of [
      [AREA.legs, SKU.leg],
      [AREA.beams, SKU.beam],
      [AREA.mat, SKU.pad],
    ] as const) {
      const r = await call('admin', 'PUT', `/admin/portal-color-areas/${area}`, {
        parts: [{ sku: sku.toLowerCase(), piece: null }], // typed in lower case
      });
      expect(r.statusCode, area).toBe(200);
      const body = json<{
        areaKey: string;
        parts: AreaRow['parts'];
        added: string[];
        removed: string[];
        unknownSkus: string[];
      }>(r);
      // Stored in the catalog's own spelling, with the catalog description.
      expect(body).toMatchObject({ areaKey: area, added: [sku], removed: [], unknownSkus: [] });
      expect(body.parts).toEqual([{ sku, name: expect.any(String), piece: null }]);
    }
    // Saving the same list again is a no-op, not a duplicate.
    const again = await call('admin', 'PUT', `/admin/portal-color-areas/${AREA.legs}`, {
      parts: [{ sku: SKU.leg }],
    });
    expect(json<{ added: string[]; removed: string[] }>(again)).toMatchObject({
      added: [],
      removed: [],
    });
    expect(await db.portalColorAreaMapping.count({ where: { areaKey: AREA.legs } })).toBe(1);
  });

  it('the customer answers; the Portal card sees them as NEW with a version to review', async () => {
    hash = await receive(ANSWERS);
    const r = await call('ops', 'GET', `/orders/${orderId}/portal`);
    expect(r.statusCode).toBe(200);
    const items = json<PortalItemView[]>(r);
    const color = items.find((i) => i.kind === 'COLOR')!;
    // Every field public/order-portal.js cardHtml reads is present.
    for (const k of [
      'kind',
      'display',
      'mondayStatus',
      'answers',
      'obtainedAt',
      'reviewedAt',
      'reviewedBy',
      'lastSyncedAt',
      'contentHash',
    ]) {
      expect(color, k).toHaveProperty(k);
    }
    expect(color).toMatchObject({ display: 'NEW', contentHash: hash, reviewedAt: null });
    expect(color.answers).toEqual(ANSWERS);

    // The Orders list marks the row too (the "New portal information" stripe).
    const list = json<Array<{ id: string; portal: Record<string, { display: string }> | null }>>(
      await call('ops', 'GET', '/orders'),
    );
    expect(list.find((o) => o.id === orderId)?.portal?.COLOR?.display).toBe('NEW');

    // And the admin screen counts this order against each area it answers.
    const areas = json<{ areas: AreaRow[] }>(
      await call('admin', 'GET', '/admin/portal-color-areas'),
    ).areas;
    const legs = areas.find((a) => a.areaKey === AREA.legs)!;
    expect(legs).toMatchObject({
      label: expect.any(String),
      orderCount: 1,
      samples: [{ brand: 'cardinal', code: 'T009-BL05', count: 1 }],
      parts: [{ sku: SKU.leg, name: 'Vertical Post', piece: null }],
    });
  });

  it('before review: nothing on the BOM, and the colour check says "not reviewed"', async () => {
    for (const sku of Object.values(SKU)) expect(await lineColor(sku), sku).toBeNull();
    const r = await call('rep', 'GET', `/orders/${orderId}/bom/color-check`);
    expect(r.statusCode).toBe(200);
    const rep = json<ColorCheck>(r);
    expect(rep.portal).toMatchObject({ found: true, state: 'PROVIDED', reviewed: false });
    expect(rep.summary.problems).toBeGreaterThan(0);
    expect(rep.areas.flatMap((a) => a.lines).every((l) => l.status === 'MISMATCH')).toBe(true);
  });

  it('sending is NOT blocked by unreviewed colour answers (by decision) — only surfaced', async () => {
    const r = await call('ops', 'GET', `/orders/${orderId}/bom/sections`);
    expect(r.statusCode).toBe(200);
    const sections = json<{ sections: Array<{ id: string; vendor: string }> }>(r).sections;
    for (const vendor of [GOLDBERG, RESILITE]) {
      const s = sections.find((x) => x.vendor === vendor);
      expect(s, vendor).toBeTruthy();
      const b = await call('ops', 'GET', `/bom/sections/${s!.id}/blockers`);
      expect(b.statusCode).toBe(200);
      // The send path (src/handoff/bomSend.ts) refuses only on these blockers.
      expect(json<{ blockers: string[] }>(b).blockers, vendor).toEqual([]);
    }
  });

  it('a role without ORDERS_MANAGE cannot mark it reviewed (403), and the BOM is untouched', async () => {
    for (const who of ['rep', 'ro'] as const) {
      const r = await call(who, 'POST', reviewUrl(), { contentHash: hash });
      expect(r.statusCode, who).toBe(403);
    }
    expect((await call(null, 'POST', reviewUrl(), { contentHash: hash })).statusCode).toBe(401);
    for (const sku of Object.values(SKU)) expect(await lineColor(sku), sku).toBeNull();
  });

  it.each([
    ['an unknown step', () => reviewUrl('paint'), () => ({ contentHash: hash }), 400],
    ['no version sent', () => reviewUrl(), () => ({}), 400],
    ['a non-string version', () => reviewUrl(), () => ({ contentHash: 42 }), 400],
    [
      'a version the customer has since replaced',
      () => reviewUrl(),
      () => ({ contentHash: 'x' }),
      409,
    ],
    [
      'an unknown order',
      () => reviewUrl('color', 'no-such-order'),
      () => ({ contentHash: hash }),
      404,
    ],
    [
      'a step the customer never answered',
      () => reviewUrl('billing'),
      () => ({ contentHash: hash }),
      404,
    ],
  ])('refuses %s', async (_why, url, body, status) => {
    const r = await call('ops', 'POST', url(), body());
    expect(r.statusCode).toBe(status);
    expect(json<{ message: string }>(r).message).toBeTruthy();
    for (const sku of Object.values(SKU)) expect(await lineColor(sku), sku).toBeNull();
  });

  it('Mark reviewed writes each pick onto its part; the response is what the card renders', async () => {
    const r = await call('ops', 'POST', reviewUrl(), { contentHash: hash });
    expect(r.statusCode).toBe(200);
    const res = json<ReviewResponse>(r);
    expect(res.item).toMatchObject({
      kind: 'COLOR',
      display: 'REVIEWED',
      reviewedBy: 'Audit OPERATIONS',
      contentHash: hash,
    });
    expect(res.item.reviewedAt).toEqual(expect.any(String));
    expect(res.mondayNote).toBeNull();
    // reviewNoteHtml reads exactly these; `unmappedAreas`/`noMatchingLines`/
    // `skippedVendors` are dereferenced without a guard, so they must be arrays.
    expect(res.colors).toMatchObject({
      linesUpdated: 3,
      unmappedAreas: [],
      noMatchingLines: [],
      skippedVendors: [],
      conflicts: [],
      offChart: [],
    });

    const leg = await db.procurementLine.findFirstOrThrow({ where: { orderId, sku: SKU.leg } });
    expect(leg).toMatchObject({ powderBrandId: cardinalId, powderColorCode: 'T009-BL05' });
    expect(leg.powderColor).toMatch(/^Cardinal .*T009-BL05$/);
    expect(await lineColor(SKU.beam)).toMatch(/^Cardinal .*T009-OG26$/);
    expect(await lineColor(SKU.pad)).toBe('Vinyl Charcoal');
    expect(await lineColor(SKU.balls)).toBeNull();

    // Recorded on the order's timeline.
    expect(
      await db.orderEvent.count({ where: { orderId, action: 'portal.review' } }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('the BOM endpoints the order page and the sheet read now carry the colours', async () => {
    const want: Record<string, string | null> = {};
    for (const sku of Object.values(SKU)) want[sku] = await lineColor(sku);

    // The BOM table on the order page renders order.procurement[].powderColor.
    const order = json<{
      procurement: Array<{
        sku: string;
        powderColor: string | null;
        powderColorCode: string | null;
        powderBrandId: string | null;
      }>;
    }>(await call('ops', 'GET', `/orders/${orderId}`));
    for (const sku of Object.values(SKU)) {
      expect(order.procurement.find((p) => p.sku === sku)?.powderColor ?? null, sku).toBe(
        want[sku],
      );
    }
    expect(order.procurement.find((p) => p.sku === SKU.leg)).toMatchObject({
      powderColorCode: 'T009-BL05',
      powderBrandId: cardinalId,
    });

    // GET /orders/:id/bom — the per-vendor sheet's lines.
    for (const vendor of [GOLDBERG, RESILITE]) {
      const bom = json<{ lines: Array<{ sku: string; powderColor: string }> }>(
        await call('ops', 'GET', `/orders/${orderId}/bom?vendor=${encodeURIComponent(vendor)}`),
      );
      for (const l of bom.lines) expect(l.powderColor || null, l.sku).toBe(want[l.sku] ?? null);
      expect(bom.lines.length, vendor).toBe(2);
    }

    // The colour column is forced on for each vendor now carrying a colour.
    const sections = json<{ sections: Array<{ vendor: string; showPowderColor: boolean }> }>(
      await call('ops', 'GET', `/orders/${orderId}/bom/sections`),
    ).sections;
    for (const vendor of [GOLDBERG, RESILITE]) {
      expect(sections.find((s) => s.vendor === vendor)?.showPowderColor, vendor).toBe(true);
    }
  });

  it('the colour check reports every area OK, in the shape the "Check colors" dialog reads', async () => {
    const r = await call('ro', 'GET', `/orders/${orderId}/bom/color-check`);
    expect(r.statusCode).toBe(200);
    const rep = json<ColorCheck>(r);
    expect(rep.portal).toMatchObject({ found: true, reviewed: true });
    expect(rep.source).toEqual({
      boardId: expect.any(String),
      itemId: '1',
      columnId: expect.any(String),
      columnTitle: expect.any(String),
    });
    expect(rep.summary).toEqual({ ok: 3, problems: 0, areas: 3 });
    expect(rep.bomErrors).toEqual([]);
    expect(rep.handSet).toEqual([]);
    const byArea = new Map(rep.areas.map((a) => [a.areaKey, a]));
    expect([...byArea.keys()].sort()).toEqual([AREA.legs, AREA.beams, AREA.mat].sort());
    expect(byArea.get(AREA.legs)).toMatchObject({
      kind: 'FRAME',
      pick: { brand: 'cardinal', code: 'T009-BL05' },
      mappedParts: [SKU.leg],
      issues: [],
      source: { path: expect.stringContaining('legs') },
    });
    expect(byArea.get(AREA.mat)?.kind).toBe('VINYL');
    for (const a of rep.areas) {
      for (const l of a.lines) {
        expect(l).toMatchObject({ status: 'OK', columnShown: true, vendorSubmitted: false });
        expect(l.onLine).toBe(l.expected);
        expect(l.onBom).toBe(l.expected);
        expect(l.name).toBeTruthy();
      }
    }
  });

  it('clicking Mark reviewed again is refused (409) and does not re-apply over a hand fix', async () => {
    // Staff correct the leg by hand after the review.
    await db.procurementLine.updateMany({
      where: { orderId, sku: SKU.leg },
      data: { powderColor: 'Hand fixed', powderColorCode: null, powderBrandId: null },
    });
    const events = await db.orderEvent.count({ where: { orderId, action: 'portal.review' } });
    const r = await call('ops', 'POST', reviewUrl(), { contentHash: hash });
    expect(r.statusCode).toBe(409);
    expect(await lineColor(SKU.leg)).toBe('Hand fixed');
    expect(await db.orderEvent.count({ where: { orderId, action: 'portal.review' } })).toBe(events);
    // And the colour check shows the hand fix as a mismatch rather than hiding it.
    const rep = json<ColorCheck>(await call('ops', 'GET', `/orders/${orderId}/bom/color-check`));
    const leg = rep.areas.find((a) => a.areaKey === AREA.legs)!.lines[0]!;
    expect(leg).toMatchObject({ status: 'MISMATCH', onLine: 'Hand fixed' });
    expect(rep.summary.problems).toBe(1);
  });

  it('two simultaneous clicks on a new version: exactly one applies, the other gets 409', async () => {
    const changed = structuredClone(ANSWERS);
    changed.selections[FRAME]!.legs = { brand: 'cardinal', code: 'T009-OG26' };
    const h3 = await receive(changed);
    expect(h3).not.toBe(hash);
    const events = await db.orderEvent.count({ where: { orderId, action: 'portal.review' } });
    const [a, b] = await Promise.all([
      call('ops', 'POST', reviewUrl(), { contentHash: h3 }),
      call('admin', 'POST', reviewUrl(), { contentHash: h3 }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await db.orderEvent.count({ where: { orderId, action: 'portal.review' } })).toBe(
      events + 1,
    );
    expect(await lineColor(SKU.leg)).toMatch(/^Cardinal .*T009-OG26$/);
  });

  it('a newly answered area with no parts mapped is listed on the review and flagged by the check', async () => {
    const changed = structuredClone(ANSWERS);
    changed.selections[FRAME]!.slide = { brand: 'cardinal', code: 'T009-BL05' };
    const h = await receive(changed);
    const res = json<ReviewResponse>(await call('ops', 'POST', reviewUrl(), { contentHash: h }));
    expect(res.colors?.unmappedAreas).toEqual([AREA.extra]);
    const rep = json<ColorCheck>(await call('ops', 'GET', `/orders/${orderId}/bom/color-check`));
    const slide = rep.areas.find((a) => a.areaKey === AREA.extra)!;
    expect(slide.issues.length).toBeGreaterThan(0);
    expect(rep.summary.problems).toBeGreaterThan(0);
  });

  /**
   * Permission inconsistency, documented rather than asserted as a bug: SALES_MANAGER
   * holds ORDERS_MANAGE but not HANDOFF_MANAGE. Every direct BOM colour write
   * (apply-color, line edits, powder-color) requires HANDOFF_MANAGE, yet Mark reviewed
   * on the COLOR step — which writes the same columns — requires only ORDERS_MANAGE.
   * The UI agrees with the server (canReview = ORDERS_MANAGE_ROLES), so it is a
   * product decision, not a wiring fault.
   */
  it('SALES_MANAGER can colour BOM lines through Mark reviewed but not through apply-color', async () => {
    const changed = structuredClone(ANSWERS);
    changed.selections[FRAME]!.beams = { brand: 'cardinal', code: 'T009-BL05' };
    const h = await receive(changed);
    const viaReview = await call('mgr', 'POST', reviewUrl(), { contentHash: h });
    expect(viaReview.statusCode).toBe(200);
    expect(await lineColor(SKU.beam)).toMatch(/T009-BL05$/);
    const direct = await call('mgr', 'POST', `/orders/${orderId}/bom/apply-color`, {
      brandId: cardinalId,
      code: 'T009-OG26',
      skus: [SKU.beam],
    });
    expect(direct.statusCode).toBe(403);
  });

  /**
   * KNOWN GAP. A frame-paint code that is not on the brand's chart (a portal typo, or
   * a colour the chart lost) is written to the vendor's sheet as "Cardinal T009-ZZ99"
   * with no warning anywhere: the review result has no field for it (offChart covers
   * multi-piece parts only) and the colour check compares the line against the same
   * composed text, so it reports OK. Fails today; passes once either the review
   * (colors.offChart) or the colour check (an area issue) names the code.
   */
  it.fails(
    'KNOWN GAP: an off-chart frame-paint code is flagged by the review or the colour check',
    async () => {
      const changed = structuredClone(ANSWERS);
      changed.selections[FRAME]!.legs = { brand: 'cardinal', code: 'T009-ZZ99' };
      const h = await receive(changed);
      const res = json<ReviewResponse>(await call('ops', 'POST', reviewUrl(), { contentHash: h }));
      expect(await lineColor(SKU.leg)).toBe('Cardinal T009-ZZ99'); // applied as-is
      const rep = json<ColorCheck>(await call('ops', 'GET', `/orders/${orderId}/bom/color-check`));
      const legIssues = rep.areas.find((a) => a.areaKey === AREA.legs)!.issues;
      const flagged =
        (res.colors?.offChart ?? []).some((x) => x.includes('T009-ZZ99')) ||
        legIssues.some((x) => x.includes('T009-ZZ99'));
      expect(flagged).toBe(true);
    },
  );
});

describe('the colour check and portal routes for an order that does not exist', () => {
  it('the colour check is 401 anonymous and 404 for an unknown order', async () => {
    expect((await call(null, 'GET', `/orders/${orderId}/bom/color-check`)).statusCode).toBe(401);
    expect((await call('ops', 'GET', '/orders/no-such-order/bom/color-check')).statusCode).toBe(
      404,
    );
  });

  // Low severity, documented: unlike the colour check, GET /orders/:id/portal does not
  // check the order exists — it answers 200 with five empty ("NONE") steps.
  it('GET /orders/:id/portal answers 200 with empty steps for an unknown order', async () => {
    const r = await call('ops', 'GET', '/orders/no-such-order/portal');
    expect(r.statusCode).toBe(200);
    expect(json<PortalItemView[]>(r).every((i) => i.display === 'NONE')).toBe(true);
  });
});
