import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Catalog → BOM setup and the two order-page actions that write back to it:
 * bulk vendor routing, rearranging one vendor's sheet (optionally for every future
 * order), "save this correction for future orders", and the Hardware check.
 *
 * Prisma is a plain in-memory stub, as in the repo's other route tests.
 */

type Row = Record<string, unknown>;
const SKUS = new Map<string, Row>();
const LINES = new Map<string, Row>();
const SECTIONS = new Map<string, Row>();
const PRODUCT_COSTS: Row[] = [];
const EVENTS: Row[] = [];
/** Product rows procurementFor() reads a part's primary sourcing from. */
let PRODUCTS: Array<{
  id: string;
  sku: string;
  sourcing: Array<{ manufacturer: { name: string } }>;
}> = [];

function reset() {
  PRODUCTS = [];
  SKUS.clear();
  LINES.clear();
  SECTIONS.clear();
  PRODUCT_COSTS.length = 0;
  EVENTS.length = 0;
  const sku = (part: string, extra: Row = {}) =>
    SKUS.set(part, {
      id: 'sku-' + part,
      part,
      description: part + ' desc',
      category: 'ACCESSORY',
      manufacturer: 'Amazon',
      unitCostMinor: 1000,
      active: true,
      freeIssueVendor: null,
      processingEnabled: false,
      secondaryVendor: null,
      secondaryVendorCostMinor: null,
      processingFeeBasis: 'PER_UNIT',
      processingSku: null,
      bomSortOrder: null,
      bomGroup: null,
      bomNote: null,
      ...extra,
    });
  sku('P-1');
  sku('P-2');
  sku('6820H-LAD', { manufacturer: 'Goldberg Brothers' });
  const line = (id: string, extra: Row) =>
    LINES.set(id, {
      id,
      orderId: 'o1',
      sku: null,
      vendor: 'Goldberg Brothers',
      vendorNotes: null,
      unitCostMinor: 500,
      bomGroup: null,
      bomPosition: null,
      secondaryOfSku: null,
      costPerOrder: false,
      ...extra,
    });
  line('l1', { sku: 'P-1' });
  line('l2', { sku: 'P-2' });
  line('l3', {
    sku: 'P-1',
    secondaryOfSku: 'P-1',
    unitCostMinor: 450,
    vendorNotes: 'Powder coat',
    costPerOrder: true,
  });
  line('l4', { sku: 'X-9', vendor: 'Amazon' });
  SECTIONS.set('o1::Goldberg Brothers', { status: 'DRAFT' });
}

const inParts = (where: { part?: { in?: string[] } }) => {
  const want = new Set((where.part?.in ?? []).map((p) => p.toUpperCase()));
  return [...SKUS.values()].filter((s) => want.has(String(s.part).toUpperCase()));
};

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
    sku: {
      findMany: async ({
        where,
      }: { where?: { part?: { in?: string[] }; id?: { in: string[] } } } = {}) =>
        where?.id
          ? [...SKUS.values()].filter((s) => where.id!.in.includes(String(s.id)))
          : where?.part
            ? inParts(where)
            : [...SKUS.values()],
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const s = [...SKUS.values()].find((x) => x.id === where.id)!;
        Object.assign(s, data);
        return { ...s };
      },
    },
    procurementLine: {
      findMany: async ({ where }: { where: { id?: { in: string[] }; orderId?: string } }) =>
        [...LINES.values()].filter(
          (l) => (!where.id || where.id.in.includes(String(l.id))) && l.orderId === where.orderId,
        ),
      findUnique: async ({ where }: { where: { id: string } }) => LINES.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        Object.assign(LINES.get(where.id)!, data);
        return LINES.get(where.id);
      },
    },
    bomVendorSection: {
      findUnique: async ({
        where,
      }: {
        where: { orderId_vendor: { orderId: string; vendor: string } };
      }) => SECTIONS.get(where.orderId_vendor.orderId + '::' + where.orderId_vendor.vendor) ?? null,
    },
    manufacturer: {
      findMany: async () => [
        { id: 'm1', name: 'Goldberg Brothers' },
        { id: 'm2', name: 'Amazon' },
      ],
    },
    hardwareRule: { findMany: async () => [] },
    product: {
      findUnique: async () => ({ id: 'prod-P-1' }),
      findMany: async ({ where }: { where: { sku: { in: string[] } } }) => {
        const want = new Set(where.sku.in.map((p) => p.toUpperCase()));
        return PRODUCTS.filter((p) => want.has(p.sku.toUpperCase()));
      },
    },
    productCost: {
      findMany: async () => [],
      create: async ({ data }: { data: Row }) => {
        PRODUCT_COSTS.push(data);
        return data;
      },
    },
    orderEvent: {
      create: async ({ data }: { data: Row }) => {
        EVENTS.push(data);
        return data;
      },
    },
    entityRevision: { create: async () => ({}) },
    auditLog: { create: async () => ({}) },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    // skusFor's fallback: parts matched on upper(btrim(part)).
    $queryRaw: async (_sql: TemplateStringsArray, _edge: string, want: string[]) =>
      [...SKUS.values()]
        .filter((s) => want.includes(String(s.part).trim().toUpperCase()))
        .map((s) => ({ id: s.id })),
  },
}));

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});
beforeEach(reset);

async function auth(role: string) {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return { authorization: 'Bearer ' + (await signAccessToken({ sub: 'user-' + role, role })) };
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerBomSetupRoutes } = await import('../../src/routes/bomSetup.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerBomSetupRoutes(app);
  await app.ready();
  return app;
}

describe('PATCH /bom-setup/parts — processing service supplier, in bulk', () => {
  it('sets several parts’ processing supplier, fee, basis and Repackaging SKU in one call', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-setup/parts',
      headers: await auth('OPERATIONS'),
      payload: {
        parts: ['P-1', 'p-2', 'NOPE'],
        set: {
          processingEnabled: true,
          secondaryVendor: 'goldberg brothers',
          secondaryVendorCostMinor: 0,
          processingFeeBasis: 'PER_ORDER',
          processingSku: '  GB-RPK  ',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(2);
    expect(res.json().skipped).toEqual([{ part: 'NOPE', reason: 'Not in the SKU master' }]);
    // Stored with the vendor's own spelling, not as typed; the Repackaging SKU trimmed.
    expect(SKUS.get('P-2')).toMatchObject({
      processingEnabled: true,
      secondaryVendor: 'Goldberg Brothers',
      secondaryVendorCostMinor: 0,
      processingFeeBasis: 'PER_ORDER',
      processingSku: 'GB-RPK',
    });
    await app.close();
  });

  it('skips a part whose processing supplier is the vendor it is already bought from', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-setup/parts',
      headers: await auth('OPERATIONS'),
      payload: {
        parts: ['6820H-LAD', 'P-1'],
        set: { processingEnabled: true, secondaryVendor: 'Goldberg Brothers' },
      },
    });
    expect(res.json().updated).toBe(1);
    expect(res.json().skipped[0]).toMatchObject({
      part: '6820H-LAD',
      reason: 'Already bought from Goldberg Brothers',
    });
    expect(SKUS.get('6820H-LAD')!.secondaryVendor).toBeNull();
    await app.close();
  });

  it('reads the procurement supplier off primary sourcing when the Sku has none', async () => {
    SKUS.get('P-1')!.manufacturer = null;
    PRODUCTS = [
      { id: 'prod-P-1', sku: 'P-1', sourcing: [{ manufacturer: { name: 'Goldberg Brothers' } }] },
    ];
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-setup/parts',
      headers: await auth('OPERATIONS'),
      payload: { parts: ['P-1'], set: { secondaryVendor: 'Goldberg Brothers' } },
    });
    expect(res.json().updated).toBe(0);
    expect(res.json().skipped[0].part).toBe('P-1');
    await app.close();
  });

  it('refuses a processing supplier that is not on record', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-setup/parts',
      headers: await auth('OPERATIONS'),
      payload: { parts: ['P-1'], set: { secondaryVendor: 'Goldberg Bros' } },
    });
    expect(res.statusCode).toBe(400);
    expect(SKUS.get('P-1')!.secondaryVendor).toBeNull();
    await app.close();
  });

  it('can only CLEAR a retired ships-through vendor, never set one', async () => {
    SKUS.get('P-1')!.freeIssueVendor = 'Goldberg Brothers';
    const app = await makeApp();
    const set = await app.inject({
      method: 'PATCH',
      url: '/bom-setup/parts',
      headers: await auth('OPERATIONS'),
      payload: { parts: ['P-2'], set: { freeIssueVendor: 'Goldberg Brothers' } },
    });
    expect(set.statusCode).toBe(400);
    expect(SKUS.get('P-2')!.freeIssueVendor).toBeNull();
    const clear = await app.inject({
      method: 'PATCH',
      url: '/bom-setup/parts',
      headers: await auth('OPERATIONS'),
      payload: { parts: ['P-1'], set: { freeIssueVendor: null } },
    });
    expect(clear.statusCode).toBe(200);
    expect(SKUS.get('P-1')!.freeIssueVendor).toBeNull();
    await app.close();
  });

  it('is closed to roles without BOM permission', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/bom-setup/parts',
      headers: await auth('SALES_REP'),
      payload: { parts: ['P-1'], set: { bomGroup: '' } },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('GET /bom-setup/parts — procurement supplier and proposal cost', () => {
  it('shows who it is bought from and what a new proposal line will cost', async () => {
    Object.assign(SKUS.get('P-1')!, {
      processingEnabled: true,
      secondaryVendor: 'Goldberg Brothers',
      secondaryVendorCostMinor: 150,
      processingFeeBasis: 'PER_UNIT',
    });
    Object.assign(SKUS.get('P-2')!, {
      manufacturer: null,
      processingEnabled: true,
      secondaryVendor: 'Goldberg Brothers',
      secondaryVendorCostMinor: 2500,
      processingFeeBasis: 'PER_ORDER',
      freeIssueVendor: 'Old Receiver',
    });
    PRODUCTS = [{ id: 'prod-P-2', sku: 'P-2', sourcing: [{ manufacturer: { name: 'Amazon' } }] }];
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/bom-setup/parts',
      headers: await auth('SALES_REP'),
    });
    expect(res.statusCode).toBe(200);
    const parts = res.json().parts as Array<Record<string, unknown>>;
    const p1 = parts.find((p) => p.part === 'P-1');
    const p2 = parts.find((p) => p.part === 'P-2');
    expect(p1).toMatchObject({
      procurementSupplier: 'Amazon',
      unitPurchaseCostMinor: 1000,
      proposalUnitCostMinor: 1150,
      proposalPerOrderFeeMinor: 0,
      legacyShipsThrough: null,
    });
    expect(p2).toMatchObject({
      procurementSupplier: 'Amazon',
      proposalUnitCostMinor: 1000,
      proposalPerOrderFeeMinor: 2500,
      legacyShipsThrough: 'Old Receiver',
    });
    // The retired field is no longer sent raw.
    expect(p2).not.toHaveProperty('freeIssueVendor');
    await app.close();
  });
});

describe('GET /bom-setup/export', () => {
  it('writes the processing columns the importer reads back', async () => {
    Object.assign(SKUS.get('P-1')!, {
      processingEnabled: true,
      secondaryVendor: 'Goldberg Brothers',
      secondaryVendorCostMinor: 1250,
      processingFeeBasis: 'PER_ORDER',
      processingSku: 'GB-RPK',
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/bom-setup/export',
      headers: await auth('SALES_REP'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { columns: string[]; items: Array<Record<string, unknown>> };
    expect(body.columns).toEqual([
      'part',
      'description',
      'procurementSupplier',
      'unitPurchaseCost',
      'bomSequence',
      'bomHeading',
      'bomNote',
      'prepaidItem',
      'orderFulfillmentSupplier',
      'repackagingSku',
      'repackagingFee',
      'repackagingFeeBasis',
    ]);
    expect(body.items.find((i) => i.part === 'P-1')).toMatchObject({
      procurementSupplier: 'Amazon',
      unitPurchaseCost: '10.00',
      prepaidItem: 'Yes',
      orderFulfillmentSupplier: 'Goldberg Brothers',
      repackagingSku: 'GB-RPK',
      repackagingFee: '12.50',
      repackagingFeeBasis: 'per order',
    });
    expect(body.items.find((i) => i.part === 'P-2')).toMatchObject({
      prepaidItem: 'No',
      orderFulfillmentSupplier: '',
      repackagingFee: '',
      repackagingFeeBasis: 'per unit',
    });
    await app.close();
  });

  it('exports the same sheet as an Excel workbook that imports straight back', async () => {
    Object.assign(SKUS.get('P-1')!, {
      processingEnabled: true,
      secondaryVendor: 'Goldberg Brothers',
      secondaryVendorCostMinor: 1250,
      processingFeeBasis: 'PER_ORDER',
      processingSku: 'GB-RPK',
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/bom-setup/export.xlsx',
      headers: await auth('SALES_REP'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(String(res.headers['content-disposition'])).toMatch(/bom-setup-.*\.xlsx/);
    const { rowsFromXlsx } = await import('../../src/routes/bomSetup.js');
    const rows = await rowsFromXlsx(res.rawPayload);
    expect(rows.find((r) => r.part === 'P-1')).toMatchObject({
      prepaidItem: 'Yes',
      orderFulfillmentSupplier: 'Goldberg Brothers',
      repackagingSku: 'GB-RPK',
      repackagingFee: '12.50',
      repackagingFeeBasis: 'per order',
    });

    // Untouched, it changes nothing; with one cell edited, exactly that one.
    const again = await app.inject({
      method: 'POST',
      url: '/bom-setup/import',
      headers: await auth('OPERATIONS'),
      payload: { xlsxBase64: res.rawPayload.toString('base64'), dryRun: true },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ changes: [], issues: [] });

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const feeCol = (ws.getRow(1).values as unknown[]).indexOf('repackagingFee');
    ws.eachRow((row, n) => {
      if (n > 1 && row.getCell(1).text === 'P-1') row.getCell(feeCol).value = '15.00';
    });
    const edited = Buffer.from(await wb.xlsx.writeBuffer());
    const write = await app.inject({
      method: 'POST',
      url: '/bom-setup/import',
      headers: await auth('OPERATIONS'),
      payload: { xlsxBase64: edited.toString('base64'), dryRun: false },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json().changes).toEqual([
      expect.objectContaining({ part: 'P-1', changed: ['secondaryVendorCostMinor'] }),
    ]);
    expect(SKUS.get('P-1')!.secondaryVendorCostMinor).toBe(1500);
    await app.close();
  });

  it('refuses a file that is not a workbook', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bom-setup/import',
      headers: await auth('OPERATIONS'),
      payload: { xlsxBase64: Buffer.from('part,bomNote').toString('base64'), dryRun: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not an Excel workbook/);
    await app.close();
  });
});

describe('a part number stored with a stray space', () => {
  it('is still found by the grid and by the sheet', async () => {
    SKUS.set('SP-1 ', {
      ...SKUS.get('P-2')!,
      id: 'sku-sp1',
      part: 'SP-1 ',
    });
    const app = await makeApp();
    const patch = await app.inject({
      method: 'PATCH',
      url: '/bom-setup/parts',
      headers: await auth('OPERATIONS'),
      payload: { parts: ['SP-1 '], set: { bomNote: 'Bag it' } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ updated: 1, skipped: [] });
    const imp = await app.inject({
      method: 'POST',
      url: '/bom-setup/import',
      headers: await auth('OPERATIONS'),
      payload: { rows: [{ part: 'sp-1', bomNote: 'Box it' }], dryRun: false },
    });
    expect(imp.json()).toMatchObject({ updated: 1, issues: [] });
    expect(SKUS.get('SP-1 ')!.bomNote).toBe('Box it');
    await app.close();
  });
});

describe('reading an Excel workbook', () => {
  it('takes a formula result, even 0, and plain dates and rich text', async () => {
    const { sheetCellText } = await import('../../src/routes/bomSetup.js');
    expect(sheetCellText({ formula: '1-1', result: 0 })).toBe('0');
    expect(sheetCellText({ formula: 'A1=B1', result: false })).toBe('false');
    expect(sheetCellText({ formula: 'X1' })).toBe('');
    expect(sheetCellText(4.5)).toBe('4.5');
    expect(sheetCellText(new Date(Date.UTC(2026, 9, 20)))).toBe('2026-10-20');
    expect(sheetCellText({ richText: [{ text: 'Gold' }, { text: 'berg' }] })).toBe('Goldberg');
    expect(sheetCellText(null)).toBe('');
  });

  it('reports a problem on its real row when the sheet has a blank row above it', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('BOM setup');
    ws.addRow(['part', 'bomNote']);
    ws.addRow(['P-1', 'a']);
    ws.addRow([]);
    ws.addRow(['NOPE', 'b']);
    const { rowsFromXlsx } = await import('../../src/routes/bomSetup.js');
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    expect((await rowsFromXlsx(buffer)).map((r) => r.__row)).toEqual([2, 4]);
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bom-setup/import',
      headers: await auth('OPERATIONS'),
      payload: { xlsxBase64: buffer.toString('base64'), dryRun: true },
    });
    expect(res.json().issues).toEqual([{ row: 4, part: 'NOPE', message: 'Not in the SKU master' }]);
    await app.close();
  });

  it('says why an oversized sheet is refused', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bom-setup/import',
      headers: await auth('OPERATIONS'),
      payload: { rows: Array.from({ length: 5001 }, () => ({ part: 'P-1' })), dryRun: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('The file has more than 5,000 rows.');
    await app.close();
  });
});

describe('POST /bom-setup/import — headings', () => {
  it('reads the headings the screen shows, in any case or spacing', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bom-setup/import',
      headers: await auth('OPERATIONS'),
      payload: {
        rows: [
          {
            'Part #': 'P-2',
            'Prepaid Item': 'Yes',
            'Order Fulfillment Service Supplier': 'Goldberg Brothers',
            'Repackaging Service Fee': '2.25',
          },
        ],
        dryRun: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().issues).toEqual([]);
    expect(SKUS.get('P-2')).toMatchObject({
      processingEnabled: true,
      secondaryVendor: 'Goldberg Brothers',
      secondaryVendorCostMinor: 225,
    });
    await app.close();
  });

  it('says so when no column is the part number', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bom-setup/import',
      headers: await auth('OPERATIONS'),
      payload: { rows: [{ item: 'P-2', bomNote: 'x' }], dryRun: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/needs a “part” column/);
    await app.close();
  });
});

describe('POST /bom-setup/import — processing columns', () => {
  const importRows = async (rows: Row[], dryRun: boolean) => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bom-setup/import',
      headers: await auth('OPERATIONS'),
      payload: { rows, dryRun },
    });
    await app.close();
    return res;
  };
  const newSheetRow: Row = {
    part: 'P-1',
    // Read-only columns: neither is written back.
    procurementSupplier: 'Somebody Else',
    unitPurchaseCost: '99.99',
    processing: 'Yes',
    processingSupplier: 'goldberg brothers',
    repackagingSku: 'GB-RPK',
    repackagingFee: '$1,250.00',
    repackagingFeeBasis: 'Per Order',
  };

  it('previews the new columns on a dry run and writes nothing', async () => {
    const res = await importRows([newSheetRow], true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dryRun: true, issues: [] });
    expect(res.json().changes).toEqual([
      {
        row: 2,
        part: 'P-1',
        changed: expect.arrayContaining([
          'processingEnabled',
          'secondaryVendor',
          'processingSku',
          'secondaryVendorCostMinor',
          'processingFeeBasis',
        ]),
      },
    ]);
    expect(SKUS.get('P-1')).toMatchObject({ processingEnabled: false, secondaryVendor: null });
  });

  it('writes the new columns for real, leaving the procurement supplier and cost alone', async () => {
    const res = await importRows([newSheetRow], false);
    expect(res.json()).toMatchObject({ dryRun: false, updated: 1, issues: [] });
    expect(SKUS.get('P-1')).toMatchObject({
      processingEnabled: true,
      secondaryVendor: 'Goldberg Brothers',
      processingSku: 'GB-RPK',
      secondaryVendorCostMinor: 125000,
      processingFeeBasis: 'PER_ORDER',
      manufacturer: 'Amazon',
      unitCostMinor: 1000,
    });
  });

  it('maps a legacy "also on vendor" sheet onto the processing fields', async () => {
    const legacy: Row[] = [
      { part: 'P-1', alsoOnVendor: 'Goldberg Brothers', alsoOnVendorCost: '4.50' },
      { part: 'P-2', shipsThroughVendor: 'Goldberg Brothers' },
      // A blank legacy ships-through clears nothing.
      { part: '6820H-LAD', shipsThroughVendor: '' },
    ];
    const dry = await importRows(legacy, true);
    expect(dry.json().issues).toEqual([]);
    expect(dry.json().changes.map((c: { part: string }) => c.part)).toEqual(['P-1', 'P-2']);
    expect(SKUS.get('P-1')!.secondaryVendor).toBeNull();

    const real = await importRows(legacy, false);
    expect(real.json()).toMatchObject({ updated: 2 });
    expect(SKUS.get('P-1')).toMatchObject({
      processingEnabled: true,
      secondaryVendor: 'Goldberg Brothers',
      secondaryVendorCostMinor: 450,
    });
    expect(SKUS.get('P-2')).toMatchObject({
      processingEnabled: true,
      secondaryVendor: 'Goldberg Brothers',
      secondaryVendorCostMinor: null,
    });
    expect(SKUS.get('6820H-LAD')).toMatchObject({
      processingEnabled: false,
      secondaryVendor: null,
    });
  });

  it('a new column in the same file wins over its legacy name', async () => {
    await importRows([{ part: 'P-1', alsoOnVendorCost: '4.50', repackagingFee: '7.00' }], false);
    expect(SKUS.get('P-1')!.secondaryVendorCostMinor).toBe(700);
  });

  it('reads a fee and a basis typed with spaces, hyphens or underscores', async () => {
    const res = await importRows(
      [
        { part: 'P-1', repackagingFee: '$1 250.00', repackagingFeeBasis: 'Per  Unit' },
        { part: 'P-2', repackagingFee: ' 3.5 ', repackagingFeeBasis: 'per-order' },
        { part: '6820H-LAD', repackagingFeeBasis: 'PER_ORDER' },
      ],
      false,
    );
    expect(res.json().issues).toEqual([]);
    expect(SKUS.get('P-1')).toMatchObject({
      secondaryVendorCostMinor: 125000,
      processingFeeBasis: 'PER_UNIT',
    });
    expect(SKUS.get('P-2')).toMatchObject({
      secondaryVendorCostMinor: 350,
      processingFeeBasis: 'PER_ORDER',
    });
    expect(SKUS.get('6820H-LAD')!.processingFeeBasis).toBe('PER_ORDER');
  });

  it('a legacy sheet with both "also on vendor" and "ships through" filled: also-on-vendor wins', async () => {
    const res = await importRows(
      [{ part: '6820H-LAD', alsoOnVendor: 'Amazon', shipsThroughVendor: 'Goldberg Brothers' }],
      false,
    );
    expect(res.json().issues).toEqual([]);
    expect(SKUS.get('6820H-LAD')).toMatchObject({
      processingEnabled: true,
      secondaryVendor: 'Amazon',
    });
  });

  /**
   * Was a bug: an old export wrote every column on every row, so a free-issue part's row reads
   * alsoOnVendor = "" and shipsThroughVendor = "Goldberg Brothers". The blank
   * alsoOnVendor is mapped to processingSupplier first, which then blocks the
   * shipsThroughVendor mapping (`has(r, now)`), so the part's processing supplier is
   * CLEARED instead of set — the free-issue part falls off the receiving vendor's sheet.
   */
  it('a legacy row with a blank "also on vendor" still takes its "ships through" vendor', async () => {
    const res = await importRows(
      [
        {
          part: 'P-2',
          alsoOnVendor: '',
          alsoOnVendorCost: '',
          shipsThroughVendor: 'Goldberg Brothers',
        },
      ],
      false,
    );
    expect(res.json().issues).toEqual([]);
    expect(SKUS.get('P-2')).toMatchObject({
      processingEnabled: true,
      secondaryVendor: 'Goldberg Brothers',
    });
  });

  it('reports bad rows and writes nothing for them', async () => {
    const res = await importRows(
      [
        { part: '6820H-LAD', processingSupplier: 'Goldberg Brothers' },
        { part: 'P-1', processing: 'Yes' },
        { part: 'P-2', processing: 'maybe', repackagingFeeBasis: 'weekly' },
        { part: 'NOPE', processing: 'Yes' },
      ],
      false,
    );
    const issues = res.json().issues as Array<{ part: string; message: string }>;
    expect(issues).toEqual(
      expect.arrayContaining([
        {
          row: 2,
          part: '6820H-LAD',
          message: 'orderFulfillmentSupplier is the procurement supplier it is already bought from',
        },
        {
          row: 3,
          part: 'P-1',
          message: 'prepaidItem is Yes but no orderFulfillmentSupplier is given',
        },
        { row: 4, part: 'P-2', message: 'prepaidItem must be Yes or No' },
        { row: 4, part: 'P-2', message: 'repackagingFeeBasis must be "per unit" or "per order"' },
        { row: 5, part: 'NOPE', message: 'Not in the SKU master' },
      ]),
    );
    expect(SKUS.get('6820H-LAD')!.secondaryVendor).toBeNull();
    expect(SKUS.get('P-1')!.processingEnabled).toBe(false);
  });
});

describe('POST /orders/:id/bom/arrange', () => {
  it('positions the lines for this order and, when asked, for every future order', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/orders/o1/bom/arrange',
      headers: await auth('PROJECT_MANAGER'),
      payload: {
        vendor: 'Goldberg Brothers',
        lineIds: ['l2', 'l1', 'l3'],
        headings: { l2: 'Crating' },
        saveForFuture: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(LINES.get('l2')).toMatchObject({ bomPosition: 10, bomGroup: 'Crating' });
    expect(LINES.get('l1')).toMatchObject({ bomPosition: 20, bomGroup: null });
    // The first time a part appears sets its preset; P-1's second (l3) line does not.
    expect(SKUS.get('P-2')).toMatchObject({ bomSortOrder: 10, bomGroup: 'Crating' });
    expect(SKUS.get('P-1')).toMatchObject({ bomSortOrder: 20, bomGroup: null });
    expect(res.json().catalogUpdated).toBe(2);
    await app.close();
  });

  it('leaves the catalog alone for "this order only"', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/orders/o1/bom/arrange',
      headers: await auth('OPERATIONS'),
      payload: { vendor: 'Goldberg Brothers', lineIds: ['l2', 'l1'], saveForFuture: false },
    });
    expect(LINES.get('l2')!.bomPosition).toBe(10);
    expect(SKUS.get('P-2')!.bomSortOrder).toBeNull();
    await app.close();
  });

  it('refuses a submitted sheet and a line from another vendor', async () => {
    const app = await makeApp();
    const foreign = await app.inject({
      method: 'POST',
      url: '/orders/o1/bom/arrange',
      headers: await auth('OPERATIONS'),
      payload: { vendor: 'Goldberg Brothers', lineIds: ['l1', 'l4'] },
    });
    expect(foreign.statusCode).toBe(400);
    SECTIONS.set('o1::Goldberg Brothers', { status: 'SUBMITTED' });
    const locked = await app.inject({
      method: 'POST',
      url: '/orders/o1/bom/arrange',
      headers: await auth('OPERATIONS'),
      payload: { vendor: 'Goldberg Brothers', lineIds: ['l1'] },
    });
    expect(locked.statusCode).toBe(400);
    expect(LINES.get('l1')!.bomPosition).toBeNull();
    await app.close();
  });
});

describe('POST /orders/procurement/:lineId/save-default', () => {
  it('saves a line’s note as the part’s standing BOM note', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/orders/procurement/l3/save-default',
      headers: await auth('OPERATIONS'),
      payload: { fields: ['vendorNotes'] },
    });
    expect(res.statusCode).toBe(200);
    expect(SKUS.get('P-1')!.bomNote).toBe('Powder coat');
    await app.close();
  });

  it('saves a processing line’s cost as the Repackaging Service Fee AND its basis, open to BOM users', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/orders/procurement/l3/save-default',
      headers: await auth('OPERATIONS'),
      payload: { fields: ['unitCost'] },
    });
    expect(res.statusCode).toBe(200);
    expect(SKUS.get('P-1')).toMatchObject({
      secondaryVendorCostMinor: 450,
      processingFeeBasis: 'PER_ORDER',
      unitCostMinor: 1000,
    });
    expect(res.json().saved).toEqual(['Goldberg Brothers’s Repackaging Service Fee']);

    LINES.get('l3')!.costPerOrder = false;
    await app.inject({
      method: 'POST',
      url: '/orders/procurement/l3/save-default',
      headers: await auth('OPERATIONS'),
      payload: { fields: ['unitCost'] },
    });
    expect(SKUS.get('P-1')!.processingFeeBasis).toBe('PER_UNIT');
    await app.close();
  });

  it('keeps the part’s own catalog cost to catalog admins, and writes the cost history', async () => {
    const app = await makeApp();
    const denied = await app.inject({
      method: 'POST',
      url: '/orders/procurement/l1/save-default',
      headers: await auth('OPERATIONS'),
      payload: { fields: ['unitCost'] },
    });
    expect(denied.statusCode).toBe(403);
    expect(SKUS.get('P-1')!.unitCostMinor).toBe(1000);

    const ok = await app.inject({
      method: 'POST',
      url: '/orders/procurement/l1/save-default',
      headers: await auth('SYSTEM_ADMIN'),
      payload: { fields: ['unitCost'] },
    });
    expect(ok.statusCode).toBe(200);
    expect(SKUS.get('P-1')!.unitCostMinor).toBe(500);
    expect(PRODUCT_COSTS[0]).toMatchObject({ productId: 'prod-P-1', unitCost: 500n });
    await app.close();
  });
});

describe('GET /bom-setup/hardware-check', () => {
  it('lists the H-1000 kit parts with their reason, and honours a part moved out', async () => {
    SKUS.get('6820H-LAD')!.bomGroup = '';
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/bom-setup/hardware-check',
      headers: await auth('SALES_REP'),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Array<Record<string, unknown>>;
    const handles = rows.find((r) => r.part === '6820H-LAD')!;
    expect(handles.reasons).toContain('In the H-1000 hardware kit formula');
    expect(handles).toMatchObject({ catalogHeading: '', printsUnderHardware: false });
    expect(rows.find((r) => r.part === '6820H-LA')).toMatchObject({ printsUnderHardware: true });
    await app.close();
  });
});
