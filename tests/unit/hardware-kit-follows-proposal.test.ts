import { describe, it, expect } from 'vitest';
import {
  ACCESSORY_HW_PARTS,
  V_RING_PART,
  computeAdventureProposal,
  hardwareRollup,
  proposalLineQty,
  proposalQuantities,
  type AdvAnswers,
} from '../../src/proposals/adventureSeries';

/**
 * The H-1000 kit follows the lines on the proposal: delete a part and its fasteners
 * leave the kit; add one and they join it. Before, the kit read the configurator's
 * own counts, so a trolley deleted from the proposal kept its bolts in the kit.
 */

const answers: AdvAnswers = {
  length: 10,
  width: 10,
  config: 'Square',
  legs: 4,
  ladders: 1,
  monkeyBars: true,
  trolley: true,
  trolleyType: 'Dual',
  zipLine: true,
  zipLineQty: 1,
  brackets: true,
  bracketsQty: 4,
  swivel360: 2,
  forged: 2,
  swingHanger: 1,
  cargoNet: true,
  cargoNetQty: 1,
};

type Line = { lineType: string; sku?: string; quantity?: number };
const generated = (): Line[] => computeAdventureProposal(answers).lines as Line[];
const printed = generated().map((l) => l.sku || '');

/** The kit, worked out from these proposal lines. */
const kit = (lines: Line[], a: AdvAnswers = answers) =>
  hardwareRollup(
    a,
    {},
    undefined,
    undefined,
    ACCESSORY_HW_PARTS,
    undefined,
    proposalQuantities(a, proposalLineQty(lines), printed),
  );
const qtyIn = (k: ReturnType<typeof kit>, part: string) =>
  k.components.find((c) => c.part === part)?.qty ?? 0;
const without = (lines: Line[], sku: string) => lines.filter((l) => l.sku !== sku);
const withQty = (lines: Line[], sku: string, quantity: number) =>
  lines.map((l) => (l.sku === sku ? { ...l, quantity } : l));

describe('H-1000 follows the proposal', () => {
  it('matches the configurator exactly while the proposal is as generated', () => {
    const byConfigurator = hardwareRollup(answers, {}, undefined, undefined, ACCESSORY_HW_PARTS);
    expect(kit(generated()).components.map((c) => [c.part, c.qty])).toEqual(
      byConfigurator.components.map((c) => [c.part, c.qty]),
    );
  });

  it('drops the trolley’s fasteners when the trolley is deleted', () => {
    const before = kit(generated());
    expect(qtyIn(before, '6820H-LY')).toBeGreaterThan(0);
    const after = kit(without(generated(), 'P-2018'));
    expect(qtyIn(after, '6820H-LY')).toBe(0);
    expect(qtyIn(after, '6820H-LX')).toBe(0);
  });

  it('adds anchors when a frame part’s quantity is raised by hand', () => {
    const lines = generated();
    const legs = lines.find((l) => l.sku === 'A-2245')!.quantity!;
    expect(qtyIn(kit(withQty(lines, 'A-2245', legs + 2)), '6820H-LAK')).toBeGreaterThan(
      qtyIn(kit(lines), '6820H-LAK'),
    );
  });

  it('takes an eye bolt’s nuts and washers with it when its line is deleted', () => {
    const lines = generated();
    expect(lines.some((l) => l.sku === '6820H-LP')).toBe(true);
    const before = kit(lines);
    const after = kit(without(lines, '6820H-LP'));
    expect(qtyIn(after, '6820H-LC')).toBeLessThan(qtyIn(before, '6820H-LC'));
    expect(qtyIn(after, '6820H-LB')).toBeLessThan(qtyIn(before, '6820H-LB'));
    // The eye bolts themselves still print as their own line, never in the kit.
    expect(qtyIn(before, '6820H-LP')).toBe(0);
  });

  it('adds an eye bolt’s nuts when more eye bolts are put on the proposal', () => {
    const lines = generated();
    const eye = lines.find((l) => l.sku === '6820H-LP')!.quantity!;
    expect(qtyIn(kit(withQty(lines, '6820H-LP', eye + 10)), '6820H-LC')).toBeGreaterThan(
      qtyIn(kit(lines), '6820H-LC'),
    );
  });

  it('drops the V-ring bolts when the cargo net’s V-rings are deleted', () => {
    const lines = generated();
    expect(lines.some((l) => l.sku === V_RING_PART)).toBe(true);
    expect(qtyIn(kit(lines), '6820H-LAE')).toBeGreaterThan(0);
    const after = kit(without(lines, V_RING_PART));
    expect(qtyIn(after, '6820H-LAE')).toBe(0);
    expect(qtyIn(after, '6820H-LAF')).toBe(0);
  });

  it('counts every line of a part, optional ones included', () => {
    const lines = generated();
    const legs = lines.find((l) => l.sku === 'A-2245')!.quantity!;
    const split = [
      ...withQty(lines, 'A-2245', legs - 1),
      { lineType: 'PRODUCT', sku: 'a-2245', quantity: 1, optional: true },
    ];
    expect(qtyIn(kit(split), '6820H-LAK')).toBe(qtyIn(kit(lines), '6820H-LAK'));
  });
});

describe('proposalQuantities', () => {
  it('leaves a part the proposal never shows to the configurator', () => {
    const q = proposalQuantities(answers, { 'A-2245': 3 }, ['A-2245']);
    expect(q('A-2245')).toBe(3);
    expect(q('A-9999')).toBeUndefined();
  });

  it('reads a printed part that was deleted as 0', () => {
    expect(proposalQuantities(answers, {}, ['P-2018'])('P-2018')).toBe(0);
  });

  it('counts a substitute’s line for the part it stands in for', () => {
    const a = { ...answers, partOverrides: { 'A-2245': 'A-2245-ALT' } };
    expect(proposalQuantities(a, { 'A-2245-ALT': 3 }, ['A-2245-ALT'])('A-2245')).toBe(3);
  });

  it('sums lines by part, skipping the kit, notes and empty quantities', () => {
    expect(
      proposalLineQty([
        { lineType: 'PRODUCT', sku: 'p-2018', quantity: 2 },
        { lineType: 'PRODUCT', sku: 'P-2018', quantity: 1 },
        { lineType: 'PRODUCT', sku: 'H-1000', quantity: 1 },
        { lineType: 'NOTE', sku: 'X', quantity: 1 },
        { lineType: 'PRODUCT', sku: 'Y', quantity: 0 },
      ]),
    ).toEqual({ 'P-2018': 3 });
  });
});
