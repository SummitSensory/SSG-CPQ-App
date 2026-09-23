import { describe, it, expect, beforeEach, vi } from 'vitest';
/**
 * Portal colour areas → Bill of Materials lines.
 *
 * The pure rules (labels, part lists, brand resolution, the plan) are tested
 * directly; applyColorPicksToOrder is run against a small in-memory prisma so the
 * whole path — mapping, frozen vendors, conflicts, the event, idempotency — is
 * exercised without Postgres.
 */
type Line = {
  id: string;
  orderId: string;
  sku: string | null;
  vendor: string | null;
  isHardwareComponent: boolean;
  powderBrandId: string | null;
  powderColorCode: string | null;
  powderColor: string | null;
};
const db = vi.hoisted(() => ({
  mappings: [] as Array<{ areaKey: string; sku: string }>,
  lines: [] as Array<{
    id: string;
    orderId: string;
    sku: string | null;
    vendor: string | null;
    isHardwareComponent: boolean;
    powderBrandId: string | null;
    powderColorCode: string | null;
    powderColor: string | null;
  }>,
  sections: [] as Array<{ orderId: string; vendor: string; status: string }>,
  brands: [] as Array<{ id: string; name: string }>,
  chart: [] as Array<{ name: string; vendorCode: string; vendor: string }>,
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    portalColorAreaMapping: {
      findMany: async ({ where }: { where: { areaKey: { in: string[] } } }) =>
        db.mappings.filter((m) => where.areaKey.in.includes(m.areaKey)),
    },
    procurementLine: {
      findMany: async ({ where }: { where: { orderId: string } }) =>
        db.lines.filter((l) => l.orderId === where.orderId).map((l) => ({ ...l })),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Line> }) => {
        const row = db.lines.find((l) => l.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    bomVendorSection: {
      findMany: async ({ where }: { where: { orderId: string; status: string } }) =>
        db.sections.filter((s) => s.orderId === where.orderId && s.status === where.status),
    },
    powderColorBrand: { findMany: async () => db.brands },
    vendorColor: {
      findMany: async () =>
        db.chart.map((c) => ({
          name: c.name,
          vendorCode: c.vendorCode,
          palette: { manufacturer: { name: c.vendor } },
        })),
    },
    orderEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.events.push(data);
        return data;
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

import {
  applyColorPicksToOrder,
  areaLabel,
  isAreaKey,
  lineColorFor,
  normalizeSkus,
  planColorApplication,
  resolvePowderBrand,
  type ColorAreaPick,
  type PlanLine,
} from '../../src/portal/colorAreas.js';

const CARDINAL = { id: 'b-card', name: 'Cardinal' };

const pick = (areaKey: string, brand: string, code: string): ColorAreaPick => {
  const [group = '', area = ''] = areaKey.split('.');
  return { areaKey, group, area, brand, code };
};
const planLine = (id: string, sku: string, over: Partial<PlanLine> = {}): PlanLine => ({
  id,
  sku,
  vendor: 'Steelworks',
  isHardwareComponent: false,
  powderBrandId: null,
  powderColorCode: null,
  powderColor: null,
  ...over,
});

describe('areaLabel', () => {
  it('humanizes group and area', () => {
    expect(areaLabel('structure_frame_paint.legs')).toBe('Structure frame paint — Legs');
    expect(areaLabel('slide.slide_color')).toBe('Slide — Slide color');
    expect(areaLabel('ball_pit.mat_section_1')).toBe('Ball pit — Mat section 1');
  });
  it('copes with a key that has no area half', () => {
    expect(areaLabel('adventure_mat')).toBe('Adventure mat');
  });
});

describe('isAreaKey / normalizeSkus', () => {
  it('accepts only <group>.<area>', () => {
    expect(isAreaKey('structure_frame_paint.legs')).toBe(true);
    expect(isAreaKey('legs')).toBe(false);
    expect(isAreaKey('a.b.c')).toBe(false);
    expect(isAreaKey('a b.c')).toBe(false);
  });
  it('trims, drops blanks and de-duplicates case-insensitively', () => {
    expect(normalizeSkus([' F-100 ', 'f-100', '', '  ', 'F-200'])).toEqual(['F-100', 'F-200']);
  });
});

describe('brand resolution', () => {
  it('matches managed brands case-insensitively and nothing else', () => {
    expect(resolvePowderBrand('cardinal', [CARDINAL])).toBe(CARDINAL);
    expect(resolvePowderBrand('vinyl', [CARDINAL])).toBeNull();
    expect(resolvePowderBrand('', [CARDINAL])).toBeNull();
  });
  it('composes a powder line with the chart name when the chart has the code', () => {
    const chart = [{ vendor: 'Cardinal', vendorCode: 'T012-WH260', name: 'White Hammer' }];
    expect(lineColorFor({ brand: 'cardinal', code: 'T012-WH260' }, [CARDINAL], chart)).toEqual({
      powderBrandId: 'b-card',
      powderColorCode: 'T012-WH260',
      powderColor: 'Cardinal White Hammer T012-WH260',
    });
    expect(lineColorFor({ brand: 'cardinal', code: 'T009-BL01' }, [CARDINAL], chart)).toEqual({
      powderBrandId: 'b-card',
      powderColorCode: 'T009-BL01',
      powderColor: 'Cardinal T009-BL01',
    });
  });
  it('writes a material colour as text and clears brand/code', () => {
    expect(lineColorFor({ brand: 'vinyl', code: 'Lime' }, [CARDINAL], [])).toEqual({
      powderBrandId: null,
      powderColorCode: null,
      powderColor: 'Vinyl Lime',
    });
  });
});

describe('planColorApplication', () => {
  const base = {
    submittedVendors: new Set<string>(),
    brands: [CARDINAL],
    chart: [],
  };

  it('reports a part two areas claim with different picks and leaves it alone', () => {
    const { updates, result } = planColorApplication({
      ...base,
      picks: [
        pick('structure_frame_paint.legs', 'cardinal', 'T009-BL01'),
        pick('structure_frame_paint.ladder_rungs_and_leg', 'cardinal', 'T009-YL01'),
      ],
      mapping: new Map([
        ['structure_frame_paint.legs', ['F-LEG', 'F-LADDER']],
        ['structure_frame_paint.ladder_rungs_and_leg', ['f-ladder']],
      ]),
      lines: [planLine('l1', 'F-LEG'), planLine('l2', 'F-LADDER')],
    });
    expect(updates.map((u) => u.lineId)).toEqual(['l1']);
    expect(result.conflicts).toEqual([
      {
        sku: 'F-LADDER',
        areas: [
          'structure_frame_paint.ladder_rungs_and_leg: cardinal T009-YL01',
          'structure_frame_paint.legs: cardinal T009-BL01',
        ],
      },
    ]);
  });

  it('two areas agreeing on the same pick is not a conflict', () => {
    const { updates, result } = planColorApplication({
      ...base,
      picks: [pick('a.x', 'cardinal', 'T1'), pick('a.y', 'Cardinal', 't1')],
      mapping: new Map([
        ['a.x', ['P']],
        ['a.y', ['P']],
      ]),
      lines: [planLine('l1', 'P')],
    });
    expect(result.conflicts).toEqual([]);
    expect(updates).toHaveLength(1);
  });

  it('sorts areas into unmapped, no matching line, and frozen vendors; skips hardware', () => {
    const { updates, result } = planColorApplication({
      ...base,
      submittedVendors: new Set(['Matworks']),
      picks: [
        pick('slide.slide_color', 'plastic', 'Green'),
        pick('adventure_mat.zip_line', 'vinyl', 'Lime'),
        pick('ball_pit.ball_pit_vinyl', 'vinyl', 'Yellow'),
        pick('structure_frame_paint.legs', 'cardinal', 'T009-BL01'),
      ],
      mapping: new Map([
        ['adventure_mat.zip_line', ['MAT-ZIP']],
        ['ball_pit.ball_pit_vinyl', ['BP-1']],
        ['structure_frame_paint.legs', ['H-1000']],
      ]),
      lines: [
        planLine('l1', 'MAT-ZIP', { vendor: 'Matworks' }),
        planLine('l2', 'H-1000', { isHardwareComponent: true }),
      ],
    });
    expect(updates).toEqual([]);
    expect(result.unmappedAreas).toEqual(['slide.slide_color']);
    expect(result.noMatchingLines).toEqual([
      'ball_pit.ball_pit_vinyl',
      'structure_frame_paint.legs',
    ]);
    expect(result.skippedVendors).toEqual(['Matworks']);
  });
});

describe('applyColorPicksToOrder', () => {
  const answers = {
    selections: {
      structure_frame_paint: {
        legs: { brand: 'cardinal', code: 'T012-WH260' },
        ladder_rungs_and_leg: { brand: 'cardinal', code: 'T009-YL01' },
      },
      adventure_mat: { zip_line: { brand: 'vinyl', code: 'Lime' } },
      slide: { slide_color: { brand: 'plastic', code: 'Green' } },
    },
  };

  beforeEach(() => {
    db.mappings = [
      { areaKey: 'structure_frame_paint.legs', sku: 'F-LEG' },
      { areaKey: 'structure_frame_paint.ladder_rungs_and_leg', sku: 'F-RUNG' },
      { areaKey: 'adventure_mat.zip_line', sku: 'MAT-ZIP' },
    ];
    db.lines = [
      {
        id: 'l1',
        orderId: 'o1',
        sku: 'f-leg ',
        vendor: 'Steelworks',
        isHardwareComponent: false,
        powderBrandId: null,
        powderColorCode: null,
        powderColor: null,
      },
      {
        id: 'l2',
        orderId: 'o1',
        sku: 'F-RUNG',
        vendor: 'Steelworks',
        isHardwareComponent: false,
        powderBrandId: null,
        powderColorCode: null,
        powderColor: null,
      },
      {
        id: 'l3',
        orderId: 'o1',
        sku: 'MAT-ZIP',
        vendor: 'Matworks',
        isHardwareComponent: false,
        powderBrandId: 'b-card',
        powderColorCode: 'OLD',
        powderColor: 'Cardinal OLD',
      },
      {
        id: 'l4',
        orderId: 'o1',
        sku: 'F-RUNG',
        vendor: 'Rails Inc',
        isHardwareComponent: false,
        powderBrandId: null,
        powderColorCode: null,
        powderColor: null,
      },
    ];
    db.sections = [{ orderId: 'o1', vendor: 'Rails Inc', status: 'SUBMITTED' }];
    db.brands = [CARDINAL];
    db.chart = [{ vendor: 'Cardinal', vendorCode: 'T012-WH260', name: 'White Hammer' }];
    db.events = [];
  });

  it('writes the mapped lines, respects frozen vendors, and logs one event', async () => {
    const result = await applyColorPicksToOrder('o1', answers, 'u1');
    expect(result).toMatchObject({
      linesUpdated: 3,
      unmappedAreas: ['slide.slide_color'],
      noMatchingLines: [],
      skippedVendors: ['Rails Inc'],
      conflicts: [],
    });
    const byId = Object.fromEntries(db.lines.map((l) => [l.id, l]));
    expect(byId.l1).toMatchObject({
      powderBrandId: 'b-card',
      powderColorCode: 'T012-WH260',
      powderColor: 'Cardinal White Hammer T012-WH260',
    });
    expect(byId.l2!.powderColor).toBe('Cardinal T009-YL01');
    expect(byId.l3).toMatchObject({
      powderBrandId: null,
      powderColorCode: null,
      powderColor: 'Vinyl Lime',
    });
    expect(byId.l4!.powderColor).toBeNull();
    expect(db.events).toHaveLength(1);
    expect(db.events[0]).toMatchObject({
      orderId: 'o1',
      action: 'bom.colors.portal-review',
      actorId: 'u1',
    });
  });

  it('is idempotent: applying the same picks again changes nothing', async () => {
    await applyColorPicksToOrder('o1', answers, 'u1');
    const snapshot = JSON.stringify(db.lines);
    const again = await applyColorPicksToOrder('o1', answers, 'u1');
    expect(again.linesUpdated).toBe(0);
    expect(again.linesAlreadyCurrent).toBe(3);
    expect(JSON.stringify(db.lines)).toBe(snapshot);
    expect(db.events).toHaveLength(1);
  });

  it('does nothing for answers with no picks', async () => {
    const result = await applyColorPicksToOrder('o1', { selections: {} }, 'u1');
    expect(result.linesUpdated).toBe(0);
    expect(db.events).toHaveLength(0);
  });
});
