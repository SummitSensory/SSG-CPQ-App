import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { CanvaApi } from '../../src/integrations/canva/client.js';
import { DEFAULT_COPY_FIELDS, defaultContent } from '../../src/strategicPartnership/copy.js';

/**
 * The generation run end to end, against an in-memory Prisma stub and a stub Canva.
 * Nothing reaches Canva or Blob. What is proven:
 *
 *  - the backend calculates and stores the outputs — 3-Year Equipment Savings among
 *    them — when a run starts;
 *  - the run walks assets -> autofill -> export -> archive across polls and lands on
 *    READY_FOR_REVIEW with the Canva links and the archived PDF;
 *  - a second Generate while a run is in flight does not start another;
 *  - a PDF that is not US Letter portrait fails the run;
 *  - a template text field the CRM has no copy for fails the run before autofill.
 */

type Row = Record<string, unknown> & { id: string; updatedAt: Date };
const ROWS = new Map<string, Row>();
let SETTINGS: Record<string, unknown> | null = null;
let tick = 0;
const nextDate = () => new Date(Date.UTC(2026, 8, 24, 12, 0, 0, ++tick));

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) =>
    v instanceof Date ? (row[k] as Date)?.getTime() === v.getTime() : row[k] === v,
  );
}

function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    // Prisma.DbNull is an object; treat it as SQL NULL.
    row[k] =
      v &&
      typeof v === 'object' &&
      (v as { constructor?: { name?: string } }).constructor?.name === 'DbNull'
        ? null
        : v;
  }
  row.updatedAt = nextDate();
}

vi.mock('../../src/lib/prisma.js', () => {
  const prisma = {
    strategicPartnershipProposal: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const r = ROWS.get(where.id);
        return r ? { ...r, organization: { id: 'org1', name: 'Treetop' } } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = ROWS.get(where.id)!;
        applyData(r, data);
        return { ...r, organization: { id: 'org1', name: 'Treetop' } };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const r = ROWS.get(String(where.id));
        if (!r || !matches(r, where)) return { count: 0 };
        applyData(r, data);
        return { count: 1 };
      },
    },
    strategicPartnershipSettings: { findUnique: async () => SETTINGS },
    auditLog: { create: async () => ({}) },
  };
  return { prisma };
});

async function letterPdf(width = 612, height = 792, pages = 10): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([width, height]);
  return Buffer.from(await doc.save());
}

function baseRow(): Row {
  return {
    id: 'spp1',
    number: 'SPP-2026-0001',
    organizationId: 'org1',
    opportunityId: null,
    status: 'READY_TO_GENERATE',
    customerShortName: 'Treetop',
    customerFullName: 'The Treetop ABA Therapy Center',
    executiveName: 'Ari Treuhaft',
    executiveTitle: 'CEO',
    industry: 'ABA Therapy',
    partnerDiscountBps: 1750,
    standardProjectValueMinor: 1_651_400n,
    pmHoursReturnedPerCenterHundredths: 4100,
    pmHourValueMinor: 7_500n,
    contributionMarginPerHourMinor: 3_000n,
    year1PlannedCenters: 10,
    year2PlannedCenters: 10,
    year3PlannedCenters: 10,
    year4PlannedCenters: null,
    year5PlannedCenters: null,
    customerLogo: {
      url: 'https://blob/logo.png',
      pathname: 'p/logo.png',
      filename: 'logo.png',
      contentType: 'image/png',
      bytes: 3,
    },
    projectImages: [
      {
        url: 'https://blob/1.jpg',
        pathname: 'p/1.jpg',
        filename: '1.jpg',
        contentType: 'image/jpeg',
        bytes: 3,
      },
    ],
    partnerProjectValueMinor: null,
    savingsPerCenterMinor: null,
    threeYearEquipmentSavingsMinor: null,
    fiveYearEquipmentSavingsMinor: null,
    pmCapacityValuePerCenterMinor: null,
    threeYearPmCapacityValueMinor: null,
    fiveYearPmCapacityValueMinor: null,
    threeYearCombinedValueMinor: null,
    fiveYearCombinedValueMinor: null,
    threeYearCumulativeCenters: null,
    fiveYearCumulativeCenters: null,
    calculatedAt: null,
    calculationVersion: null,
    automationRunId: null,
    generation: null,
    generatedSnapshot: null,
    errorMessage: null,
    canvaDesignId: null,
    canvaDesignUrl: null,
    canvaViewUrl: null,
    pdfUrl: null,
    pdfPathname: null,
    generatedAt: null,
    approvedAt: null,
    approvedById: null,
    sentAt: null,
    createdById: 'user-rep',
    createdAt: new Date(Date.UTC(2026, 8, 1)),
    updatedAt: nextDate(),
  };
}

/** Every text field the default copy fills, plus the images and one chart. */
async function fullDataset() {
  const ds: Record<string, { type: 'text' | 'image' | 'chart' }> = {};
  for (const f of DEFAULT_COPY_FIELDS) ds[f.field] = { type: 'text' };
  for (const f of ['CUSTOMER_LOGO', 'PROJECT_IMAGE_1', 'PROJECT_IMAGE_2'])
    ds[f] = { type: 'image' };
  ds.ROLLOUT_CHART = { type: 'chart' };
  return ds;
}

interface Harness {
  canva: CanvaApi;
  autofillCalls: Array<{ title: string; data: Record<string, unknown> }>;
  stored: Array<{ pathname: string; bytes: number }>;
  pollsUntilDone: { autofill: number; export: number };
}

function harness(opts: {
  pdf: Buffer;
  dataset: Record<string, { type: 'text' | 'image' | 'chart' }>;
}): Harness {
  const h: Harness = {
    autofillCalls: [],
    stored: [],
    pollsUntilDone: { autofill: 1, export: 1 },
    canva: undefined as unknown as CanvaApi,
  };
  let uploads = 0;
  h.canva = {
    getBrandTemplateDataset: async () => opts.dataset,
    startAssetUpload: async () => ({ id: `up${++uploads}`, status: 'in_progress' }),
    getAssetUpload: async (jobId) => ({
      id: jobId,
      status: 'success',
      asset: { id: `asset-${jobId}` },
    }),
    startAutofill: async (input) => {
      h.autofillCalls.push({ title: input.title, data: input.data });
      return { id: 'af1', status: 'in_progress' };
    },
    getAutofill: async () =>
      h.pollsUntilDone.autofill-- > 0
        ? { id: 'af1', status: 'in_progress' }
        : {
            id: 'af1',
            status: 'success',
            result: {
              type: 'create_design',
              design: {
                id: 'D1',
                urls: { edit_url: 'https://canva/edit/D1', view_url: 'https://canva/view/D1' },
              },
            },
          },
    startPdfExport: async () => ({ id: 'ex1', status: 'in_progress' }),
    getExport: async () =>
      h.pollsUntilDone.export-- > 0
        ? { id: 'ex1', status: 'in_progress' }
        : { id: 'ex1', status: 'success', urls: ['https://export.canva/x.pdf'] },
    download: async () => opts.pdf,
  };
  return h;
}

function deps(h: Harness) {
  return {
    canva: async () => h.canva,
    canvaReady: async () => true,
    getFile: async () => Buffer.from([1, 2, 3]),
    putFile: async (pathname: string, bytes: Buffer) => {
      h.stored.push({ pathname, bytes: bytes.length });
      return { url: `https://blob/${pathname}`, pathname };
    },
    fileStoreConfigured: () => true,
    now: () => new Date(),
    newRunId: () => 'run-1',
  };
}

beforeEach(() => {
  ROWS.clear();
  ROWS.set('spp1', baseRow());
  SETTINGS = {
    key: 'default',
    brandTemplateId: 'BT1',
    content: defaultContent(),
    version: 3,
    updatedAt: new Date(),
  };
});

async function service() {
  return import('../../src/strategicPartnership/service.js');
}

async function pollToEnd(svc: Awaited<ReturnType<typeof service>>, d: ReturnType<typeof deps>) {
  let dto = await svc.advancePartnership('spp1', d);
  for (let i = 0; i < 10 && dto.status === 'GENERATING_CANVA'; i++) {
    dto = await svc.advancePartnership('spp1', d);
  }
  return dto;
}

describe('strategic partnership generation', () => {
  it('calculates, autofills, exports and archives — then waits for review', async () => {
    const svc = await service();
    const h = harness({ pdf: await letterPdf(), dataset: await fullDataset() });
    const d = deps(h);

    const first = await svc.generatePartnership('spp1', 'user-rep', d);
    // The outputs are stored the moment a run starts.
    const row = ROWS.get('spp1')!;
    expect(row.threeYearEquipmentSavingsMinor).toBe(8_669_850n);
    expect(row.fiveYearCumulativeCenters).toBe(50); // year 4/5 omitted -> year 3's 10
    expect(first.outputs?.threeYearEquipmentSavingsMinor).toBe(8_669_850);
    expect(first.status).toBe('GENERATING_CANVA');

    const done = await pollToEnd(svc, d);
    expect(done.status).toBe('READY_FOR_REVIEW');
    expect(done.canvaDesignUrl).toBe('https://canva/edit/D1');
    expect(done.canvaViewUrl).toBe('https://canva/view/D1');
    expect(done.hasPdf).toBe(true);
    expect(h.stored[0]!.pathname).toBe('strategic-partnerships/SPP-2026-0001/run-1.pdf');

    // What went to Canva.
    const call = h.autofillCalls[0]!;
    expect(call.title).toBe('Treetop + Summit Strategic Partnership Proposal');
    expect(call.data.THREE_YEAR_EQUIPMENT_SAVINGS).toEqual({ type: 'text', text: '$86,699' });
    expect(call.data.CUSTOMER_LOGO).toEqual({ type: 'image', asset_id: 'asset-up1' });
    expect(call.data.PROJECT_IMAGE_1).toEqual({ type: 'image', asset_id: 'asset-up2' });
    expect(call.data.PROJECT_IMAGE_2).toBeUndefined(); // no upload: keeps the template image
    expect((call.data.ROLLOUT_CHART as { type: string }).type).toBe('chart');
    expect(done.generation?.warnings.join(' ')).toMatch(/PROJECT_IMAGE_2 keeps the template/);

    const snap = ROWS.get('spp1')!.generatedSnapshot as {
      textFields: Record<string, string>;
      outputs: Record<string, unknown>;
    };
    expect(snap.textFields.COVER_PREPARED_FOR).toBe('Prepared Exclusively For Ari Treuhaft, CEO');
    expect(snap.outputs.threeYearEquipmentSavingsMinor).toBe('8669850');
  });

  it('a second Generate while a run is in flight returns the same run', async () => {
    const svc = await service();
    const h = harness({ pdf: await letterPdf(), dataset: await fullDataset() });
    const d = deps(h);
    let runs = 0;
    const counting = { ...d, newRunId: () => `run-${++runs}` };
    const a = await svc.generatePartnership('spp1', 'user-rep', counting);
    const b = await svc.generatePartnership('spp1', 'user-rep', counting);
    expect(a.automationRunId).toBe('run-1');
    expect(b.automationRunId).toBe('run-1');
    expect(runs).toBe(1);
  });

  it('fails the run when the export is not US Letter portrait', async () => {
    const svc = await service();
    const h = harness({ pdf: await letterPdf(595, 842), dataset: await fullDataset() }); // A4
    const d = deps(h);
    await svc.generatePartnership('spp1', 'user-rep', d);
    const done = await pollToEnd(svc, d);
    expect(done.status).toBe('ERROR');
    expect(done.errorMessage).toMatch(/US Letter portrait \(612 x 792 pt/);
    expect(h.stored).toHaveLength(0);
  });

  it('fails before autofill when the template has a text field with no copy', async () => {
    const svc = await service();
    const ds = await fullDataset();
    ds.NEW_HEADLINE = { type: 'text' };
    const h = harness({ pdf: await letterPdf(), dataset: ds });
    const d = deps(h);
    const dto = await svc.generatePartnership('spp1', 'user-rep', d);
    const done = dto.status === 'ERROR' ? dto : await pollToEnd(svc, d);
    expect(done.status).toBe('ERROR');
    expect(done.errorMessage).toMatch(/NEW_HEADLINE/);
    expect(h.autofillCalls).toHaveLength(0);
  });

  it('refuses to start without the required inputs, logo and template', async () => {
    const svc = await service();
    const row = ROWS.get('spp1')!;
    row.year2PlannedCenters = null;
    row.customerLogo = null;
    SETTINGS!.brandTemplateId = null;
    const h = harness({ pdf: await letterPdf(), dataset: await fullDataset() });
    await expect(svc.generatePartnership('spp1', 'user-rep', deps(h))).rejects.toThrow(
      /Year 2 planned centers.*customer logo.*brand template/s,
    );
    expect(ROWS.get('spp1')!.status).toBe('READY_TO_GENERATE');
  });

  it('an approved proposal is not regenerated without reopening', async () => {
    const svc = await service();
    ROWS.get('spp1')!.status = 'APPROVED';
    const h = harness({ pdf: await letterPdf(), dataset: await fullDataset() });
    await expect(svc.generatePartnership('spp1', 'user-rep', deps(h))).rejects.toThrow(/Reopen/);
  });
});

describe('pure helpers', () => {
  it('missing inputs and the derived status', async () => {
    const svc = await service();
    const row = baseRow();
    expect(svc.missingInputs(row as never)).toEqual([]);
    expect(svc.derivedDraftStatus(row as never)).toBe('READY_TO_GENERATE');
    row.executiveName = '  ';
    row.partnerDiscountBps = null;
    expect(svc.missingInputs(row as never)).toEqual(['Executive name', 'Partner discount']);
    expect(svc.derivedDraftStatus(row as never)).toBe('DRAFT');
  });

  it('accepts a rotated letter-landscape page only when it prints portrait', async () => {
    const svc = await service();
    const doc = await PDFDocument.create();
    const { degrees } = await import('pdf-lib');
    const p = doc.addPage([792, 612]);
    p.setRotation(degrees(90));
    await expect(svc.assertUsLetterPortrait(Buffer.from(await doc.save()))).resolves.toBe(1);
    await expect(svc.assertUsLetterPortrait(await letterPdf(792, 612, 1))).rejects.toThrow(
      /792 x 612/,
    );
  });

  it('picks the only chart field when none is configured', async () => {
    const svc = await service();
    const r = svc.buildAutofillData({
      dataset: { A: { type: 'chart' }, T: { type: 'text' } },
      textFields: { T: 'x', EXTRA: 'y' },
      assetIds: {},
      chart: { rows: [] },
      chartField: null,
    });
    expect(Object.keys(r.data).sort()).toEqual(['A', 'T']);
    expect(r.warnings.join(' ')).toMatch(/EXTRA is not on the Canva template/);
  });
});
