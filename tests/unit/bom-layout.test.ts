import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }));

import {
  groupByHeading,
  headingOf,
  sortForBom,
  type LayoutTables,
} from '../../src/handoff/bomLayout.js';

/**
 * The one place that decides a Bill of Materials' order and headings. The order page
 * and the printed sheet both call it, so these are the rules the shop sees.
 */
const tables = (
  parts: Record<string, { bomSortOrder?: number | null; bomGroup?: string | null }> = {},
  rules: string[] = [],
): LayoutTables => ({
  parts: new Map(
    Object.entries(parts).map(([k, v]) => [
      k,
      { bomSortOrder: v.bomSortOrder ?? null, bomGroup: v.bomGroup ?? null },
    ]),
  ),
  hardwareRuleParts: new Set(['H-1000', ...rules]),
});

describe('headingOf', () => {
  it('files a kit fastener under Hardware by default, and says why', () => {
    expect(headingOf({ sku: '6820H-LA', isHardwareComponent: true }, tables())).toEqual({
      heading: 'Hardware',
      reason: 'kit',
    });
  });

  it('files a hardware-rule part under Hardware even when it came off the proposal', () => {
    expect(headingOf({ sku: 'EYE-1' }, tables({}, ['EYE-1'])).reason).toBe('rule');
  });

  it('lets the catalog keep a kit part in the main list ("" beats the kit flag)', () => {
    const t = tables({ '6820H-LAD': { bomGroup: '' } });
    expect(headingOf({ sku: '6820h-lad', isHardwareComponent: true }, t)).toEqual({
      heading: '',
      reason: 'catalog',
    });
  });

  it('lets one order override the catalog', () => {
    const t = tables({ 'P-1': { bomGroup: 'Crating' } });
    expect(headingOf({ sku: 'P-1', bomGroup: 'Hardware' }, t)).toEqual({
      heading: 'Hardware',
      reason: 'order',
    });
  });

  it('puts everything else in the main list', () => {
    expect(headingOf({ sku: 'FRAME-1' }, tables())).toEqual({ heading: '', reason: 'none' });
  });
});

describe('sortForBom', () => {
  const line = (sku: string, proposalLineOrder: number | null, bomPosition?: number) => ({
    sku,
    proposalLineOrder,
    bomPosition: bomPosition ?? null,
  });

  it('follows the proposal when nobody has set a position', () => {
    const out = sortForBom([line('C', 2), line('A', 0), line('X', null), line('B', 1)], tables());
    expect(out.map((l) => l.sku)).toEqual(['A', 'B', 'C', 'X']);
  });

  it('puts catalog-sequenced parts first, in sequence, then the rest in proposal order', () => {
    const t = tables({ C: { bomSortOrder: 10 }, B: { bomSortOrder: 20 } });
    const out = sortForBom([line('A', 0), line('B', 1), line('C', 2), line('D', 3)], t);
    expect(out.map((l) => l.sku)).toEqual(['C', 'B', 'A', 'D']);
  });

  it('lets an order’s own arrangement win over the catalog sequence', () => {
    const t = tables({ A: { bomSortOrder: 10 }, B: { bomSortOrder: 20 } });
    const out = sortForBom([line('A', 0, 20), line('B', 1, 10)], t);
    expect(out.map((l) => l.sku)).toEqual(['B', 'A']);
  });

  it('is stable for ties, so kit siblings keep their order', () => {
    const out = sortForBom([line('W', 1), line('V', 1), line('U', 1)], tables());
    expect(out.map((l) => l.sku)).toEqual(['W', 'V', 'U']);
  });
});

describe('groupByHeading', () => {
  it('puts the main list first, then headings where their first line falls, case-insensitively', () => {
    const lines = [
      { s: 'h1', h: 'Hardware' },
      { s: 'm1', h: '' },
      { s: 'c1', h: 'Crating' },
      { s: 'h2', h: 'hardware' },
      { s: 'm2', h: '' },
    ];
    const g = groupByHeading(lines, (l) => l.h);
    expect(g.map((x) => [x.title, x.lines.map((l) => l.s)])).toEqual([
      ['', ['m1', 'm2']],
      ['Hardware', ['h1', 'h2']],
      ['Crating', ['c1']],
    ]);
  });
});
