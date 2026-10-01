import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The colour check end to end, through the REAL Bill of Materials build: the
 * customer's portal answers (as read from monday's JSON answers column), the area
 * mapping, the procurement lines, and the Powder color cell of each vendor's printed
 * sheet. Frame paint (a managed powder brand) and vinyl both covered — they take
 * different paths through lineColorFor and print differently.
 */

const line = (over: Record<string, unknown>) => ({
  id: 'pl',
  productId: null,
  sku: 'X',
  name: 'Part',
  quantity: 1,
  vendor: 'Acme Fab',
  unitCostMinor: 1000,
  unitWeightLbs: 1,
  isHardwareComponent: false,
  proposalLineOrder: 0,
  freeIssue: false,
  purchaseVendor: null,
  sourced: false,
  powderColor: null as string | null,
  powderBrandId: null as string | null,
  powderColorCode: null as string | null,
  colorPicks: null,
  vendorNotes: null,
  ...over,
});

const state = {
  lines: [] as ReturnType<typeof line>[],
  submitted: [] as string[],
  answers: null as unknown,
};

const ANSWERS = {
  selections: {
    structure_frame_paint: {
      legs: { brand: 'cardinal', code: 'T009-BL01' },
      horizontal_beams: { brand: 'cardinal', code: 'T009-BL01' },
    },
    adventure_mat: { zip_line: { brand: 'vinyl', code: 'Lime' } },
  },
};

const MAPPING = [
  { areaKey: 'structure_frame_paint.legs', sku: 'LEG-1', piece: null },
  { areaKey: 'structure_frame_paint.horizontal_beams', sku: 'BEAM-*', piece: null },
  { areaKey: 'adventure_mat.zip_line', sku: 'ZIP-MAT', piece: null },
];

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    acceptedOrder: {
      findUnique: async () => ({
        id: 'o1',
        number: 'SO-2026-000200',
        status: 'RELEASED',
        acceptedVersion: 1,
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
        procurement: state.lines,
      }),
    },
    orderPortalItem: {
      findUnique: async () =>
        state.answers
          ? {
              answers: state.answers,
              state: 'PROVIDED',
              contentHash: 'h1',
              reviewedHash: 'h1',
              sourceItemId: '12964352339',
              lastSyncedAt: new Date('2026-10-01T12:00:00Z'),
            }
          : null,
    },
    portalColorAreaMapping: { findMany: async () => MAPPING },
    procurementLine: { findMany: async () => state.lines },
    powderColorBrand: { findMany: async () => [{ id: 'b-cardinal', name: 'Cardinal' }] },
    vendorColor: {
      findMany: async () => [
        {
          name: 'Blue Hammer',
          vendorCode: 'T009-BL01',
          palette: { manufacturer: { name: 'Cardinal' } },
        },
      ],
    },
    organization: {
      findUnique: async () => ({ id: 'org1', name: 'Test Gym', addresses: [], contacts: [] }),
    },
    user: { findUnique: async () => ({ name: 'Rep', email: 'rep@example.com', title: null }) },
    manufacturer: { findMany: async () => [] },
    proposal: { findUnique: async () => ({ title: 'Test Proposal' }) },
    sku: { findMany: async () => [] },
    hardwareRule: { findMany: async () => [] },
    vendorPartNumber: { findMany: async () => [] },
    bomVendorSection: {
      findUnique: async () => null,
      findMany: async () => state.submitted.map((vendor) => ({ vendor })),
    },
    portalDeliverySubmission: { findFirst: async () => null },
    shipToAddress: { findUnique: async () => null },
  },
}));

const { checkOrderColors } = await import('../../src/portal/colorCheck.js');

const FRAME = 'Cardinal Blue Hammer T009-BL01';

beforeEach(() => {
  state.answers = ANSWERS;
  state.submitted = [];
  state.lines = [
    line({
      id: 'leg',
      sku: 'LEG-1',
      name: 'Leg',
      powderColor: FRAME,
      powderBrandId: 'b-cardinal',
      powderColorCode: 'T009-BL01',
    }),
    line({
      id: 'beam',
      sku: 'BEAM-96',
      name: 'Beam 96"',
      powderColor: FRAME,
      powderBrandId: 'b-cardinal',
      powderColorCode: 'T009-BL01',
    }),
    line({
      id: 'zip',
      sku: 'ZIP-MAT',
      name: 'Zip line mat',
      vendor: 'Resilite',
      powderColor: 'Vinyl Lime',
    }),
  ];
});

describe('the colour check against the printed BOM', () => {
  it('passes when frame paint and vinyl sit in the Powder color column of the right rows', async () => {
    const rep = await checkOrderColors('o1');
    expect(rep.source).toMatchObject({
      columnId: 'long_text_mm6vj4d9',
      itemId: '12964352339',
    });
    expect(rep.summary).toEqual({ ok: 3, problems: 0, areas: 3 });
    const byKey = Object.fromEntries(rep.areas.map((a) => [a.areaKey, a]));
    expect(byKey['structure_frame_paint.legs']?.kind).toBe('FRAME');
    expect(byKey['structure_frame_paint.legs']?.source.path).toBe(
      'selections.structure_frame_paint.legs',
    );
    expect(byKey['structure_frame_paint.legs']?.lines[0]).toMatchObject({
      sku: 'LEG-1',
      vendor: 'Acme Fab',
      expected: FRAME,
      onBom: FRAME,
      columnShown: true,
      status: 'OK',
    });
    expect(byKey['adventure_mat.zip_line']?.kind).toBe('VINYL');
    expect(byKey['adventure_mat.zip_line']?.lines[0]).toMatchObject({
      sku: 'ZIP-MAT',
      vendor: 'Resilite',
      expected: 'Vinyl Lime',
      onBom: 'Vinyl Lime',
      status: 'OK',
    });
  });

  it('flags a part painted the wrong colour, and a vinyl mat with no colour', async () => {
    state.lines[1]!.powderColor = 'Cardinal T012-WH260';
    state.lines[2]!.powderColor = null;
    const rep = await checkOrderColors('o1');
    const beams = rep.areas.find((a) => a.areaKey === 'structure_frame_paint.horizontal_beams');
    expect(beams?.lines[0]).toMatchObject({
      sku: 'BEAM-96',
      expected: FRAME,
      onLine: 'Cardinal T012-WH260',
      onBom: 'Cardinal T012-WH260',
      status: 'MISMATCH',
    });
    const zip = rep.areas.find((a) => a.areaKey === 'adventure_mat.zip_line');
    // No colour on any Resilite line, so the vendor's sheet drops the column entirely.
    expect(zip?.lines[0]).toMatchObject({ onLine: null, columnShown: false, status: 'MISMATCH' });
    expect(rep.summary.problems).toBe(2);
  });

  it('checks a submitted vendor sheet too, and says it is submitted', async () => {
    state.submitted = ['Acme Fab'];
    state.lines[0]!.powderColor = 'Cardinal T009-YL01';
    const rep = await checkOrderColors('o1');
    const legs = rep.areas.find((a) => a.areaKey === 'structure_frame_paint.legs');
    expect(legs?.lines[0]).toMatchObject({ status: 'MISMATCH', vendorSubmitted: true });
  });

  it('reports a pick for an area nobody mapped, and a colour set by hand', async () => {
    state.answers = {
      selections: {
        ...ANSWERS.selections,
        slide: { slide_color: { brand: 'plastic', code: 'Green' } },
      },
    };
    state.lines.push(
      line({ id: 'rail', sku: 'RAIL-1', name: 'Rail', powderColor: 'Cardinal Red' }),
    );
    const rep = await checkOrderColors('o1');
    const slide = rep.areas.find((a) => a.areaKey === 'slide.slide_color');
    expect(slide?.kind).toBe('OTHER');
    expect(slide?.issues[0]).toMatch(/No parts are mapped/);
    expect(rep.handSet).toEqual([
      { vendor: 'Acme Fab', sku: 'RAIL-1', name: 'Rail', onLine: 'Cardinal Red' },
    ]);
  });

  it('says so when no colour answers have been read from monday', async () => {
    state.answers = null;
    const rep = await checkOrderColors('o1');
    expect(rep.portal.found).toBe(false);
    expect(rep.areas).toEqual([]);
  });
});
