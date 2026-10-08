import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import type { PrismaClient } from '@prisma/client';

/**
 * Customer portal colour answers → the vendor's Bill of Materials, against a REAL
 * database.
 *
 * The other colour tests stub Prisma, which shows the planner makes the right
 * decisions but not that the decisions reach the sheet a vendor reads. This one
 * seeds an order the way the portal leaves it — the customer's answers in the
 * Manufacturing-board JSON shape, waiting for review — clicks review through the
 * same function the order page calls, and then reads the colour back out of every
 * place it should appear: the procurement line, the BOM model, and the rendered
 * PDF (HTML), Excel and CSV for each vendor. Each colour has to be on the row for
 * its own part number, on its own vendor's sheet, and nowhere else.
 *
 * Brand/code values and area keys are the ones real customers have submitted
 * (structure_frame_paint.*, adventure_mat.*, Cardinal, Prismatic and vinyl). Every
 * row is created under a per-run prefix and removed in afterAll, so the file is
 * safe against a development database with data of its own.
 */

const RUN = Date.now().toString(36).toUpperCase();
const P = `ZC${RUN}`;
const GOLDBERG = `${P} Goldberg`;
const RESILITE = `${P} Resilite`;
const AMAZON = `${P} Amazon`;

const SKU = {
  leg: `${P}-A2245`,
  ladderLeg: `${P}-A2246`,
  beam: `${P}-A2410`,
  rung: `${P}-P2330`,
  pad: `${P}-SSG-1007CLM`, // matched by the pattern mapping, like R-SSG-*CLM*
  wrap: `${P}-SSUSP67`,
  palisades: `${P}-RPAL6868`, // one part, a colour per piece
  balls: `${P}-BALLS`, // on no area: must stay blank
};

const ANSWERS = {
  selections: {
    structure_frame_paint: {
      legs: { brand: 'cardinal', code: 'T009-BL05' },
      horizontal_beams: { brand: 'prismatic', code: 'PRB-11039' },
      ladder_rungs_and_leg: { brand: 'cardinal', code: 'T009-OG26' },
    },
    adventure_mat: { adventure_mat_system: { brand: 'vinyl', code: 'Charcoal' } },
    palisades_mat: {
      palisades_mat_1: { brand: 'vinyl', code: 'Navy' },
      palisades_mat_2: { brand: 'vinyl', code: 'Orange' },
    },
  },
};

const MAPPING: Array<{ areaKey: string; sku: string; piece?: number }> = [
  { areaKey: 'structure_frame_paint.legs', sku: SKU.leg },
  { areaKey: 'structure_frame_paint.legs', sku: SKU.ladderLeg },
  { areaKey: 'structure_frame_paint.horizontal_beams', sku: SKU.beam },
  { areaKey: 'structure_frame_paint.ladder_rungs_and_leg', sku: SKU.rung },
  { areaKey: 'adventure_mat.adventure_mat_system', sku: `${P}-SSG-*CLM*` },
  { areaKey: 'adventure_mat.adventure_mat_system', sku: SKU.wrap },
  { areaKey: 'palisades_mat.palisades_mat_1', sku: SKU.palisades, piece: 1 },
  { areaKey: 'palisades_mat.palisades_mat_2', sku: SKU.palisades, piece: 2 },
];

/** What each part should print in the Powder color column after review. */
const EXPECT: Record<string, { vendor: string; desc: string; color: string }> = {
  [SKU.leg]: { vendor: GOLDBERG, desc: 'Vertical Post', color: 'Cardinal Blue 90 Gloss T009-BL05' },
  [SKU.ladderLeg]: {
    vendor: GOLDBERG,
    desc: 'Vertical Post — Ladder Bay',
    color: 'Cardinal Blue 90 Gloss T009-BL05',
  },
  [SKU.beam]: {
    vendor: GOLDBERG,
    desc: 'Horizontal Beam',
    color: 'Prismatic Rosette Pink River PRB-11039',
  },
  [SKU.rung]: {
    vendor: GOLDBERG,
    desc: 'Ladder Rung',
    color: 'Cardinal International Orange 90 Gloss T009-OG26',
  },
  [SKU.pad]: { vendor: RESILITE, desc: 'Floor padding', color: 'Vinyl Charcoal' },
  [SKU.wrap]: { vendor: RESILITE, desc: 'Upright wrap', color: 'Vinyl Charcoal' },
  [SKU.palisades]: {
    vendor: RESILITE,
    desc: 'Palisades mat system',
    color: 'Top: Navy · Base: Orange',
  },
};

let db: PrismaClient;
let review: typeof import('../../src/portal/orderPortal.js');
let docs: typeof import('../../src/handoff/bomDocuments.js');
let check: typeof import('../../src/portal/colorCheck.js');
let areas: typeof import('../../src/portal/colorAreas.js');
let handoff: typeof import('../../src/handoff/service.js');
let po: typeof import('../../src/handoff/purchaseOrder.js');
let poDoc: typeof import('../../src/handoff/purchaseOrderDocument.js');

let userId = '';
let orgId = '';
let orderId = '';
let paletteId = '';
const createdBrandIds: string[] = [];
const mfrIds: string[] = [];

/** Put new customer answers on the portal item, as a monday refresh would. */
async function receive(answers: unknown): Promise<string> {
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
      sourceItemId: '12964352339',
    },
    update: { answers: answers as object, contentHash: hash },
  });
  return hash;
}

async function lineBySku(sku: string, hardware = false) {
  return db.procurementLine.findFirstOrThrow({
    where: { orderId, sku, isHardwareComponent: hardware },
  });
}

/** One printed row: part number, description and the Powder color cell. */
interface PrintedRow {
  part: string;
  desc: string;
  color: string | null;
}

/** Rows below the header row, from a table of cell text. */
function rowsFrom(table: string[][]): PrintedRow[] {
  const h = table.findIndex((r) => r.includes('Part #') && r.includes('Description'));
  if (h < 0) return [];
  const head = table[h]!;
  const p = head.indexOf('Part #');
  const d = head.indexOf('Description');
  const c = head.indexOf('Powder color');
  return table
    .slice(h + 1)
    .filter((r) => (r[p] ?? '').trim())
    .map((r) => ({
      part: (r[p] ?? '').trim().toUpperCase(),
      desc: (r[d] ?? '').trim(),
      color: c >= 0 ? (r[c] ?? '').trim() : null,
    }));
}

type Format = 'model' | 'xlsx' | 'csv';

/** Every row of one vendor's sheet, in the given format. */
async function sheet(format: Format, vendor: string): Promise<PrintedRow[]> {
  if (format === 'model') {
    const m = await docs.buildBomModel(orderId, vendor, {});
    return rowsFrom([
      m.columns,
      ...m.groups.flatMap((g) => g.rows.map((r) => r.map((x) => x.text))),
    ]);
  }
  if (format === 'xlsx') {
    const { buffer } = await docs.renderBomXlsx(orderId, vendor, {});
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const table: string[][] = [];
    wb.worksheets[0]!.eachRow((row) => {
      table.push((row.values as unknown[]).slice(1).map((v) => String(v ?? '')));
    });
    return rowsFrom(table);
  }
  const { csv } = await docs.renderBomCsv(orderId, vendor, {});
  const parse = (line: string) =>
    (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((cell) =>
      cell.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'),
    );
  return rowsFrom(csv.split(/\r?\n/).map(parse));
}

/**
 * The Powder color cell on the row for this part AND description. A part number
 * can print twice — the Vertical Post and a kit fastener sharing its number — so
 * the part number alone does not identify a row.
 */
async function printed(format: Format, vendor: string, sku: string, desc: string) {
  const rows = (await sheet(format, vendor)).filter(
    (r) => r.part === sku.toUpperCase() && r.desc === desc,
  );
  expect(rows.length, `${format} ${vendor} ${sku} "${desc}": exactly one row`).toBe(1);
  return rows[0]!.color;
}

beforeAll(async () => {
  ({ prisma: db } = await import('../../src/lib/prisma.js'));
  review = await import('../../src/portal/orderPortal.js');
  docs = await import('../../src/handoff/bomDocuments.js');
  check = await import('../../src/portal/colorCheck.js');
  areas = await import('../../src/portal/colorAreas.js');
  handoff = await import('../../src/handoff/service.js');
  po = await import('../../src/handoff/purchaseOrder.js');
  poDoc = await import('../../src/handoff/purchaseOrderDocument.js');

  const user = await db.user.create({
    data: { email: `${P.toLowerCase()}@example.com`, passwordHash: 'x', name: 'Colour Test' },
  });
  userId = user.id;
  const org = await db.organization.create({
    data: { name: `${P} Gym`, normalizedName: `${P.toLowerCase()} gym` },
  });
  orgId = org.id;

  // The managed powder brands are global and unique by name; reuse what a dev
  // database already has, and only remove what this run created.
  for (const name of ['Cardinal', 'Prismatic']) {
    const have = await db.powderColorBrand.findUnique({ where: { name } });
    if (!have) createdBrandIds.push((await db.powderColorBrand.create({ data: { name } })).id);
  }

  for (const name of [GOLDBERG, RESILITE, AMAZON]) {
    const m = await db.manufacturer.create({
      data: {
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        isSteelFabricator: name === GOLDBERG,
        poEnabled: name === GOLDBERG,
      },
    });
    mfrIds.push(m.id);
  }

  // The powder charts, kept as prisma/load-powder-charts.ts keeps them: palettes named
  // for the brand under the powder coater. Cardinal repeats "Blue 90 Gloss", so each
  // copy carries its code — the printed text must not show the code twice.
  const chart = (name: string, colors: Array<[string, string]>) =>
    db.vendorColorPalette.create({
      data: {
        manufacturerId: mfrIds[0]!,
        name,
        finishType: 'POWDER_COAT',
        colors: {
          create: colors.map(([n, code], i) => ({ name: n, vendorCode: code, sortOrder: i })),
        },
      },
    });
  await chart('Cardinal', [
    ['Blue 90 Gloss (T009-BL01)', 'T009-BL01'],
    ['Blue 90 Gloss (T009-BL05)', 'T009-BL05'],
    ['International Orange 90 Gloss', 'T009-OG26'],
  ]);
  await chart('Prismatic', [['Rosette Pink River', 'PRB-11039']]);

  // The vinyl chart and the multi-piece colour spec on the Palisades mat.
  const palette = await db.vendorColorPalette.create({
    data: {
      manufacturerId: mfrIds[1]!,
      name: `${P} Vinyl`,
      finishType: 'VINYL',
      colors: {
        create: ['Charcoal', 'Navy', 'Orange'].map((n, i) => ({
          name: n,
          vendorCode: n,
          sortOrder: i,
        })),
      },
    },
  });
  paletteId = palette.id;
  await db.productColorSpec.create({
    data: {
      paletteId,
      sku: SKU.palisades,
      slotCount: 2,
      slotLabels: ['Top', 'Base'],
    },
  });

  const proposal = await db.proposal.create({
    data: { number: `${P}-P`, organizationId: orgId, title: 'Colour test', createdById: userId },
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
      acceptedById: userId,
    },
  });
  orderId = order.id;

  const L = (sku: string, name: string, vendor: string, extra: object = {}) => ({
    orderId,
    sku,
    name,
    vendor,
    quantity: 1,
    unitCostMinor: 1000,
    ...extra,
  });
  await db.procurementLine.createMany({
    data: [
      L(SKU.leg, 'Vertical Post', GOLDBERG, { quantity: 3 }),
      L(SKU.ladderLeg, 'Vertical Post — Ladder Bay', GOLDBERG),
      L(SKU.beam, 'Horizontal Beam', GOLDBERG),
      L(SKU.rung, 'Ladder Rung', GOLDBERG),
      // An exploded kit fastener carrying a leg's part number: hardware is never
      // painted to the customer's colour.
      L(SKU.leg, 'Kit fastener', GOLDBERG, { isHardwareComponent: true, kitSku: 'H-1000' }),
      L(SKU.pad, 'Floor padding', RESILITE),
      L(SKU.wrap, 'Upright wrap', RESILITE),
      L(SKU.palisades, 'Palisades mat system', RESILITE),
      L(SKU.balls, 'Ball pit balls', AMAZON),
    ],
  });
  for (const m of MAPPING) {
    await db.portalColorAreaMapping.create({
      data: { areaKey: m.areaKey, sku: m.sku, piece: m.piece ?? null },
    });
  }
}, 60_000);

afterAll(async () => {
  if (!db) return;
  if (orderId) {
    await db.purchaseOrder.deleteMany({ where: { orderId } });
    await db.orderEvent.deleteMany({ where: { orderId } });
    await db.acceptedOrder.deleteMany({ where: { id: orderId } }); // cascades lines/items/sections
  }
  await db.portalColorAreaMapping.deleteMany({ where: { sku: { startsWith: P } } });
  await db.productColorSpec.deleteMany({ where: { sku: { startsWith: P } } });
  await db.vendorColorPalette.deleteMany({
    where: { OR: [{ id: paletteId }, { manufacturerId: { in: mfrIds } }] },
  });
  await db.priceSnapshot.deleteMany({ where: { createdById: userId } });
  await db.proposalVersion.deleteMany({ where: { createdById: userId } });
  await db.proposal.deleteMany({ where: { createdById: userId } });
  await db.manufacturer.deleteMany({ where: { id: { in: mfrIds } } });
  // Cardinal/Prismatic are shared reference rows (production has them from
  // migration 0029). Other suites running in parallel rely on them, so they
  // are left in place: deleting them here made those suites flake.
  await db.auditLog.deleteMany({ where: { actorId: userId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe('portal colour answers → the vendor Bill of Materials (real database)', () => {
  let hash = '';

  it('puts nothing on the BOM until staff review the answers', async () => {
    hash = await receive(ANSWERS);
    for (const sku of Object.keys(EXPECT)) {
      expect((await lineBySku(sku)).powderColor).toBeNull();
    }
    for (const f of ['model', 'xlsx', 'csv'] as const) {
      for (const r of await sheet(f, GOLDBERG)) expect(r.color ?? '', f).not.toMatch(/Cardinal/);
    }
  });

  it('review writes every pick onto the right part, with brand and code', async () => {
    const res = await review.reviewPortalItem(orderId, 'COLOR', userId, hash);
    expect(res.colors).toMatchObject({
      linesUpdated: Object.keys(EXPECT).length,
      unmappedAreas: [],
      noMatchingLines: [],
      skippedVendors: [],
      conflicts: [],
      offChart: [],
    });

    const cardinal = await db.powderColorBrand.findUniqueOrThrow({ where: { name: 'Cardinal' } });
    const prismatic = await db.powderColorBrand.findUniqueOrThrow({ where: { name: 'Prismatic' } });

    for (const [sku, want] of Object.entries(EXPECT)) {
      const l = await lineBySku(sku);
      expect(l.vendor, sku).toBe(want.vendor);
      expect(l.powderColor, sku).toBe(want.color);
    }
    // Frame paint keeps the structured brand + code, not just the printed text.
    expect(await lineBySku(SKU.leg)).toMatchObject({
      powderBrandId: cardinal.id,
      powderColorCode: 'T009-BL05',
    });
    expect(await lineBySku(SKU.beam)).toMatchObject({
      powderBrandId: prismatic.id,
      powderColorCode: 'PRB-11039',
    });
    // Vinyl is a material, not a powder brand: text only.
    expect(await lineBySku(SKU.pad)).toMatchObject({ powderBrandId: null, powderColorCode: null });
    // The multi-piece mat records each piece against the vendor's chart.
    const pal = await lineBySku(SKU.palisades);
    expect(pal.colorPicks).toMatchObject([
      { slot: 1, name: 'Navy', vendorCode: 'Navy' },
      { slot: 2, name: 'Orange', vendorCode: 'Orange' },
    ]);

    // Never painted: the hardware fastener sharing a leg's number, and a part no
    // area covers.
    expect((await lineBySku(SKU.leg, true)).powderColor).toBeNull();
    expect((await lineBySku(SKU.balls)).powderColor).toBeNull();

    // Both records of what happened exist.
    const events = await db.orderEvent.findMany({ where: { orderId } });
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['bom.colors.portal-review', 'portal.review']),
    );
  });

  it('prints each colour on its own part row, on its own vendor sheet — PDF, Excel and CSV', async () => {
    for (const [sku, want] of Object.entries(EXPECT)) {
      for (const f of ['model', 'xlsx', 'csv'] as const) {
        expect(await printed(f, want.vendor, sku, want.desc), `${f} ${sku}`).toBe(want.color);
      }
    }
    // The kit fastener sharing the leg's part number prints with no colour.
    for (const f of ['model', 'xlsx', 'csv'] as const) {
      expect(await printed(f, GOLDBERG, SKU.leg, 'Kit fastener'), f).toMatch(/^(—)?$/);
    }
    // The PDF is printed from this HTML.
    const { html } = await docs.renderBomHtml(orderId, GOLDBERG, {});
    for (const c of [
      'Cardinal Blue 90 Gloss T009-BL05',
      'Prismatic Rosette Pink River PRB-11039',
      'Cardinal International Orange 90 Gloss T009-OG26',
    ]) {
      expect(html).toContain(c);
    }
  });

  it('keeps each vendor’s colours off every other vendor’s sheet', async () => {
    const goldberg = (await docs.renderBomCsv(orderId, GOLDBERG, {})).csv;
    const resilite = (await docs.renderBomCsv(orderId, RESILITE, {})).csv;
    const amazon = (await docs.renderBomCsv(orderId, AMAZON, {})).csv;
    expect(goldberg).not.toMatch(/Vinyl|Top: Navy|Base: Orange/);
    expect(resilite).not.toMatch(/Cardinal|Prismatic/);
    expect(amazon).not.toMatch(/Cardinal|Prismatic|Vinyl|Navy|Orange/);
    // Hardware row on Goldberg's sheet: no colour beside the fastener.
    expect(goldberg).not.toMatch(/Kit fastener[^\n]*Cardinal/);
  });

  it('a colour set by hand prints exactly as a portal review prints it', async () => {
    // The shared formatter: the chart's name, a repeated name's bracketed code dropped,
    // and brand + code alone for a code the chart does not have.
    expect(await areas.powderColorText('Cardinal', 'T009-BL01')).toBe(
      'Cardinal Blue 90 Gloss T009-BL01',
    );
    expect(await areas.powderColorText('Cardinal', 't009-og26')).toBe(
      'Cardinal International Orange 90 Gloss t009-og26',
    );
    expect(await areas.powderColorText('Cardinal', 'NOT-ON-CHART')).toBe('Cardinal NOT-ON-CHART');

    // The BOM line editor (brand picked, code typed) writes the review's text.
    const cardinal = await db.powderColorBrand.findUniqueOrThrow({ where: { name: 'Cardinal' } });
    const rung = await lineBySku(SKU.rung);
    await handoff.patchProcurementLine(
      rung.id,
      { powderBrandId: cardinal.id, powderColorCode: 'T009-OG26' },
      userId,
    );
    expect((await lineBySku(SKU.rung)).powderColor).toBe(EXPECT[SKU.rung]!.color);
  });

  it('a Purchase Order carries each part’s colour and prints it', async () => {
    const leg = await lineBySku(SKU.leg);
    const beam = await lineBySku(SKU.beam);
    const created = await po.createPurchaseOrder(
      orderId,
      GOLDBERG,
      { lineIds: [leg.id, beam.id], freightMinor: 0, noFreightCharge: true },
      userId,
    );
    const lines = await db.purchaseOrderLine.findMany({
      where: { poId: created.id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(lines.map((l) => [l.sku, l.powderColor])).toEqual(
      expect.arrayContaining([
        [SKU.leg, EXPECT[SKU.leg]!.color],
        [SKU.beam, EXPECT[SKU.beam]!.color],
      ]),
    );
    const html = poDoc.renderPurchaseOrderDocument(await po.buildPurchaseOrderModel(created.id));
    expect(html).toContain('>Color<');
    for (const sku of [SKU.leg, SKU.beam]) {
      const row = html.slice(html.indexOf(sku));
      expect(row.slice(0, row.indexOf('</tr>')), sku).toContain(EXPECT[sku]!.color);
    }
    // The picker staff draft from shows the colour too.
    const source = await po.purchaseOrderSource(orderId, GOLDBERG);
    expect(source.lines.find((l) => l.id === leg.id)?.powderColor).toBe(EXPECT[SKU.leg]!.color);
  });

  it('the colour check agrees: every area traced to the printed sheet, no problems', async () => {
    const rep = await check.checkOrderColors(orderId);
    expect(rep.portal).toMatchObject({ found: true, reviewed: true });
    expect(rep.summary.problems).toBe(0);
    // One OK per (area, line): the Palisades mat is reached by two areas, one per piece.
    const pairs = rep.areas.flatMap((a) => a.lines.map((l) => `${a.areaKey} → ${l.sku}`)).sort();
    expect(pairs).toEqual(
      [
        `adventure_mat.adventure_mat_system → ${SKU.pad}`,
        `adventure_mat.adventure_mat_system → ${SKU.wrap}`,
        `palisades_mat.palisades_mat_1 → ${SKU.palisades}`,
        `palisades_mat.palisades_mat_2 → ${SKU.palisades}`,
        `structure_frame_paint.horizontal_beams → ${SKU.beam}`,
        `structure_frame_paint.ladder_rungs_and_leg → ${SKU.rung}`,
        `structure_frame_paint.legs → ${SKU.leg}`,
        `structure_frame_paint.legs → ${SKU.ladderLeg}`,
      ].sort(),
    );
    expect(rep.summary.ok).toBe(pairs.length);
  });

  it('a customer resubmission changes the BOM once it is reviewed again', async () => {
    const changed = structuredClone(ANSWERS);
    changed.selections.structure_frame_paint.legs = { brand: 'cardinal', code: 'T009-OG26' };
    const h2 = await receive(changed);
    // Not yet reviewed: still the first answer.
    expect((await lineBySku(SKU.leg)).powderColor).toBe('Cardinal Blue 90 Gloss T009-BL05');
    await review.reviewPortalItem(orderId, 'COLOR', userId, h2);
    expect((await lineBySku(SKU.leg)).powderColor).toBe(
      'Cardinal International Orange 90 Gloss T009-OG26',
    );
    expect((await lineBySku(SKU.ladderLeg)).powderColor).toBe(
      'Cardinal International Orange 90 Gloss T009-OG26',
    );
    for (const f of ['model', 'xlsx', 'csv'] as const) {
      expect(await printed(f, GOLDBERG, SKU.leg, 'Vertical Post'), f).toBe(
        'Cardinal International Orange 90 Gloss T009-OG26',
      );
    }
    // Untouched areas stay as they were.
    expect((await lineBySku(SKU.beam)).powderColor).toBe('Prismatic Rosette Pink River PRB-11039');
  });

  it('leaves a vendor alone once its BOM has been submitted, and says so', async () => {
    await db.bomVendorSection.create({
      data: { orderId, vendor: RESILITE, status: 'SUBMITTED' },
    });
    const changed = structuredClone(ANSWERS);
    changed.selections.structure_frame_paint.legs = { brand: 'cardinal', code: 'T009-OG26' };
    changed.selections.adventure_mat.adventure_mat_system = { brand: 'vinyl', code: 'Navy' };
    const h3 = await receive(changed);
    const res = await review.reviewPortalItem(orderId, 'COLOR', userId, h3);
    expect(res.colors?.skippedVendors).toEqual([RESILITE]);
    expect((await lineBySku(SKU.pad)).powderColor).toBe('Vinyl Charcoal');
  });
});
