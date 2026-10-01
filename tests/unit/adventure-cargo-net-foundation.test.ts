import { describe, it, expect } from 'vitest';
import {
  computeAdventureProposal,
  explainAdventure,
  cargoNetForFrame,
  type AdvAnswers,
} from '../../src/proposals/adventureSeries.js';
import { frameContext } from '../../src/proposals/frameRules.js';

/**
 * The cargo net follows the frame (width and ladders), and the Summit Foundation
 * System prices its tiles and border ramps by the quantities answered.
 */

const NET_10X8 = 'B07V3J9S2R';
const NET_8X8 = 'B09NNFJLGY';
const NET_8X6 = 'B07TSDMPNQ';

const frame = (over: Partial<AdvAnswers> = {}): AdvAnswers => ({
  length: 12,
  width: 10,
  config: 'Rectangle',
  legs: 6,
  ladders: 0,
  ...over,
});

const netLines = (a: AdvAnswers) =>
  computeAdventureProposal(a).lines.filter((l) =>
    [NET_10X8, NET_8X8, NET_8X6].includes(l.sku ?? ''),
  );

describe('cargoNetForFrame', () => {
  it.each([
    [10, 0, NET_10X8],
    [9, 0, NET_10X8],
    [10, 1, NET_8X8],
    [9, 3, NET_8X8],
    [8, 0, NET_8X8],
    [6, 0, NET_8X8],
    [8, 1, NET_8X6],
    [6, 2, NET_8X6],
  ])("a %i' wide frame with %i ladder(s) takes %s", (width, ladders, part) => {
    expect(cargoNetForFrame(width, ladders)).toBe(part);
  });

  it('has no rule for a frame wider than 10 feet', () => {
    expect(cargoNetForFrame(11, 0)).toBeNull();
    expect(cargoNetForFrame(20, 2)).toBeNull();
  });
});

describe('the cargo net on the proposal', () => {
  it("proposes the frame's net, at the quantity answered, under Cargo Net", () => {
    const { lines } = computeAdventureProposal(
      frame({ ladders: 1, cargoNet: true, cargoNetQty: 2 }),
    );
    const net = lines.find((l) => l.sku === NET_8X8);
    expect(net).toMatchObject({ quantity: 2, needsPrice: false });
    expect(net!.rateMinor).toBe(37514);
    const i = lines.indexOf(net!);
    const heading = lines
      .slice(0, i)
      .reverse()
      .find((l) => l.lineType === 'SUBGROUP');
    expect(heading?.name).toBe('Cargo Net');
    // The net still brings its own fixings.
    expect(lines.find((l) => l.sku === 'B0937DRYYF')?.quantity).toBe(1);
    expect(lines.find((l) => l.sku === 'B07MB985GW')?.quantity).toBe(2);
  });

  it('ignores a stale rep pick when the frame has a rule', () => {
    expect(
      netLines(frame({ width: 8, cargoNet: true, cargoNetQty: 1, cargoNetPart: NET_10X8 })),
    ).toEqual([expect.objectContaining({ sku: NET_8X8, quantity: 1 })]);
  });

  it("uses the rep's pick on a frame wider than 10', and nothing without one", () => {
    expect(
      netLines(frame({ width: 12, cargoNet: true, cargoNetQty: 1, cargoNetPart: NET_8X6 })),
    ).toEqual([expect.objectContaining({ sku: NET_8X6 })]);
    expect(netLines(frame({ width: 12, cargoNet: true, cargoNetQty: 1 }))).toEqual([]);
    expect(
      netLines(frame({ width: 12, cargoNet: true, cargoNetQty: 1, cargoNetPart: 'NOT-A-NET' })),
    ).toEqual([]);
  });

  it('prices a proposal saved before the rule exactly as it was quoted', () => {
    // An 8' frame would now take the 8x8, but these answers ticked both sizes by hand.
    const lines = netLines(
      frame({
        width: 8,
        cargoNet: true,
        cargoNet10x8: true,
        cargoNet10x8Qty: 1,
        cargoNet8x6: true,
        cargoNet8x6Qty: 2,
      }),
    );
    expect(lines.map((l) => [l.sku, l.quantity])).toEqual([
      [NET_10X8, 1],
      [NET_8X6, 2],
    ]);
  });

  it('feeds the frame rules one net count per size', () => {
    const ctx = frameContext(
      frame({ width: 10, ladders: 2, cargoNet: true, cargoNetQty: 3 }),
      () => 0,
    );
    expect(ctx.input('cargoNet8x8')).toBe(3);
    expect(ctx.input('cargoNet10x8')).toBe(0);
    expect(ctx.input('cargoNet8x6')).toBe(0);
  });

  it('traces the chosen net once, saying why', () => {
    const t = explainAdventure(frame({ ladders: 1, cargoNet: true, cargoNetQty: 1 }));
    const rows = t.rows.filter((r) => r.part === NET_8X8);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.qty).toBe(1);
    expect(rows[0]?.formula).toMatch(/10' wide, 1 ladder/);
  });

  it('traces a net saved before the rule once, not twice', () => {
    const t = explainAdventure(frame({ cargoNet: true, cargoNet10x8: true, cargoNet10x8Qty: 1 }));
    expect(t.rows.filter((r) => r.part === NET_10X8)).toHaveLength(1);
  });
});

describe('Summit Foundation System', () => {
  it('prints tiles and border ramps at the quantities answered, under their own heading', () => {
    const { lines } = computeAdventureProposal(
      frame({ foundation: true, foundationTilesQty: 24, foundationRampsQty: 6 }),
    );
    const g = lines.findIndex(
      (l) => l.lineType === 'GROUP' && l.name === 'Summit Foundation System',
    );
    expect(g).toBeGreaterThanOrEqual(0);
    const tiles = lines.find((l) => l.sku === 'GRPMAT158');
    const ramps = lines.find((l) => l.sku === 'BR158');
    expect(tiles).toMatchObject({ quantity: 24, rateMinor: 4200, needsPrice: false });
    expect(ramps).toMatchObject({ quantity: 6, rateMinor: 1860, needsPrice: false });
    expect(lines.indexOf(tiles!)).toBeGreaterThan(g);
    expect(lines.indexOf(ramps!)).toBeGreaterThan(g);
  });

  it('leaves out a part with no quantity, and the whole section when it is off', () => {
    const one = computeAdventureProposal(frame({ foundation: true, foundationTilesQty: 10 })).lines;
    expect(one.some((l) => l.sku === 'BR158')).toBe(false);
    const off = computeAdventureProposal(
      frame({ foundation: false, foundationTilesQty: 10, foundationRampsQty: 2 }),
    ).lines;
    expect(off.some((l) => l.name === 'Summit Foundation System')).toBe(false);
    expect(off.some((l) => l.sku === 'GRPMAT158' || l.sku === 'BR158')).toBe(false);
  });
});
