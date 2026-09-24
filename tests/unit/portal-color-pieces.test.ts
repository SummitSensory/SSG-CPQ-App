import { describe, it, expect, vi } from 'vitest';
/**
 * Portal colour areas: part-number PATTERNS and multi-PIECE parts.
 *
 *   - The Adventure floor padding has no fixed part number: it is R-SSG-{LLWW}CLM[-2],
 *     one number per mat size. An area mapped to the pattern R-SSG-*CLM* must colour
 *     whichever size is on the order.
 *   - A Palisades or 90° Climb & Slide mat system is ONE part number that takes a vinyl
 *     colour per piece. Each portal area colours one piece (a slot of the part's
 *     colour spec), and the line carries every piece — never a "conflict".
 */
vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }));

import {
  partMatcher,
  planColorApplication,
  type ColorAreaPick,
  type PlanLine,
} from '../../src/portal/colorAreas.js';
import type { ResolvedColorSpec } from '../../src/vendorColors/service.js';

const pick = (areaKey: string, brand: string, code: string): ColorAreaPick => {
  const [group = '', area = ''] = areaKey.split('.');
  return { areaKey, group, area, brand, code };
};
const planLine = (id: string, sku: string, over: Partial<PlanLine> = {}): PlanLine => ({
  id,
  sku,
  vendor: 'Resilite',
  isHardwareComponent: false,
  powderBrandId: null,
  powderColorCode: null,
  powderColor: null,
  ...over,
});
const base = { submittedVendors: new Set<string>(), brands: [], chart: [] };

const climbSlideSpec: ResolvedColorSpec = {
  specId: 'spec-1',
  slotCount: 3,
  required: false,
  slotUpchargeMinor: 0,
  slotLabels: ['Top platform', 'Slide', 'Stairs'],
  notes: null,
  palette: {
    id: 'pal-1',
    name: 'Resilite Vinyl',
    finishType: 'VINYL',
    manufacturerId: 'm1',
    manufacturerName: 'Resilite',
  },
  colors: [
    { id: 'c-rb', name: 'Royal Blue', vendorCode: 'RB', upchargeMinor: 0 },
    { id: 'c-or', name: 'Orange', vendorCode: 'OR', upchargeMinor: 0 },
    { id: 'c-kg', name: 'Kelly Green', vendorCode: 'KG', upchargeMinor: 0 },
    { id: 'c-li', name: 'Lime', vendorCode: 'LI', upchargeMinor: 0 },
  ],
};

describe('partMatcher', () => {
  it('matches every Adventure floor-padding size with R-SSG-*CLM*', () => {
    const m = partMatcher('R-SSG-*CLM*');
    expect(m('R-SSG-0808CLM')).toBe(true);
    expect(m('R-SSG-1010CLM-2')).toBe(true);
    expect(m('r-ssg-1206clm')).toBe(true);
    expect(m('R-SSA-0808CLM')).toBe(false);
    expect(m('X-R-SSG-0808CLM')).toBe(false);
  });

  it('treats regex characters in a pattern literally', () => {
    expect(partMatcher('A.B*')('AXB1')).toBe(false);
    expect(partMatcher('A.B*')('A.B1')).toBe(true);
  });

  it('an ordinary part number still matches exactly, case-insensitively', () => {
    expect(partMatcher('F-LEG')('f-leg')).toBe(true);
    expect(partMatcher('F-LEG')('F-LEG-2')).toBe(false);
  });
});

describe('Adventure Mat System: one colour, floor padding by pattern + column wraps', () => {
  it('colours whichever mat size is on the order and the column wraps alike', () => {
    const { updates, result } = planColorApplication({
      ...base,
      picks: [pick('adventure_mat.adventure_mat_system', 'vinyl', 'Lime')],
      mapping: new Map([['adventure_mat.adventure_mat_system', ['R-SSG-*CLM*', 'CW-100']]]),
      lines: [
        planLine('mat', 'R-SSG-1008CLM-2'),
        planLine('wrap', 'CW-100'),
        planLine('other', 'F-LEG'),
      ],
    });
    expect(updates.map((u) => [u.lineId, u.to.powderColor])).toEqual([
      ['mat', 'Vinyl Lime'],
      ['wrap', 'Vinyl Lime'],
    ]);
    expect(result.conflicts).toEqual([]);
  });
});

describe('multi-piece parts', () => {
  const climbPicks = [
    pick('climb_slide_mat.climb_slide_piece_1', 'vinyl', 'Royal Blue'),
    pick('climb_slide_mat.climb_slide_piece_2', 'vinyl', 'Orange'),
    pick('climb_slide_mat.climb_slide_piece_3', 'vinyl', 'Kelly Green'),
  ];
  const climbMapping = new Map([
    ['climb_slide_mat.climb_slide_piece_1', [{ sku: 'CS-90', piece: 1 }]],
    ['climb_slide_mat.climb_slide_piece_2', [{ sku: 'CS-90', piece: 2 }]],
    ['climb_slide_mat.climb_slide_piece_3', [{ sku: 'CS-90', piece: 3 }]],
  ]);

  it("fills the part's colour-spec slots from its vendor chart, all on one line", () => {
    const { updates, result } = planColorApplication({
      ...base,
      picks: climbPicks,
      mapping: climbMapping,
      lines: [planLine('l1', 'CS-90')],
      specs: new Map([['l1', climbSlideSpec]]),
    });
    expect(result.conflicts).toEqual([]);
    expect(result.offChart).toEqual([]);
    expect(updates).toHaveLength(1);
    const to = updates[0]!.to;
    expect(to.colorPicks).toEqual([
      { slot: 1, colorId: 'c-rb', name: 'Royal Blue', vendorCode: 'RB', upchargeMinor: 0 },
      { slot: 2, colorId: 'c-or', name: 'Orange', vendorCode: 'OR', upchargeMinor: 0 },
      { slot: 3, colorId: 'c-kg', name: 'Kelly Green', vendorCode: 'KG', upchargeMinor: 0 },
    ]);
    expect(to.powderColor).toBe(
      'Top platform: Royal Blue (RB) · Slide: Orange (OR) · Stairs: Kelly Green (KG)',
    );
    expect(to.powderBrandId).toBeNull();
  });

  it('only two different colours for the SAME piece conflict', () => {
    const { updates, result } = planColorApplication({
      ...base,
      picks: [pick('a.one', 'vinyl', 'Orange'), pick('a.two', 'vinyl', 'Lime')],
      mapping: new Map([
        ['a.one', [{ sku: 'CS-90', piece: 2 }]],
        ['a.two', [{ sku: 'CS-90', piece: 2 }]],
      ]),
      lines: [planLine('l1', 'CS-90')],
      specs: new Map([['l1', climbSlideSpec]]),
    });
    expect(updates).toEqual([]);
    expect(result.conflicts?.[0]?.sku).toBe('CS-90');
  });

  it('a whole-part area alongside piece areas is ambiguous and left alone', () => {
    const { updates, result } = planColorApplication({
      ...base,
      picks: [pick('a.whole', 'vinyl', 'Lime'), pick('a.p1', 'vinyl', 'Orange')],
      mapping: new Map<string, Array<string | { sku: string; piece: number | null }>>([
        ['a.whole', ['CS-90']],
        ['a.p1', [{ sku: 'CS-90', piece: 1 }]],
      ]),
      lines: [planLine('l1', 'CS-90')],
      specs: new Map([['l1', climbSlideSpec]]),
    });
    expect(updates).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
  });

  it("reports a colour that is not on the part's vendor chart and keeps that slot as it was", () => {
    const { updates, result } = planColorApplication({
      ...base,
      picks: [
        pick('climb_slide_mat.climb_slide_piece_1', 'vinyl', 'Royal Blue'),
        pick('climb_slide_mat.climb_slide_piece_2', 'vinyl', 'Mauve'),
      ],
      mapping: climbMapping,
      lines: [
        planLine('l1', 'CS-90', {
          colorPicks: [
            { slot: 2, colorId: 'c-li', name: 'Lime', vendorCode: 'LI', upchargeMinor: 0 },
          ],
        }),
      ],
      specs: new Map([['l1', climbSlideSpec]]),
    });
    expect(result.offChart).toEqual([
      'climb_slide_mat.climb_slide_piece_2: vinyl Mauve — not on Resilite Vinyl',
    ]);
    expect(updates[0]!.to.colorPicks?.map((p) => [p.slot, p.name])).toEqual([
      [1, 'Royal Blue'],
      [2, 'Lime'],
    ]);
  });

  it('a piece beyond what the spec takes is reported, not written', () => {
    const { result } = planColorApplication({
      ...base,
      picks: [pick('palisades_mat.palisades_mat_4', 'vinyl', 'Lime')],
      mapping: new Map([['palisades_mat.palisades_mat_4', [{ sku: 'CS-90', piece: 4 }]]]),
      lines: [planLine('l1', 'CS-90')],
      specs: new Map([['l1', climbSlideSpec]]),
    });
    expect(result.offChart?.[0]).toMatch(/takes 3 colours, not a piece 4/);
  });

  it('with no colour spec on the part yet, still records every piece in order as text', () => {
    const { updates } = planColorApplication({
      ...base,
      picks: climbPicks,
      mapping: climbMapping,
      lines: [planLine('l1', 'CS-90')],
    });
    expect(updates[0]!.to.powderColor).toBe(
      'Piece 1: Vinyl Royal Blue · Piece 2: Vinyl Orange · Piece 3: Vinyl Kelly Green',
    );
    expect(updates[0]!.to.colorPicks).toBeUndefined();
  });

  it('a second review of the same answers changes nothing', () => {
    const first = planColorApplication({
      ...base,
      picks: climbPicks,
      mapping: climbMapping,
      lines: [planLine('l1', 'CS-90')],
      specs: new Map([['l1', climbSlideSpec]]),
    });
    const after = first.updates[0]!.to;
    const again = planColorApplication({
      ...base,
      picks: climbPicks,
      mapping: climbMapping,
      lines: [
        planLine('l1', 'CS-90', { powderColor: after.powderColor, colorPicks: after.colorPicks }),
      ],
      specs: new Map([['l1', climbSlideSpec]]),
    });
    expect(again.updates).toEqual([]);
    expect(again.result.linesAlreadyCurrent).toBe(1);
  });
});
