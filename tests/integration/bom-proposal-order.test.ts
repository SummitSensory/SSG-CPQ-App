import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';

/**
 * The Bill of Materials has to print in the same order as the proposal it came
 * from — not product-tree order, not hardware-last, not alphabetical by SKU (see
 * docs/bom-excel-export.md). This fixture is deliberately scrambled and includes a
 * kit's exploded fasteners and a line with no proposal position at all (added to
 * the order by hand, or locked before `proposalLineOrder` existed), so a
 * regression in the sort — reverting to tree order, or pushing hardware back to
 * the bottom — fails a concrete assertion rather than surfacing only when someone
 * opens a real BOM in Excel.
 */
const PROCUREMENT = [
  // Given out of proposal order on purpose — the sort has to do real work.
  {
    id: 'pl5',
    sku: 'EXTRA-1',
    name: 'Hand-added Bracket',
    quantity: 1,
    vendor: 'Acme Fab',
    unitCostMinor: 500,
    unitWeightLbs: 1,
    isHardwareComponent: false,
    proposalLineOrder: null, // no proposal position — must sort last
    freeIssue: false,
    purchaseVendor: null,
    sourced: false,
    powderColor: null,
    vendorNotes: null,
  },
  {
    id: 'pl4',
    sku: 'LADDER-1',
    name: 'Ladder',
    quantity: 1,
    vendor: 'Acme Fab',
    unitCostMinor: 8000,
    unitWeightLbs: 30,
    isHardwareComponent: false,
    proposalLineOrder: 2,
    freeIssue: false,
    purchaseVendor: null,
    sourced: false,
    powderColor: null,
    vendorNotes: null,
  },
  {
    id: 'pl3',
    sku: '6820H-LB',
    name: 'Washer',
    quantity: 8,
    vendor: 'Acme Fab',
    unitCostMinor: 20,
    unitWeightLbs: 0.05,
    isHardwareComponent: true, // out of the H-1000 kit
    proposalLineOrder: 1, // same position as its sibling below — the kit's own slot
    freeIssue: false,
    purchaseVendor: null,
    sourced: false,
    powderColor: null,
    vendorNotes: null,
  },
  {
    id: 'pl1',
    sku: 'FRAME-1',
    name: 'Frame',
    quantity: 1,
    vendor: 'Acme Fab',
    unitCostMinor: 10000,
    unitWeightLbs: 50,
    isHardwareComponent: false,
    proposalLineOrder: 0,
    freeIssue: false,
    purchaseVendor: null,
    sourced: false,
    powderColor: null,
    vendorNotes: null,
  },
  {
    id: 'pl2',
    sku: '6820H-LA',
    name: 'Hex Bolt',
    quantity: 4,
    vendor: 'Acme Fab',
    unitCostMinor: 50,
    unitWeightLbs: 0.1,
    isHardwareComponent: true,
    proposalLineOrder: 1,
    freeIssue: false,
    purchaseVendor: null,
    sourced: false,
    powderColor: null,
    vendorNotes: null,
  },
];

// The order the parts SHOULD read in: Frame (0), then the kit's two fasteners
// (both 1 — a stable sort keeps them in the order they were given, Washer before
// Hex Bolt), then Ladder (2), then the hand-added bracket (no position, last).
// Hardware sits between Frame and Ladder — proof it is no longer pushed to the end.
const EXPECTED_SKU_ORDER = ['FRAME-1', '6820H-LB', '6820H-LA', 'LADDER-1', 'EXTRA-1'];

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    acceptedOrder: {
      findUnique: async () => ({
        id: 'o1',
        number: 'ORD-1',
        status: 'RELEASED',
        acceptedVersion: 1,
        organizationId: 'org1',
        proposalId: 'p1',
        acceptedById: 'user-1',
        jobName: 'Test Job',
        bomShipTo: 'CUSTOMER',
        bomSubmittedOn: null,
        deliveryType: null,
        powderCoatBrand: null,
        shipmentQuote: null,
        bomNotes: null,
        customerApproval: null,
        procurement: PROCUREMENT,
      }),
    },
    organization: {
      findUnique: async () => ({ id: 'org1', name: 'Acme Gym', addresses: [], contacts: [] }),
    },
    user: {
      findUnique: async () => ({ name: 'Rep One', email: 'rep@example.com', title: 'Sales' }),
    },
    manufacturer: { findMany: async () => [] },
    proposal: { findUnique: async () => ({ title: 'Test Proposal' }) },
    sku: { findMany: async () => [] },
    hardwareRule: { findMany: async () => [] },
    vendorPartNumber: { findMany: async () => [] },
  },
}));

describe('Bill of Materials — proposal order', () => {
  it('sorts buildBom lines to the accepted proposal position, not tree/alphabetical/hardware-last order', async () => {
    const { buildBom } = await import('../../src/handoff/bom.js');
    const doc = await buildBom('o1', { vendor: '*' });
    expect(doc.lines.map((l) => l.sku)).toEqual(EXPECTED_SKU_ORDER);
  });

  it('carries the same order into the printed HTML (PDF) table', async () => {
    const { renderBomHtml } = await import('../../src/handoff/bomDocuments.js');
    const { html } = await renderBomHtml('o1', '*', {});
    const positions = EXPECTED_SKU_ORDER.map((sku) => html.indexOf(sku));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('carries the same order into the CSV export, with the BOM addresses and questions the old client CSV lacked', async () => {
    const { renderBomCsv } = await import('../../src/handoff/bomDocuments.js');
    const { csv } = await renderBomCsv('o1', '*', {});
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Ship from');
    expect(csv).toContain('Ship to');
    const positions = EXPECTED_SKU_ORDER.map((sku) => csv.indexOf(sku));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('writes a real .xlsx workbook: proposal order, real numeric cells, a bold header with a fill, and frozen panes', async () => {
    const { renderBomXlsx } = await import('../../src/handoff/bomDocuments.js');
    const { buffer } = await renderBomXlsx('o1', '*', {});

    const wb = new ExcelJS.Workbook();
    // exceljs depends on fast-csv, which pins its own old @types/node — so its
    // `Buffer` and this project's `Buffer` are two structurally different types
    // with the same name, and no cast of the VALUE bridges them. The value itself
    // is a real Buffer at runtime; only the declared parameter type is the wrong
    // vintage. Cast the `xlsx` object (not the detached method — that would drop
    // its `this`) to one where `load` takes `unknown`.
    const xlsx = wb.xlsx as unknown as { load(b: unknown): Promise<ExcelJS.Workbook> };
    await xlsx.load(buffer);
    const sheet = wb.getWorksheet('Bill of Materials');
    expect(sheet).toBeTruthy();
    if (!sheet) return;

    // Freeze panes directly below the header.
    const view = sheet.views?.[0] as { state?: string; ySplit?: number } | undefined;
    expect(view?.state).toBe('frozen');
    expect(view?.ySplit).toBeGreaterThan(0);

    // Find the header row by its known text, then read the part-number column
    // down from there — proving the sheet reads in proposal order too.
    let headerRowNumber = -1;
    let partCol = -1;
    let qtyCol = -1;
    sheet.eachRow((row, rowNumber) => {
      row.eachCell((cell, colNumber) => {
        if (cell.value === 'Part #') {
          headerRowNumber = rowNumber;
          partCol = colNumber;
        }
        if (cell.value === 'Qty' && headerRowNumber === rowNumber) qtyCol = colNumber;
      });
    });
    expect(headerRowNumber).toBeGreaterThan(0);
    expect(qtyCol).toBeGreaterThan(0);

    const headerRow = sheet.getRow(headerRowNumber);
    const headerCell = headerRow.getCell(partCol);
    expect(headerCell.font?.bold).toBe(true);
    expect((headerCell.fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe('FFF2F3EF');

    const skusInSheetOrder: string[] = [];
    let qtyIsNumber = false;
    let costNumFmt: string | undefined;
    for (let r = headerRowNumber + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const part = row.getCell(partCol).value;
      if (typeof part !== 'string' || !EXPECTED_SKU_ORDER.includes(part)) continue;
      skusInSheetOrder.push(part);
      const qtyCell = row.getCell(qtyCol);
      if (part === 'FRAME-1') {
        qtyIsNumber = typeof qtyCell.value === 'number';
        // Total cost is the last column; read its numFmt off the same row.
        const totalCostCell = row.getCell(row.cellCount);
        costNumFmt = totalCostCell.numFmt;
      }
    }
    expect(skusInSheetOrder).toEqual(EXPECTED_SKU_ORDER);
    expect(qtyIsNumber).toBe(true);
    expect(costNumFmt).toBe('$#,##0.00');
  });
});
