import { describe, it, expect, vi } from 'vitest';
import type { AdvAnswers } from '../../src/proposals/adventureSeries.js';

/**
 * Regression: "When the BOM appears, all of the hardware should be listed out."
 *
 * An H-1000 Hardware Kit line that reached an accepted proposal WITHOUT its
 * `components` breakdown (a proposal started from a saved template — "Save as
 * template" did not keep the field) locked as ONE bundled "Hardware Kit" line on the
 * Bill of Materials. SO-2026-000040 went to Goldberg that way. Lock time now derives
 * the breakdown (src/handoff/kitComponents.ts), from the kit's itemised description
 * or, failing that, from the proposal's configurator answers.
 */

// loadFormulaRules reads HardwareRule rows; none means the workbook defaults.
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { hardwareRule: { findMany: async () => [] } },
}));

const { withKitComponents, parseKitDescription, proposalHardwareQty } =
  await import('../../src/handoff/kitComponents.js');
const { procurementFromItems } = await import('../../src/handoff/lock.js');
const { hardwareRollup, ACCESSORY_HW_PARTS } =
  await import('../../src/proposals/adventureSeries.js');
const { DEFAULT_HARDWARE_RULES } = await import('../../src/proposals/hardwareRules.js');

// Same configuration as tests/unit/hardware-rules.test.ts.
const answers: AdvAnswers = {
  length: 10,
  width: 10,
  config: 'Square',
  legs: 4,
  ladders: 1,
  brackets: true,
  bracketsQty: 4,
  swivel360: 2,
  forged: 0,
  swingHanger: 0,
  vRings: 1,
};
const sections = [{ id: 'meta', type: 'CUSTOMER_INFO', data: { advAnswers: answers } }];

/** The kit line exactly as a template-loaded proposal stores it: no breakdown. */
const summaryKit = {
  ref: 'kit',
  lineType: 'PRODUCT',
  kind: 'INCLUDED',
  sku: 'H-1000',
  name: 'Hardware Kit',
  description: 'All mounting hardware for this structure — 450 pieces across 20 part numbers.',
  quantity: 1,
  rateMinor: 77634,
  costEach: 0,
  components: null,
  source: '',
};
const frame = {
  ref: 'frame',
  lineType: 'PRODUCT',
  kind: 'INCLUDED',
  sku: 'A-2245',
  name: 'Vertical Tall',
  quantity: 3,
};
// Accessory hardware that prints as its own proposal line — must NOT also come out of the kit.
const eyeBolts = {
  ref: 'eye',
  lineType: 'PRODUCT',
  kind: 'INCLUDED',
  sku: '6820H-LP',
  name: 'Eye Bolt - Fixed',
  quantity: 14,
};

describe('H-1000 kit with no breakdown: every fastener is still listed on the BOM', () => {
  it('before the fix the kit stayed one bundled line (the bug, pinned)', () => {
    const seeds = procurementFromItems([frame, summaryKit]);
    expect(seeds.filter((s) => s.sku === 'H-1000')).toHaveLength(1);
    expect(seeds.some((s) => s.isHardwareComponent)).toBe(false);
  });

  it('derives the breakdown from the configurator answers and lists each fastener', async () => {
    const { items, filled } = await withKitComponents([frame, summaryKit, eyeBolts], sections);
    expect(filled).toHaveLength(1);
    expect(filled[0]!.source).toBe('configurator');

    const seeds = procurementFromItems(items);
    // The bundled line is gone…
    expect(seeds.find((s) => s.sku === 'H-1000')).toBeUndefined();
    // …replaced by one line per fastener, each with a part number and a quantity.
    const hw = seeds.filter((s) => s.isHardwareComponent);
    expect(hw.length).toBeGreaterThan(5);
    for (const h of hw) {
      expect(h.sku).toBeTruthy();
      expect(h.quantity).toBeGreaterThan(0);
      expect(h.kitSku).toBe('H-1000');
      // At the kit's own proposal position, so they print where the kit sat.
      expect(h.proposalLineOrder).toBe(1);
    }
    // Matches what the builder's live kit refresh computes for the same proposal.
    const expected = hardwareRollup(
      answers,
      {},
      DEFAULT_HARDWARE_RULES,
      undefined,
      ACCESSORY_HW_PARTS,
      { '6820H-LP': 14 },
    ).components.filter((c) => c.qty > 0);
    expect(hw.map((h) => [h.sku, h.quantity])).toEqual(expected.map((c) => [c.part, c.qty]));
    expect(hw.find((h) => h.sku === '6820H-LAK')?.quantity).toBe(17);
    // The eye bolts already on the proposal are not ordered a second time from the kit.
    expect(hw.some((h) => h.sku === '6820H-LP')).toBe(false);
    expect(seeds.filter((s) => s.sku === '6820H-LP')).toHaveLength(1);
    // The frame line is untouched.
    expect(seeds.find((s) => s.sku === 'A-2245')?.quantity).toBe(3);
  });

  it('prefers an itemised description — exactly what was quoted', async () => {
    const kit = {
      ...summaryKit,
      description:
        '4× Playground Handles, Gate Handles (6820H-LAD) · 4× Swing & Swivel Eye Bolt (Quick Shift Saddle Bracket) (6820H-LDD) · 157× Washer 1/2 Flat (6820H-LB)',
    };
    const { items, filled } = await withKitComponents([kit], []);
    expect(filled[0]!.source).toBe('description');
    const seeds = procurementFromItems(items);
    expect(seeds.map((s) => [s.sku, s.quantity, s.name])).toEqual([
      ['6820H-LAD', 4, 'Playground Handles, Gate Handles'],
      ['6820H-LDD', 4, 'Swing & Swivel Eye Bolt (Quick Shift Saddle Bracket)'],
      ['6820H-LB', 157, 'Washer 1/2 Flat'],
    ]);
  });

  it('multiplies through the kit quantity', async () => {
    const kit = { ...summaryKit, quantity: 2, description: '3× Hex Bolt (6820H-LA)' };
    const { items } = await withKitComponents([kit], []);
    expect(procurementFromItems(items)).toMatchObject([{ sku: '6820H-LA', quantity: 6 }]);
  });

  it('leaves a kit that already carries its breakdown alone (same reference)', async () => {
    const kit = { ...summaryKit, components: [{ part: '6820H-LA', name: 'Bolt', qty: 9 }] };
    const input = [kit];
    const { items, filled } = await withKitComponents(input, sections);
    expect(items).toBe(input);
    expect(filled).toEqual([]);
    expect(procurementFromItems(items)).toMatchObject([{ sku: '6820H-LA', quantity: 9 }]);
  });

  it('does not guess when there is neither an itemised description nor answers', async () => {
    const { items, filled } = await withKitComponents([summaryKit], []);
    expect(filled).toEqual([]);
    expect(procurementFromItems(items)).toMatchObject([{ sku: 'H-1000', quantity: 1 }]);
  });

  it('never changes the proposal items it was given', async () => {
    const kit = { ...summaryKit };
    await withKitComponents([kit], sections);
    expect(kit.components).toBeNull();
  });
});

describe('parseKitDescription', () => {
  it('reads names that contain parentheses, using the last group as the part', () => {
    expect(parseKitDescription('2× Eye Bolt (Fixed) (6820H-LP)')).toEqual([
      { part: '6820H-LP', name: 'Eye Bolt (Fixed)', qty: 2 },
    ]);
  });
  it('rejects the whole description if any segment does not read cleanly', () => {
    expect(parseKitDescription('2× Bolt (6820H-LA) · some loose text')).toBeNull();
    expect(parseKitDescription('All mounting hardware for this structure — 450 pieces')).toBeNull();
    expect(parseKitDescription('')).toBeNull();
  });
});

describe('proposalHardwareQty', () => {
  it('counts non-optional 6820* product lines, not the kit or optional lines', () => {
    expect(
      proposalHardwareQty([
        eyeBolts,
        { ...eyeBolts, quantity: 2 },
        { sku: '6820H-LDD', quantity: 4, optional: true },
        { sku: 'H-1000', quantity: 1 },
        { sku: 'A-2245', quantity: 3 },
        { sku: '6820H-LS', lineType: 'NOTE', quantity: 1 },
      ]),
    ).toEqual({ '6820H-LP': 16 });
  });
});
