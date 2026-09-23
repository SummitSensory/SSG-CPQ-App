import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';

/**
 * The Bill of Materials' ship-to and delivery block, as Bryan's revised template lays
 * it out: the street/city rows come only from an address someone confirmed or picked
 * (blank otherwise — the CRM address is no longer a fallback), a portal-confirmed
 * address keeps the customer's own name and contact rows, and a Point of Contact /
 * instructions block is always printed, blanks included.
 */

interface State {
  section: Record<string, unknown> | null;
  submission: Record<string, unknown> | null;
  address: Record<string, unknown> | null;
}
const state: State = { section: null, submission: null, address: null };

const PORTAL_ADDRESS = {
  id: 'addr-portal',
  name: 'Wiggle Room — confirmed',
  line1: '17233 Ventura Boulevard',
  line2: null,
  city: 'Los Angeles',
  region: 'CA',
  postalCode: '91316',
  country: 'USA',
  contactName: 'Portal POC',
  phone: '999-999-9999',
  email: 'portal@example.com',
  source: 'PORTAL',
};

const SUBMISSION = {
  id: 'sub1',
  shipToAddressId: 'addr-portal',
  pocName: 'Jennifer Fattal',
  pocPhone: '1 (303) 748-8082',
  pocEmail: 'jenny@wiggleroomtherapy.com',
  preferredComm: 'Email',
  textNumber: '3035551212',
  secondaryPocName: 'Sam Second',
  secondaryPocPhone: '+44 20 7946 0958',
  secondaryPocEmail: 'a.really.long.secondary.address@wiggleroomtherapy.com',
  secondaryPreferredComm: 'Phone',
  secondaryMobile: null,
  loadingDock: 'No, I need liftgate delivery',
  deliveryTiming: 'Weekday mornings',
  preferredDeliveryDate: new Date('2026-10-05T00:00:00Z'),
  specialInstructions: 'Call 30 minutes ahead. The loading zone is behind the building.',
};

const section = (over: Record<string, unknown> = {}) => ({
  id: 'sec1',
  orderId: 'o1',
  vendor: 'Acme Fab',
  jobName: null,
  shipTo: 'CUSTOMER',
  shipToAddressId: null,
  shipToAddress: null,
  submittedOn: null,
  deliveryType: 'Liftgate',
  loadingDock: null,
  deliveryTiming: null,
  preferredDeliveryDate: null,
  shipmentQuote: null,
  estimatedTax: null,
  notes: null,
  status: 'DRAFT',
  showPowderColor: false,
  showPackagingBag: false,
  answers: [],
  ...over,
});

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    acceptedOrder: {
      findUnique: async () => ({
        id: 'o1',
        number: 'SO-2026-000036',
        status: 'RELEASED',
        acceptedVersion: 4,
        organizationId: 'org1',
        proposalId: 'p1',
        acceptedById: 'user-1',
        jobName: null,
        bomShipTo: 'CUSTOMER',
        bomSubmittedOn: null,
        deliveryType: null,
        powderCoatBrand: null,
        shipmentQuote: null,
        bomNotes: null,
        customerApproval: null,
        procurement: [
          {
            id: 'pl1',
            sku: 'A-2245',
            name: 'Vertical Tall',
            quantity: 4,
            vendor: 'Acme Fab',
            unitCostMinor: 24250,
            unitWeightLbs: 68.25,
            isHardwareComponent: false,
            proposalLineOrder: 0,
            freeIssue: false,
            purchaseVendor: null,
            sourced: false,
            powderColor: null,
            vendorNotes: null,
          },
        ],
      }),
    },
    organization: {
      findUnique: async () => ({
        id: 'org1',
        name: 'Wiggle Room Therapy and Play',
        // A CRM shipping address that must NOT print when nothing was confirmed.
        addresses: [
          {
            type: 'SHIPPING',
            line1: '1 CRM Street',
            line2: null,
            city: 'Nowhere',
            region: 'CA',
            postalCode: '90000',
            country: 'USA',
          },
        ],
        contacts: [
          {
            firstName: 'Jennifer',
            lastName: 'Fattal',
            title: 'Owner',
            email: 'jenny@wiggleroomtherapy.com',
            phone: null,
          },
        ],
      }),
    },
    user: {
      findUnique: async () => ({ name: 'Rep One', email: 'rep@example.com', title: 'Sales' }),
    },
    manufacturer: { findMany: async () => [] },
    proposal: { findUnique: async () => ({ title: 'Test Proposal' }) },
    sku: { findMany: async () => [] },
    hardwareRule: { findMany: async () => [] },
    vendorPartNumber: { findMany: async () => [] },
    bomVendorSection: { findUnique: async () => state.section },
    portalDeliverySubmission: { findFirst: async () => state.submission },
    shipToAddress: { findUnique: async () => state.address },
  },
}));

async function loadSheet(vendor: string): Promise<ExcelJS.Worksheet> {
  const { renderBomXlsx } = await import('../../src/handoff/bomDocuments.js');
  const { buffer } = await renderBomXlsx('o1', vendor, {});
  const wb = new ExcelJS.Workbook();
  // See bom-proposal-order.test.ts for why the `xlsx` object is cast.
  const xlsx = wb.xlsx as unknown as { load(b: unknown): Promise<ExcelJS.Workbook> };
  await xlsx.load(buffer);
  const sheet = wb.getWorksheet('Bill of Materials');
  if (!sheet) throw new Error('no sheet');
  return sheet;
}

/** The row whose column A reads exactly `label`. */
function rowOf(sheet: ExcelJS.Worksheet, label: string): ExcelJS.Row {
  let found: ExcelJS.Row | null = null;
  sheet.eachRow((row) => {
    if (!found && row.getCell(1).value === label) found = row;
  });
  if (!found) throw new Error(`no row labelled ${label}`);
  return found;
}

const cellText = (row: ExcelJS.Row, col: number): string => {
  const v = row.getCell(col).value;
  return v == null ? '' : String(v);
};

beforeEach(() => {
  state.section = null;
  state.submission = null;
  state.address = null;
});

describe('BOM ship-to block', () => {
  it('leaves the street and city rows blank when no address is confirmed — no CRM fallback', async () => {
    state.section = section();
    const { buildBom } = await import('../../src/handoff/bom.js');
    const doc = await buildBom('o1', { vendor: 'Acme Fab' });
    expect(doc.shipTo.name).toBe('Wiggle Room Therapy and Play');
    expect(doc.shipTo.lines).toEqual(['', '']);
    expect(doc.shipTo.contactName).toBe('Jennifer Fattal');

    const sheet = await loadSheet('Acme Fab');
    const head = rowOf(sheet, 'Ship from');
    expect(cellText(head, 2)).toBe('Ship to');
    const n = head.number;
    expect(cellText(sheet.getRow(n + 1), 2)).toBe('Wiggle Room Therapy and Play');
    expect(cellText(sheet.getRow(n + 2), 2)).toBe('');
    expect(cellText(sheet.getRow(n + 3), 2)).toBe('');
    expect(cellText(sheet.getRow(n + 4), 2)).toBe('Jennifer Fattal');
    expect(cellText(sheet.getRow(n + 5), 2)).toBe('jenny@wiggleroomtherapy.com');
  });

  it('prints a portal address under the customer’s own name and contact', async () => {
    state.section = section({ shipToAddressId: 'addr-portal', shipToAddress: PORTAL_ADDRESS });
    state.submission = SUBMISSION;
    const { buildBom } = await import('../../src/handoff/bom.js');
    const doc = await buildBom('o1', { vendor: 'Acme Fab' });
    expect(doc.shipTo).toMatchObject({
      name: 'Wiggle Room Therapy and Play',
      lines: ['17233 Ventura Boulevard', 'Los Angeles, CA 91316'],
      contactName: 'Jennifer Fattal',
      email: 'jenny@wiggleroomtherapy.com',
    });
  });

  it('keeps a hand-picked, non-portal address exactly as before', async () => {
    state.section = section({
      shipToAddressId: 'addr-trailer',
      shipToAddress: { ...PORTAL_ADDRESS, name: 'Job trailer', source: null },
    });
    const { buildBom } = await import('../../src/handoff/bom.js');
    const doc = await buildBom('o1', { vendor: 'Acme Fab' });
    expect(doc.shipTo).toMatchObject({
      name: 'Job trailer',
      contactName: 'Portal POC',
      phone: '999-999-9999',
    });
  });

  it('honours the section’s own "Summit Sensory Gym" choice over the order default', async () => {
    state.section = section({ shipTo: 'SUMMIT' });
    const { buildBom } = await import('../../src/handoff/bom.js');
    const doc = await buildBom('o1', { vendor: 'Acme Fab' });
    expect(doc.shipTo.name).toBe('Summit Sensory Gym');
    expect(doc.shipTo.lines[0]).toBe('6150 S Geneva Court');
  });

  it('prints the confirmed address on the all-vendors sheet', async () => {
    state.submission = SUBMISSION;
    state.address = PORTAL_ADDRESS;
    const { buildBom } = await import('../../src/handoff/bom.js');
    const doc = await buildBom('o1', { vendor: '*' });
    expect(doc.shipTo.lines).toEqual(['17233 Ventura Boulevard', 'Los Angeles, CA 91316']);
    expect(doc.delivery.deliveryType).toBe('No, I need liftgate delivery');
  });
});

describe('BOM delivery block', () => {
  it('prints the POC block with blank values when the customer has not answered', async () => {
    state.section = section();
    const sheet = await loadSheet('Acme Fab');
    const head = rowOf(sheet, 'Ship to Point of Contact(s)');
    expect(cellText(head, 2)).toBe('Primary POC');
    expect(cellText(head, 3)).toBe('Secondary POC');
    for (const label of [
      'Full Name',
      'Primary Phone Number',
      'Primary Email Address',
      'Preferred Communication Type',
      'Text #',
      'Special Delivery Instructions',
      'Preferred Delivery Date',
      'Preferred Delivery Timing',
    ]) {
      const r = rowOf(sheet, label);
      expect(cellText(r, 2)).toBe('');
    }
    expect(cellText(rowOf(sheet, 'Delivery Type'), 2)).toBe('');
    // The rep's free-text delivery field is untouched, on its own row.
    expect(cellText(rowOf(sheet, 'Delivery'), 2)).toBe('Liftgate');
  });

  it('writes the template’s layout, formats and merge from a portal submission', async () => {
    state.section = section({
      shipToAddressId: 'addr-portal',
      shipToAddress: PORTAL_ADDRESS,
      loadingDock: 'No, I need liftgate delivery',
    });
    state.submission = SUBMISSION;
    const sheet = await loadSheet('Acme Fab');

    // Row order: Submission Date, Delivery Type, Delivery.
    const submitted = rowOf(sheet, 'Submission Date').number;
    expect(rowOf(sheet, 'Delivery Type').number).toBe(submitted + 1);
    expect(rowOf(sheet, 'Delivery').number).toBe(submitted + 2);
    expect(cellText(rowOf(sheet, 'Delivery Type'), 2)).toBe('No, I need liftgate delivery');

    // Header: bold, rule underneath, in A:C.
    const head = rowOf(sheet, 'Ship to Point of Contact(s)');
    for (const col of [1, 2, 3]) {
      expect(head.getCell(col).font?.bold).toBe(true);
      expect(head.getCell(col).border?.bottom?.style).toBe('thin');
    }
    // A blank row separates it from the meta block above.
    expect(sheet.getRow(head.number - 1).actualCellCount).toBe(0);

    const name = rowOf(sheet, 'Full Name');
    expect(name.number).toBe(head.number + 1);
    expect(name.getCell(1).font?.bold).toBe(true);
    expect(name.getCell(2).font?.bold).toBeFalsy();
    expect(cellText(name, 2)).toBe('Jennifer Fattal');
    expect(cellText(name, 3)).toBe('Sam Second');

    // A 10-digit phone is a number under the template's format; an international
    // one stays text, as typed.
    const phone = rowOf(sheet, 'Primary Phone Number');
    expect(phone.getCell(2).value).toBe(3037488082);
    expect(phone.getCell(2).numFmt).toBe('[<=9999999]###-####;(###) ###-####');
    expect(phone.getCell(2).alignment?.horizontal).toBe('left');
    expect(phone.getCell(3).value).toBe('+44 20 7946 0958');
    const text = rowOf(sheet, 'Text #');
    expect(text.getCell(2).value).toBe(3035551212);
    expect(cellText(text, 3)).toBe('');
    expect(cellText(rowOf(sheet, 'Preferred Communication Type'), 3)).toBe('Phone');

    // Instructions: merged B:H, wrapped, left; a blank row above them.
    const instr = rowOf(sheet, 'Special Delivery Instructions');
    expect(sheet.getRow(instr.number - 1).actualCellCount).toBe(0);
    expect(instr.number).toBe(text.number + 2);
    expect(sheet.model.merges).toContain(`B${instr.number}:H${instr.number}`);
    expect(instr.getCell(2).alignment).toMatchObject({ horizontal: 'left', wrapText: true });
    expect(cellText(instr, 2)).toBe(SUBMISSION.specialInstructions);

    const date = rowOf(sheet, 'Preferred Delivery Date');
    expect(date.number).toBe(instr.number + 1);
    expect(cellText(date, 2)).toBe('2026-10-05');
    const timing = rowOf(sheet, 'Preferred Delivery Timing');
    expect(timing.number).toBe(instr.number + 2);
    expect(cellText(timing, 2)).toBe('Weekday mornings');

    // Then a blank row and the parts table.
    expect(sheet.getRow(timing.number + 1).actualCellCount).toBe(0);
    expect(cellText(sheet.getRow(timing.number + 2), 1)).toBe('Part #');

    // Column C fits the longest secondary value; the instructions do not widen B.
    const cWidth = sheet.getColumn(3).width ?? 0;
    expect(cWidth).toBeGreaterThanOrEqual(SUBMISSION.secondaryPocEmail.length);
    expect(sheet.getColumn(2).width ?? 0).toBeLessThan(SUBMISSION.specialInstructions.length);
  });

  it('carries the same block into the HTML (PDF) and the CSV', async () => {
    state.section = section({ shipToAddressId: 'addr-portal', shipToAddress: PORTAL_ADDRESS });
    state.submission = SUBMISSION;
    const { renderBomHtml, renderBomCsv } = await import('../../src/handoff/bomDocuments.js');

    const { html } = await renderBomHtml('o1', 'Acme Fab', {});
    expect(html).toContain('Ship to Point of Contact(s)');
    expect(html).toContain('(303) 748-8082');
    expect(html).toContain('+44 20 7946 0958');
    expect(html).toContain('Special Delivery Instructions');
    expect(html).toContain('No, I need liftgate delivery');
    expect(html).not.toContain('1 CRM Street');

    const { csv } = await renderBomCsv('o1', 'Acme Fab', {});
    const lines = csv.replace(/^﻿/, '').split('\n');
    expect(lines).toContain('Ship to Point of Contact(s),Primary POC,Secondary POC');
    expect(lines).toContain('Primary Phone Number,(303) 748-8082,+44 20 7946 0958');
    expect(lines).toContain('Text #,(303) 555-1212,');
    expect(lines).toContain('Preferred Delivery Date,2026-10-05');
    expect(lines).toContain('Delivery Type,"No, I need liftgate delivery"');
  });

  it('neutralises customer text that would run as a spreadsheet formula in the CSV', async () => {
    const { renderBomCsv } = await import('../../src/handoff/bomDocuments.js');
    state.submission = { ...SUBMISSION, specialInstructions: '=HYPERLINK("http://x","click")' };
    const { csv } = await renderBomCsv('o1', 'Acme Fab', {});
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });
});
