import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { PrismaClient } from '@prisma/client';

/**
 * AUDIT — the OUTPUT end of the colour pipeline, against a REAL database.
 *
 * Once a procurement line carries a colour, does that colour reach every document a
 * vendor or the shop reads, on the right row, without being dropped or merged away?
 *
 *   - the BOM model, the PDF's HTML, the .xlsx and the .csv, per vendor and for the
 *     "All vendors" sheet, with every optional column switched on (Vendor, Vendor
 *     part #, Bag #) so a column-offset bug would show;
 *   - the same part number twice in two DIFFERENT colours (must stay two rows);
 *   - lines under the Hardware heading and a team-named heading;
 *   - the per-vendor "Powder color" opt-in, and the force-on when a line is coloured;
 *   - the Purchase Order: line snapshot, document, regeneration of a draft, a sent PO
 *     staying frozen;
 *   - the vendor email (the .xlsx actually attached to the outgoing request);
 *   - the colour check catching a deliberately corrupted line, sheet and answer.
 *
 * Tests named "BUG:" are `it.fails` — they assert the CORRECT behaviour and fail
 * today, so the suite stays green while the defect is on record. Each names the
 * source line at fault.
 *
 * Every row is created under a per-run prefix and removed in afterAll.
 */

// The email path needs a provider key at env-load time; fetch is stubbed below, so
// nothing leaves the machine.
process.env.RESEND_API_KEY ??= 'test-not-a-real-key';

const RUN = Date.now().toString(36).toUpperCase();
const P = `ZA${RUN}`;
const FAB = `${P} Fab`; // steel fabricator, receives POs, owns the powder charts
const MATS = `${P} Mats`;
const PLAIN = `${P} Plain`;
const CHK = `${P} Check`;
const G = `za${RUN.toLowerCase()}`; // portal group prefix for the colour-check areas

const SKU = {
  post: `${P}-POST`, // two lines, two colours
  beam: `${P}-BEAM`, // team heading "Slides", vendor part number
  plain: `${P}-PLAIN`, // no colour, packaging bag
  rail: `${P}-RAIL`, // a code the chart does not have
  mat: `${P}-MAT`,
  mat2: `${P}-MAT2`,
  widget: `${P}-WIDGET`,
  leg: `${P}-LEG`, // colour-check: frame paint via the portal
  pad: `${P}-PAD`, // colour-check: vinyl via the portal
};
const EYE = '6820H-LP';
const EYE_ZP = '6820H-LP-ZP';

const C = {
  blue05: 'Cardinal Blue 90 Gloss T009-BL05',
  blue01: 'Cardinal Blue 90 Gloss T009-BL01',
  orange: 'Cardinal International Orange 90 Gloss T009-OG26',
  pink: 'Prismatic Rosette Pink River PRB-11039',
  black: 'Prismatic Matte Black River PRB-4432',
  offChart: 'Cardinal NOT-ON-CHART',
  vinyl: 'Vinyl Charcoal',
};

let db: PrismaClient;
let docs: typeof import('../../src/handoff/bomDocuments.js');
let areas: typeof import('../../src/portal/colorAreas.js');
let handoff: typeof import('../../src/handoff/service.js');
let po: typeof import('../../src/handoff/purchaseOrder.js');
let poDoc: typeof import('../../src/handoff/purchaseOrderDocument.js');
let check: typeof import('../../src/portal/colorCheck.js');
let review: typeof import('../../src/portal/orderPortal.js');
let sections: typeof import('../../src/handoff/bomSections.js');
let send: typeof import('../../src/handoff/bomSend.js');

let userId = '';
let orgId = '';
let orderId = '';
let cardinalId = '';
let prismaticId = '';
const createdSkuParts: string[] = [];
const mfr: Record<string, string> = {};
const lineId: Record<string, string> = {};

/**
 * Private stand-ins for the managed "Cardinal" / "Prismatic" brands, each with the
 * real chart under a palette of the same name. The global rows named exactly
 * "Cardinal"/"Prismatic" are created AND deleted by portal-color-to-bom.test.ts while
 * it runs in parallel, so anything that writes a brand id (the line editor) or
 * resolves a portal brand (a review) uses these instead. `powderColorText('Cardinal',
 * …)` needs no brand row — only the palette — so the name-lookup tests still use the
 * real names.
 */
const BRAND_C = `${P} Cardinal`;
const BRAND_P = `${P} Prismatic`;
const cb = (text: string) => text.replace(/^Cardinal/, BRAND_C);
const pb = (text: string) => text.replace(/^Prismatic/, BRAND_P);
async function ensureBrands(): Promise<void> {
  cardinalId = (await db.powderColorBrand.create({ data: { name: BRAND_C } })).id;
  prismaticId = (await db.powderColorBrand.create({ data: { name: BRAND_P } })).id;
}

// ------------------------------------------------------------------ parsing

/** One printed BOM row: the heading it sits under and its cells by column name. */
interface PrintedRow {
  heading: string;
  cell: Record<string, string>;
}
interface PrintedSheet {
  columns: string[];
  rows: PrintedRow[];
}

/**
 * The line table out of any format's grid of cell text: header row = the one with
 * Part #, Description and Qty; a row with ONE non-empty cell is a heading; the
 * Total row ends it.
 */
function tableToSheet(table: string[][]): PrintedSheet {
  const h = table.findIndex(
    (r) => r.includes('Part #') && r.includes('Description') && r.includes('Qty'),
  );
  if (h < 0) throw new Error('no line table header found');
  const columns = [...table[h]!];
  while (columns.length && !columns[columns.length - 1]) columns.pop();
  const desc = columns.indexOf('Description');
  const rows: PrintedRow[] = [];
  let heading = '';
  for (const raw of table.slice(h + 1)) {
    const r = raw.map((x) => x.trim());
    const filled = r.filter(Boolean);
    if (!filled.length) continue;
    if (r[desc] === 'Total') break;
    if (filled.length === 1 && r[0]) {
      heading = r[0];
      continue;
    }
    const cell: Record<string, string> = {};
    columns.forEach((c, i) => (cell[c] = r[i] ?? ''));
    rows.push({ heading, cell });
  }
  return { columns, rows };
}

const decode = (s: string): string =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** The line table of the BOM's HTML (the document the PDF is printed from). */
function htmlTable(html: string): string[][] {
  const start = html.indexOf('<thead>');
  const end = html.indexOf('</tbody>', start);
  const chunk = html.slice(start, end);
  const head = [...chunk.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => decode(m[1] ?? ''));
  const body = chunk.slice(chunk.indexOf('<tbody>'));
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((tr) =>
    [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => decode(m[1] ?? '')),
  );
  return [head, ...rows];
}

/** RFC-4180-ish: quoted fields, doubled quotes, commas and newlines inside quotes. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        f += '"';
        i++;
      } else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(f);
      f = '';
    } else if (ch === '\n') {
      row.push(f);
      out.push(row);
      row = [];
      f = '';
    } else if (ch !== '\r') f += ch;
  }
  row.push(f);
  out.push(row);
  return out;
}

async function xlsxTable(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0]!;
  const table: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = [];
    for (let i = 1; i <= ws.columnCount; i++) cells.push(row.getCell(i).text ?? '');
    table.push(cells);
  });
  return table;
}

type Format = 'model' | 'html' | 'xlsx' | 'csv';
const FORMATS: Format[] = ['model', 'html', 'xlsx', 'csv'];

async function printedSheet(format: Format, vendor: string): Promise<PrintedSheet> {
  if (format === 'model') {
    const m = await docs.buildBomModel(orderId, vendor, {});
    return tableToSheet([
      m.columns,
      ...m.groups.flatMap((g) => [
        ...(g.title ? [[g.title]] : []),
        ...g.rows.map((r) => r.map((x) => x.text)),
      ]),
      m.totals.map((x) => x.text),
    ]);
  }
  if (format === 'html')
    return tableToSheet(htmlTable((await docs.renderBomHtml(orderId, vendor, {})).html));
  if (format === 'xlsx')
    return tableToSheet(await xlsxTable((await docs.renderBomXlsx(orderId, vendor, {})).buffer));
  return tableToSheet(parseCsv((await docs.renderBomCsv(orderId, vendor, {})).csv));
}

/** Compact "heading | part | qty | colour" signature of each row, for exact comparison. */
const sig = (r: PrintedRow, withVendor = false): string =>
  [
    ...(withVendor ? [r.cell['Vendor'] ?? ''] : []),
    r.heading,
    r.cell['Part #'] ?? '',
    r.cell['Qty'] ?? '',
    r.cell['Powder color'] ?? '<no column>',
  ].join(' | ');

/** What FAB's sheet must print (eye-bolt roll-up rows excluded — see its own test). */
const FAB_ROWS = [
  ` | ${SKU.post} | 2 | ${C.blue05}`,
  ` | ${SKU.post} | 3 | ${C.pink}`,
  ` | ${SKU.plain} | 1 | —`,
  ` | ${SKU.rail} | 1 | ${C.offChart}`,
  `Slides | ${SKU.beam} | 1 | ${C.orange}`,
  `Hardware | ${SKU.post} | 4 | —`, // kit fastener sharing the post's number: never painted
];
const notEye = (r: PrintedRow) => !(r.cell['Part #'] ?? '').startsWith('6820H');

// ------------------------------------------------------------------ fixture

beforeAll(async () => {
  ({ prisma: db } = await import('../../src/lib/prisma.js'));
  docs = await import('../../src/handoff/bomDocuments.js');
  areas = await import('../../src/portal/colorAreas.js');
  handoff = await import('../../src/handoff/service.js');
  po = await import('../../src/handoff/purchaseOrder.js');
  poDoc = await import('../../src/handoff/purchaseOrderDocument.js');
  check = await import('../../src/portal/colorCheck.js');
  review = await import('../../src/portal/orderPortal.js');
  sections = await import('../../src/handoff/bomSections.js');
  send = await import('../../src/handoff/bomSend.js');

  userId = (
    await db.user.create({
      data: { email: `${P.toLowerCase()}@example.com`, passwordHash: 'x', name: 'Audit Output' },
    })
  ).id;
  orgId = (
    await db.organization.create({
      data: { name: `${P} Gym`, normalizedName: `${P.toLowerCase()} gym` },
    })
  ).id;

  await ensureBrands();

  for (const name of [FAB, MATS, PLAIN, CHK]) {
    mfr[name] = (
      await db.manufacturer.create({
        data: {
          name,
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          isSteelFabricator: name === FAB,
          poEnabled: name === FAB,
          rfqAbbrev: name === FAB ? 'ZAF' : null,
        },
      })
    ).id;
  }

  // The REAL portal charts, stored exactly as prisma/load-powder-charts.ts stores them
  // (palettes named for the brand, under the powder coater).
  for (const [palette, file] of [
    ['Cardinal', 'cardinal.json'],
    ['Prismatic', 'prismatic.json'],
    [BRAND_C, 'cardinal.json'],
    [BRAND_P, 'prismatic.json'],
  ] as const) {
    const colors = JSON.parse(
      readFileSync(join(process.cwd(), 'prisma', 'data', 'powder-charts', file), 'utf8'),
    ) as Array<{ name: string; code: string }>;
    await db.vendorColorPalette.create({
      data: {
        manufacturerId: mfr[FAB]!,
        name: palette,
        finishType: 'POWDER_COAT',
        colors: {
          create: colors.map((c, i) => ({ name: c.name, vendorCode: c.code, sortOrder: i })),
        },
      },
    });
  }

  // Catalog rows so the vendor email's "unknown part number" blocker passes, and a
  // packaging bag so the Bag # column prints.
  for (const part of [...Object.values(SKU), EYE, EYE_ZP]) {
    if (await db.sku.findUnique({ where: { part } })) continue;
    await db.sku.create({
      data: { part, description: part, packagingBag: part === SKU.plain ? 'Bag 7' : null },
    });
    createdSkuParts.push(part);
  }
  await db.vendorPartNumber.create({
    data: { manufacturerId: mfr[FAB]!, ourPart: SKU.beam, vendorPart: 'V-BEAM-9' },
  });

  const proposal = await db.proposal.create({
    data: { number: `${P}-P`, organizationId: orgId, title: 'Audit', createdById: userId },
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
  orderId = (
    await db.acceptedOrder.create({
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
        locked: true,
        mondayProjectId: P,
      },
    })
  ).id;

  let order = 0;
  const add = async (
    key: string,
    sku: string,
    name: string,
    vendor: string,
    extra: Record<string, unknown> = {},
  ) => {
    const l = await db.procurementLine.create({
      data: {
        orderId,
        sku,
        name,
        vendor,
        quantity: 1,
        unitCostMinor: 1000,
        unitWeightLbs: 2,
        proposalLineOrder: order++,
        ...extra,
      },
    });
    lineId[key] = l.id;
  };
  const paint = (brandId: string, code: string, text: string) => ({
    powderBrandId: brandId,
    powderColorCode: code,
    powderColor: text,
  });
  await add('postBlue', SKU.post, 'Upright Post', FAB, {
    quantity: 2,
    ...paint(cardinalId, 'T009-BL05', C.blue05),
  });
  await add('postPink', SKU.post, 'Upright Post', FAB, {
    quantity: 3,
    ...paint(prismaticId, 'PRB-11039', C.pink),
  });
  await add('plain', SKU.plain, 'Unpainted bracket', FAB);
  await add('rail', SKU.rail, 'Rail', FAB, { ...paint(cardinalId, 'NOT-ON-CHART', C.offChart) });
  await add('beam', SKU.beam, 'Slide beam', FAB, {
    bomGroup: 'Slides',
    ...paint(cardinalId, 'T009-OG26', C.orange),
  });
  await add('fastener', SKU.post, 'Kit fastener', FAB, {
    quantity: 4,
    isHardwareComponent: true,
    kitSku: 'H-1000',
  });
  await add('eye', EYE, 'Eye bolt', FAB, { ...paint(cardinalId, 'T009-BL05', C.blue05) });
  await add('eyeZp', EYE_ZP, 'Zip line eye bolt', FAB, {
    ...paint(prismaticId, 'PRB-4432', C.black),
  });
  await add('mat', SKU.mat, 'Floor mat', MATS, { powderColor: C.vinyl });
  await add('mat2', SKU.mat2, 'Wall mat', MATS);
  await add('widget', SKU.widget, 'Widget', PLAIN);
  await add('leg', SKU.leg, 'Leg', CHK);
  await add('pad', SKU.pad, 'Pad', CHK);

  await db.bomVendorSection.createMany({
    data: [
      { orderId, vendor: FAB, showPowderColor: false, showPackagingBag: true },
      { orderId, vendor: MATS, showPowderColor: false },
      { orderId, vendor: PLAIN, showPowderColor: false },
    ],
  });

  await db.portalColorAreaMapping.createMany({
    data: [
      { areaKey: `${G}_frame.legs`, sku: SKU.leg },
      { areaKey: `${G}_mat.pad`, sku: SKU.pad },
    ],
  });
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  if (!db) return;
  if (orderId) {
    await db.purchaseOrder.deleteMany({ where: { orderId } });
    await db.orderEvent.deleteMany({ where: { orderId } });
    await db.acceptedOrder.deleteMany({ where: { id: orderId } });
  }
  await db.portalColorAreaMapping.deleteMany({ where: { sku: { startsWith: P } } });
  await db.vendorColorPalette.deleteMany({ where: { manufacturerId: { in: Object.values(mfr) } } });
  await db.priceSnapshot.deleteMany({ where: { createdById: userId } });
  await db.proposalVersion.deleteMany({ where: { createdById: userId } });
  await db.proposal.deleteMany({ where: { createdById: userId } });
  await db.manufacturer.deleteMany({ where: { id: { in: Object.values(mfr) } } });
  await db.sku.deleteMany({ where: { part: { in: createdSkuParts } } });
  await db.powderColorBrand.deleteMany({ where: { name: { in: [BRAND_C, BRAND_P] } } });
  await db.auditLog.deleteMany({ where: { actorId: userId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

// ------------------------------------------------------------------ tests

describe('BOM output — every format prints the right colour on the right row', () => {
  it.each(FORMATS)(
    '%s: FAB sheet — two colours of one part stay two rows; headings, unknown code, blanks',
    async (format) => {
      const s = await printedSheet(format, FAB);
      // Every optional column on, so a column offset would move the colour.
      expect(s.columns).toEqual([
        'Part #',
        'Vendor part #',
        'Description',
        'Qty',
        'Bag #',
        'Powder color',
        'Weight (lb)',
        'Cost Each',
        'Total Cost',
      ]);
      expect(s.rows.filter(notEye).map((r) => sig(r))).toEqual(FAB_ROWS);
      // The colour cell sits beside the right neighbours on the beam's row.
      const beam = s.rows.find((r) => r.cell['Part #'] === SKU.beam)!;
      expect(beam.cell['Vendor part #']).toBe('V-BEAM-9');
      expect(beam.cell['Description']).toBe('Slide beam');
      const plain = s.rows.find((r) => r.cell['Part #'] === SKU.plain)!;
      expect(plain.cell['Bag #']).toBe('Bag 7');
    },
  );

  it.each(FORMATS)('%s: "All vendors" sheet keeps each colour with its vendor', async (format) => {
    const s = await printedSheet(format, '*');
    expect(s.columns.slice(0, 2)).toEqual(['Vendor', 'Part #']);
    const got = s.rows.filter(notEye).map((r) => sig(r, true));
    for (const want of [
      `${FAB} | ` + FAB_ROWS[0],
      `${FAB} | ` + FAB_ROWS[1],
      `${FAB} | Slides | ${SKU.beam} | 1 | ${C.orange}`,
      `${MATS} |  | ${SKU.mat} | 1 | ${C.vinyl}`,
      `${MATS} |  | ${SKU.mat2} | 1 | —`,
      `${PLAIN} |  | ${SKU.widget} | 1 | —`,
    ]) {
      expect(got, want).toContain(want);
    }
  });

  it.each(FORMATS)(
    '%s: a vendor that opted out of the column still gets it once a line has a colour',
    async (format) => {
      const s = await printedSheet(format, MATS);
      expect(s.columns).toContain('Powder color');
      expect(s.rows.map((r) => sig(r))).toEqual([
        ` | ${SKU.mat} | 1 | ${C.vinyl}`,
        ` | ${SKU.mat2} | 1 | —`,
      ]);
    },
  );

  it('the opt-in column: absent with no colours, a column of dashes when switched on', async () => {
    for (const f of FORMATS) {
      expect((await printedSheet(f, PLAIN)).columns, f).not.toContain('Powder color');
    }
    await db.bomVendorSection.update({
      where: { orderId_vendor: { orderId, vendor: PLAIN } },
      data: { showPowderColor: true },
    });
    for (const f of FORMATS) {
      const s = await printedSheet(f, PLAIN);
      expect(
        s.rows.map((r) => sig(r)),
        f,
      ).toEqual([` | ${SKU.widget} | 1 | —`]);
    }
  });

  it('the vendor email attaches an .xlsx whose rows carry the same colours', async () => {
    // Runs against a throwaway vendor so FAB stays unsubmitted for the PO tests.
    const captured: Array<{ attachments: Array<{ filename: string; content: string }> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        captured.push(JSON.parse(String(init?.body ?? '{}')) as (typeof captured)[number]);
        return new Response(JSON.stringify({ id: 'resend-test' }), { status: 200 });
      }),
    );
    const section = await db.bomVendorSection.findUniqueOrThrow({
      where: { orderId_vendor: { orderId, vendor: MATS } },
    });
    const res = await send.sendBom(
      section.id,
      { to: 'vendor@example.com', subject: 'BOM', body: 'Attached', format: 'EXCEL' },
      userId,
    );
    vi.unstubAllGlobals();
    expect(res.status).toBe('SENT');
    const att = captured[0]?.attachments ?? [];
    expect(att.map((a) => a.filename.split('.').pop())).toEqual(['xlsx']);
    const s = tableToSheet(await xlsxTable(Buffer.from(att[0]!.content, 'base64')));
    expect(s.rows.map((r) => sig(r))).toEqual([
      ` | ${SKU.mat} | 1 | ${C.vinyl}`,
      ` | ${SKU.mat2} | 1 | —`,
    ]);
  });

  it('FIXED: an eye-bolt roll-up drops the second colour (bomRollup.ts groupKey ignores colour)', async () => {
    // 6820H-LP (Cardinal blue) and 6820H-LP-ZP (Prismatic black) merge into ONE
    // 6820H-LP row that prints only the first colour. Correct: both colours appear.
    for (const f of FORMATS) {
      const cells = (await printedSheet(f, FAB)).rows
        .filter((r) => (r.cell['Part #'] ?? '').startsWith('6820H'))
        .map((r) => r.cell['Powder color'] ?? '')
        .join(' / ');
      expect(cells, f).toContain(C.blue05);
      expect(cells, f).toContain(C.black);
    }
  });
});

describe('colour code → printed name', () => {
  it('every Cardinal and Prismatic chart code prints "<Brand> <name> <code>", code once', async () => {
    const chart = await areas.loadPowderChart();
    for (const [brand, file] of [
      ['Cardinal', 'cardinal.json'],
      ['Prismatic', 'prismatic.json'],
    ] as const) {
      const colors = JSON.parse(
        readFileSync(join(process.cwd(), 'prisma', 'data', 'powder-charts', file), 'utf8'),
      ) as Array<{ name: string; code: string }>;
      for (const c of colors) {
        const bare = c.name.replace(/\s*\(([^()]*)\)$/, '');
        const want = `${brand} ${bare} ${c.code}`;
        const got = areas.lineColorFor({ brand, code: c.code }, [{ id: 'b', name: brand }], chart);
        expect(got.powderColor, `${brand} ${c.code}`).toBe(want);
        expect(got.powderColor!.split(c.code).length - 1, `${c.code} printed once`).toBe(1);
      }
    }
    // The single-code DB path agrees on a sample from each chart.
    expect(await areas.powderColorText('Cardinal', 'T009-BL05')).toBe(C.blue05);
    expect(await areas.powderColorText('Prismatic', 'PRB-11039')).toBe(C.pink);
  });

  it('unknown code, blank code, whitespace, case, other brands', async () => {
    // Unknown code: the code still prints — never blank.
    expect(await areas.powderColorText('Cardinal', 'NOT-ON-CHART')).toBe(C.offChart);
    // Whitespace is trimmed; the name is still found.
    expect(await areas.powderColorText('  Cardinal ', '  T009-BL05  ')).toBe(C.blue05);
    // Code case: the name is found case-insensitively; the code prints AS TYPED.
    expect(await areas.powderColorText('Cardinal', 't009-bl05')).toBe(
      'Cardinal Blue 90 Gloss t009-bl05',
    );
    // A Cardinal code under the Prismatic brand does not borrow Cardinal's name.
    expect(await areas.powderColorText('Prismatic', 'T009-BL05')).toBe('Prismatic T009-BL05');
    // A brand with no chart: brand + code.
    expect(await areas.powderColorText('Tiger Drylac', 'RAL 5015')).toBe('Tiger Drylac RAL 5015');
    // Brand only / code only / neither.
    expect(await areas.powderColorText('Cardinal', '')).toBe('Cardinal');
    expect(await areas.powderColorText('', 'T009-BL05')).toBe('T009-BL05');
    expect(await areas.powderColorText(null, null)).toBeNull();
  });

  it('the line editor (brand + code) writes text that then prints on every format', async () => {
    await handoff.patchProcurementLine(
      lineId['rail']!,
      { powderBrandId: prismaticId, powderColorCode: ' PRB-4432 ' },
      userId,
    );
    const l = await db.procurementLine.findUniqueOrThrow({ where: { id: lineId['rail']! } });
    expect(l).toMatchObject({ powderColorCode: 'PRB-4432', powderColor: pb(C.black) });
    for (const f of FORMATS) {
      const r = (await printedSheet(f, FAB)).rows.find((x) => x.cell['Part #'] === SKU.rail)!;
      expect(r.cell['Powder color'], f).toBe(pb(C.black));
    }
    // Put it back for the tests below.
    await db.procurementLine.update({
      where: { id: lineId['rail']! },
      data: { powderBrandId: cardinalId, powderColorCode: 'NOT-ON-CHART', powderColor: C.offChart },
    });
  });

  it('FIXED: a line with a colour CODE but no printed text passes submission yet prints "—" (bomDocuments.ts:258,313 read powderColor only; bomSections.ts:959 accepts powderColorCode)', async () => {
    // Reachable through the real API: brand + code set, then the text cleared
    // (PATCH {powderColor: null}, service.ts:1407).
    await db.sku.update({ where: { part: SKU.widget }, data: { requiresPowderColor: true } });
    await handoff.patchProcurementLine(
      lineId['widget']!,
      { powderBrandId: cardinalId, powderColorCode: 'T009-BL05' },
      userId,
    );
    await handoff.patchProcurementLine(lineId['widget']!, { powderColor: null }, userId);
    const section = await db.bomVendorSection.findUniqueOrThrow({
      where: { orderId_vendor: { orderId, vendor: PLAIN } },
    });
    const blockers = await sections.submissionBlockers(section.id);
    const printed = (await printedSheet('model', PLAIN)).rows[0]?.cell['Powder color'];
    try {
      // Correct behaviour: either the sheet prints the code, or sending is blocked.
      expect(
        (printed ?? '').includes('T009-BL05') ||
          blockers.some((b) => b.includes('needs a powder colour')),
      ).toBe(true);
    } finally {
      await db.sku.update({ where: { part: SKU.widget }, data: { requiresPowderColor: false } });
      await db.procurementLine.update({
        where: { id: lineId['widget']! },
        data: { powderBrandId: null, powderColorCode: null, powderColor: null },
      });
    }
  });
});

describe('Purchase orders carry the colour', () => {
  let draftId = '';

  /** (sku, qty, colour) per printed PO row. */
  function poRows(html: string): string[] {
    const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
    const head = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => decode(m[1] ?? ''));
    const ci = head.indexOf('Color');
    const qi = head.indexOf('Qty');
    return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((tr) => {
      const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
        decode(m[1] ?? ''),
      );
      return `${(cells[0] ?? '').split(' ')[0]} | ${cells[qi] ?? ''} | ${ci >= 0 ? (cells[ci] ?? '') : '<no column>'}`;
    });
  }

  it('snapshots each line’s colour — two colours of one part stay two PO lines', async () => {
    const created = await po.createPurchaseOrder(
      orderId,
      FAB,
      {
        lineIds: [lineId['postBlue']!, lineId['postPink']!, lineId['beam']!, lineId['plain']!],
        freightMinor: 0,
        noFreightCharge: true,
      },
      userId,
    );
    draftId = created.id;
    const lines = await db.purchaseOrderLine.findMany({
      where: { poId: created.id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(lines.map((l) => `${l.sku} | ${l.quantity} | ${l.powderColor}`)).toEqual([
      `${SKU.post} | 2 | ${C.blue05}`,
      `${SKU.post} | 3 | ${C.pink}`,
      `${SKU.plain} | 1 | null`,
      `${SKU.beam} | 1 | ${C.orange}`,
    ]);
    const html = poDoc.renderPurchaseOrderDocument(await po.buildPurchaseOrderModel(created.id));
    expect(poRows(html)).toEqual([
      `${SKU.post} | 2 | ${C.blue05}`,
      `${SKU.post} | 3 | ${C.pink}`,
      `${SKU.plain} | 1 | —`,
      `${SKU.beam} | 1 | ${C.orange}`,
    ]);
  });

  it('regenerating a draft picks up a colour changed on the BOM since', async () => {
    await handoff.patchProcurementLine(
      lineId['beam']!,
      { powderBrandId: cardinalId, powderColorCode: 'T009-BL01' },
      userId,
    );
    const m = await po.updatePurchaseOrder(draftId, {
      lineIds: [lineId['beam']!],
      freightMinor: 0,
      noFreightCharge: true,
    });
    expect(m.lines.map((l) => l.powderColor)).toEqual([cb(C.blue01)]);
    expect(poRows(poDoc.renderPurchaseOrderDocument(m))).toEqual([
      `${SKU.beam} | 1 | ${cb(C.blue01)}`,
    ]);
  });

  it('a SENT PO keeps the colour the vendor was sent, and cannot be regenerated', async () => {
    await db.purchaseOrder.update({
      where: { id: draftId },
      data: { status: 'SENT', sentAt: new Date(), sentById: userId },
    });
    await handoff.patchProcurementLine(
      lineId['beam']!,
      { powderBrandId: cardinalId, powderColorCode: 'T009-OG26' },
      userId,
    );
    const m = await po.buildPurchaseOrderModel(draftId);
    expect(m.lines.map((l) => l.powderColor)).toEqual([cb(C.blue01)]);
    await expect(
      po.updatePurchaseOrder(draftId, {
        lineIds: [lineId['beam']!],
        freightMinor: 0,
        noFreightCharge: true,
      }),
    ).rejects.toThrow(/has been sent/);
  });

  it('the PO picker shows each line’s own colour', async () => {
    const src = await po.purchaseOrderSource(orderId, FAB);
    const byId = new Map(src.lines.map((l) => [l.id, l]));
    expect(byId.get(lineId['postBlue']!)?.powderColor).toBe(C.blue05);
    expect(byId.get(lineId['postPink']!)?.powderColor).toBe(C.pink);
    expect(byId.get(lineId['fastener']!)?.powderColor).toBe('');
  });

  it('FIXED: ordering one colour of a part marks the OTHER colour "already on a PO" (purchaseOrder.ts:131-133 keys onSent by SKU only)', async () => {
    await po
      .createPurchaseOrder(
        orderId,
        FAB,
        { lineIds: [lineId['postBlue']!], freightMinor: 0, noFreightCharge: true },
        userId,
      )
      .then((p) =>
        db.purchaseOrder.update({
          where: { id: p.id },
          data: { status: 'SENT', sentAt: new Date() },
        }),
      );
    const src = await po.purchaseOrderSource(orderId, FAB);
    const pink = src.lines.find((l) => l.id === lineId['postPink']);
    // Only the Cardinal-blue posts went out; the Prismatic-pink posts have NOT been ordered.
    expect(pink?.onPurchaseOrder).toBeNull();
  });
});

describe('the colour check can fail — deliberate corruption is caught', () => {
  const LEGS = `${G}_frame.legs`;
  const PAD = `${G}_mat.pad`;
  const answers = (legCode: string) => ({
    selections: {
      [`${G}_frame`]: { legs: { brand: BRAND_C.toLowerCase(), code: legCode } },
      [`${G}_mat`]: { pad: { brand: 'vinyl', code: 'Navy' } },
    },
  });
  async function receive(a: unknown): Promise<string> {
    const hash = review.contentHashOf('PROVIDED', a);
    await db.orderPortalItem.upsert({
      where: { orderId_kind: { orderId, kind: 'COLOR' } },
      create: {
        orderId,
        kind: 'COLOR',
        state: 'PROVIDED',
        answers: a as object,
        contentHash: hash,
        obtainedAt: new Date(),
      },
      update: { answers: a as object, contentHash: hash },
    });
    return hash;
  }
  const lineOf = (rep: Awaited<ReturnType<typeof check.checkOrderColors>>, area: string) =>
    rep.areas.find((a) => a.areaKey === area)?.lines[0];

  it('baseline after review: both areas OK', async () => {
    await review.reviewPortalItem(orderId, 'COLOR', userId, await receive(answers('T009-BL05')));
    const rep = await check.checkOrderColors(orderId);
    expect(rep.portal.reviewed).toBe(true);
    expect(lineOf(rep, LEGS)).toMatchObject({ sku: SKU.leg, status: 'OK', onBom: cb(C.blue05) });
    expect(lineOf(rep, PAD)).toMatchObject({ sku: SKU.pad, status: 'OK', onBom: 'Vinyl Navy' });
    expect(rep.summary.problems).toBe(0);
  });

  it('a wrong colour on the line is a MISMATCH', async () => {
    await db.procurementLine.update({
      where: { id: lineId['leg']! },
      data: { powderColor: C.orange },
    });
    const rep = await check.checkOrderColors(orderId);
    expect(lineOf(rep, LEGS)).toMatchObject({
      status: 'MISMATCH',
      expected: cb(C.blue05),
      onLine: C.orange,
      onBom: C.orange,
    });
    expect(rep.summary.problems).toBeGreaterThan(0);
  });

  it('a missing colour is a MISMATCH', async () => {
    await db.procurementLine.update({ where: { id: lineId['leg']! }, data: { powderColor: null } });
    const rep = await check.checkOrderColors(orderId);
    expect(lineOf(rep, LEGS)).toMatchObject({ status: 'MISMATCH', onLine: null });
    await db.procurementLine.update({
      where: { id: lineId['leg']! },
      data: { powderColor: cb(C.blue05) },
    });
    expect((await check.checkOrderColors(orderId)).summary.problems).toBe(0);
  });

  it('a printed sheet that disagrees with a correct line is NOT_ON_BOM', async () => {
    const input = await areas.loadColorPlanInput(orderId, areas.colorAreasOf(answers('T009-BL05')));
    const source = { boardId: 'b', itemId: null, columnId: 'c' };
    const run = (mutate: (m: Awaited<ReturnType<typeof docs.buildBomModel>>) => void) =>
      docs.buildBomModel(orderId, CHK, {}).then((m) => {
        mutate(m);
        const bom = new Map([[CHK, check.bomColorCells(m)]]);
        return check.buildColorCheck({ ...input, bom, source });
      });
    const ci = (m: { columns: string[] }) => m.columns.indexOf('Powder color');
    const legRow = (m: Awaited<ReturnType<typeof docs.buildBomModel>>) =>
      m.groups.flatMap((g) => g.rows).find((r) => r[0]?.text === SKU.leg)!;

    // Untouched model: OK.
    expect((await run(() => {})).areas.find((a) => a.areaKey === LEGS)?.lines[0]?.status).toBe(
      'OK',
    );
    // Wrong text in the leg's colour cell.
    let out = await run((m) => (legRow(m)[ci(m)]!.text = C.orange));
    expect(out.areas.find((a) => a.areaKey === LEGS)?.lines[0]).toMatchObject({
      status: 'NOT_ON_BOM',
      onBom: C.orange,
    });
    // Leg's cell blanked to a dash.
    out = await run((m) => (legRow(m)[ci(m)]!.text = '—'));
    expect(out.areas.find((a) => a.areaKey === LEGS)?.lines[0]?.status).toBe('NOT_ON_BOM');
    // Leg's row dropped from the sheet.
    out = await run((m) => {
      for (const g of m.groups) g.rows = g.rows.filter((r) => r[0]?.text !== SKU.leg);
    });
    expect(out.areas.find((a) => a.areaKey === LEGS)?.lines[0]).toMatchObject({
      status: 'NOT_ON_BOM',
      onBom: null,
    });
    // The Powder color column dropped entirely.
    out = await run((m) => {
      const i = ci(m);
      m.columns.splice(i, 1);
      for (const g of m.groups) for (const r of g.rows) r.splice(i, 1);
    });
    expect(out.areas.find((a) => a.areaKey === LEGS)?.lines[0]).toMatchObject({
      status: 'NOT_ON_BOM',
      columnShown: false,
    });
    // Colours swapped between the leg and the pad rows.
    out = await run((m) => {
      const pad = m.groups.flatMap((g) => g.rows).find((r) => r[0]?.text === SKU.pad)!;
      const leg = legRow(m);
      const i = ci(m);
      const t = leg[i]!.text;
      leg[i]!.text = pad[i]!.text;
      pad[i]!.text = t;
    });
    expect(out.summary.problems).toBe(2);
  });

  it('a new answer not yet reviewed is reported unreviewed AND as a mismatch', async () => {
    await receive(answers('T009-OG26'));
    const rep = await check.checkOrderColors(orderId);
    expect(rep.portal.reviewed).toBe(false);
    expect(lineOf(rep, LEGS)).toMatchObject({
      status: 'MISMATCH',
      expected: cb(C.orange),
      onLine: cb(C.blue05),
    });
    expect(lineOf(rep, PAD)?.status).toBe('OK');
  });
});
