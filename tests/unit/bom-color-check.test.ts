import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }));

const { bomColorCells, buildColorCheck, colorKindOf } =
  await import('../../src/portal/colorCheck.js');

/** The pure halves of the colour check (src/portal/colorCheck.ts). */

const brands = [{ id: 'b1', name: 'Cardinal' }];
const SOURCE = { boardId: '6533700776', itemId: '1', columnId: 'long_text_mm6vj4d9' };

describe('bomColorCells', () => {
  it('reads the Powder color cell of each part row, whatever position the column is in', () => {
    const cells = bomColorCells({
      columns: ['Part #', 'Vendor part #', 'Description', 'Qty', 'Powder color', 'Weight (lb)'],
      groups: [
        {
          title: '',
          rows: [
            [
              { text: 'leg-1' },
              { text: '—' },
              { text: 'Leg' },
              { text: '2' },
              { text: 'Cardinal T009-BL01' },
              { text: '1.00' },
            ],
            [
              { text: 'MAT-1' },
              { text: 'A-1' },
              { text: 'Mat' },
              { text: '1' },
              { text: 'Vinyl  Lime' },
              { text: '1.00' },
            ],
          ],
        },
      ],
    });
    expect(cells.columnShown).toBe(true);
    expect(cells.byPart.get('LEG-1')).toEqual(['Cardinal T009-BL01']);
    expect(cells.byPart.get('MAT-1')).toEqual(['Vinyl Lime']);
  });

  it('knows when the sheet has no Powder color column', () => {
    const cells = bomColorCells({ columns: ['Part #', 'Description'], groups: [] });
    expect(cells.columnShown).toBe(false);
    expect(cells.byPart.size).toBe(0);
  });
});

describe('colorKindOf', () => {
  it('calls a managed powder brand frame paint, vinyl vinyl, and anything else a material', () => {
    expect(colorKindOf('cardinal', brands)).toBe('FRAME');
    expect(colorKindOf('Vinyl', brands)).toBe('VINYL');
    expect(colorKindOf('plastic', brands)).toBe('OTHER');
  });
});

describe('buildColorCheck', () => {
  const pick = {
    areaKey: 'structure_frame_paint.legs',
    group: 'structure_frame_paint',
    area: 'legs',
    brand: 'cardinal',
    code: 'T009-BL01',
  };
  const leg = {
    id: 'l1',
    sku: 'LEG-1',
    name: 'Leg',
    vendor: 'Acme Fab',
    isHardwareComponent: false,
    powderBrandId: 'b1',
    powderColorCode: 'T009-BL01',
    powderColor: 'Cardinal T009-BL01',
  };

  it('catches a colour that is right on the line but missing from the printed row', () => {
    const out = buildColorCheck({
      picks: [pick],
      mapping: new Map([['structure_frame_paint.legs', [{ sku: 'LEG-1', piece: null }]]]),
      lines: [leg],
      submittedVendors: new Set(),
      brands,
      chart: [],
      // The sheet printed some other part's colour on this row.
      bom: new Map([['Acme Fab', { columnShown: true, byPart: new Map([['LEG-1', ['—']]]) }]]),
      source: SOURCE,
    });
    expect(out.areas[0]?.lines[0]).toMatchObject({
      expected: 'Cardinal T009-BL01',
      onBom: '—',
      status: 'NOT_ON_BOM',
    });
    expect(out.summary).toEqual({ ok: 0, problems: 1, areas: 1 });
  });

  it('reports two areas giving one part different colours as a conflict, not a hand-set colour', () => {
    const beams = {
      ...pick,
      areaKey: 'structure_frame_paint.horizontal_beams',
      area: 'horizontal_beams',
      code: 'T009-YL01',
    };
    const out = buildColorCheck({
      picks: [pick, beams],
      mapping: new Map([
        ['structure_frame_paint.legs', [{ sku: 'LEG-1', piece: null }]],
        ['structure_frame_paint.horizontal_beams', [{ sku: 'LEG-*', piece: null }]],
      ]),
      lines: [leg],
      submittedVendors: new Set(),
      brands,
      chart: [],
      bom: new Map(),
      source: SOURCE,
    });
    expect(out.areas[0]?.issues.join(' ')).toMatch(/more than one area/);
    expect(out.areas[0]?.lines).toEqual([]);
    expect(out.handSet).toEqual([]);
  });

  it('names the mapped parts when none of them are on the order', () => {
    const out = buildColorCheck({
      picks: [pick],
      mapping: new Map([['structure_frame_paint.legs', [{ sku: 'PAL-MAT', piece: 2 }]]]),
      lines: [leg],
      submittedVendors: new Set(),
      brands,
      chart: [],
      bom: new Map(),
      source: SOURCE,
    });
    expect(out.areas[0]?.mappedParts).toEqual(['PAL-MAT (piece 2)']);
    expect(out.areas[0]?.issues[0]).toMatch(/None of the mapped parts \(PAL-MAT \(piece 2\)\)/);
  });
});
