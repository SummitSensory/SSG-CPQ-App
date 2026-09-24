import { describe, it, expect, vi } from 'vitest';
/**
 * Fixes from the 2026-09-24 review of PR #143 (portal colour pieces and patterns).
 * Each case is a way a wrong or missing colour could have reached a vendor sheet.
 */
vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }));

import {
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

const spec: ResolvedColorSpec = {
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
    { id: 'c-li', name: 'Lime', vendorCode: 'LI', upchargeMinor: 0 },
  ],
};
const mapping = new Map([
  ['climb_slide_mat.climb_slide_piece_1', [{ sku: 'CS-90', piece: 1 }]],
  ['climb_slide_mat.climb_slide_piece_2', [{ sku: 'CS-90', piece: 2 }]],
]);

describe('PR #143 review fixes', () => {
  it('H1: every piece off the chart never erases the colour already on the line', () => {
    const { updates, result } = planColorApplication({
      ...base,
      picks: [
        pick('climb_slide_mat.climb_slide_piece_1', 'vinyl', 'Mauve'),
        pick('climb_slide_mat.climb_slide_piece_2', 'vinyl', 'Teal'),
      ],
      mapping,
      lines: [planLine('l1', 'CS-90', { powderColor: 'Piece 1: Vinyl Red · Piece 2: Vinyl Blue' })],
      specs: new Map([['l1', spec]]),
    });
    expect(updates).toEqual([]);
    expect(result.offChart).toHaveLength(2);
  });

  it('M1: picks from an old spec (slot beyond slotCount, colour off the chart) are dropped and reported', () => {
    const { updates, result } = planColorApplication({
      ...base,
      picks: [pick('climb_slide_mat.climb_slide_piece_1', 'vinyl', 'Royal Blue')],
      mapping,
      lines: [
        planLine('l1', 'CS-90', {
          colorPicks: [
            { slot: 2, colorId: 'gone', name: 'Old Red', vendorCode: 'X', upchargeMinor: 0 },
            { slot: 5, colorId: 'c-li', name: 'Lime', vendorCode: 'LI', upchargeMinor: 0 },
          ],
        }),
      ],
      specs: new Map([['l1', spec]]),
    });
    expect(updates[0]!.to.colorPicks?.map((p) => p.slot)).toEqual([1]);
    expect(updates[0]!.to.powderColor).toBe('Top platform: Royal Blue (RB)');
    expect(result.offChart?.join(' ')).toMatch(/Old Red in slot 2.*Lime in slot 5/);
  });

  it('M3: a whole-part colour on a line with slot picks clears them', () => {
    const { updates } = planColorApplication({
      ...base,
      picks: [pick('a.whole', 'vinyl', 'Lime')],
      mapping: new Map([['a.whole', ['CS-90']]]),
      lines: [
        planLine('l1', 'CS-90', {
          colorPicks: [
            { slot: 1, colorId: 'c-rb', name: 'Royal Blue', vendorCode: 'RB', upchargeMinor: 0 },
          ],
        }),
      ],
    });
    expect(updates[0]!.to).toMatchObject({ powderColor: 'Vinyl Lime', colorPicks: [] });
  });

  it('L1: a colour NAME wins over another colour whose CODE spells it', () => {
    const tricky: ResolvedColorSpec = {
      ...spec,
      colors: [
        { id: 'c-code', name: 'Sky', vendorCode: 'Orange', upchargeMinor: 0 },
        { id: 'c-name', name: 'Orange', vendorCode: 'OR', upchargeMinor: 0 },
      ],
    };
    const { updates } = planColorApplication({
      ...base,
      picks: [pick('climb_slide_mat.climb_slide_piece_1', 'vinyl', 'Orange')],
      mapping,
      lines: [planLine('l1', 'CS-90')],
      specs: new Map([['l1', tricky]]),
    });
    expect(updates[0]!.to.colorPicks?.[0]?.colorId).toBe('c-name');
  });

  it('L2: one area reaching a line twice with different pieces is a conflict, not a guess', () => {
    const { updates, result } = planColorApplication({
      ...base,
      picks: [pick('a.x', 'vinyl', 'Lime')],
      mapping: new Map([
        [
          'a.x',
          [
            { sku: 'CS-90', piece: 1 },
            { sku: 'CS-*', piece: 2 },
          ],
        ],
      ]),
      lines: [planLine('l1', 'CS-90')],
      specs: new Map([['l1', spec]]),
    });
    expect(updates).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
  });

  it('a pattern never colours a hardware line or a submitted vendor sheet', () => {
    const { updates, result } = planColorApplication({
      ...base,
      submittedVendors: new Set(['Frozen Co']),
      picks: [pick('adventure_mat.adventure_mat_system', 'vinyl', 'Lime')],
      mapping: new Map([['adventure_mat.adventure_mat_system', ['R-SSG-*CLM*']]]),
      lines: [
        planLine('hw', 'R-SSG-0808CLM', { isHardwareComponent: true }),
        planLine('frozen', 'R-SSG-1010CLM', { vendor: 'Frozen Co' }),
        planLine('ok', 'R-SSG-1212CLM-2'),
      ],
    });
    expect(updates.map((u) => u.lineId)).toEqual(['ok']);
    expect(result.skippedVendors).toEqual(['Frozen Co']);
  });
});
