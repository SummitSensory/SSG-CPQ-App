import { describe, it, expect } from 'vitest';
import { computeFloorPadding, matSku } from '../../src/proposals/matPricing.js';
import {
  computeAdventureProposal,
  explainAdventure,
  type AdvAnswers,
} from '../../src/proposals/adventureSeries.js';

const frame = (over: Partial<AdvAnswers> = {}): AdvAnswers => ({
  length: 8,
  width: 8,
  config: 'Square',
  legs: 4,
  ladders: 0,
  ...over,
});

describe('floor padding pricing', () => {
  it('matches the worked 8ft x 8ft x 3.25in example', () => {
    const q = computeFloorPadding(8, 8, '3.25');
    expect(q.matLengthIn).toBe(110);
    expect(q.matWidthIn).toBe(110);
    expect(q.squareInches).toBe(12100);
    expect(q.squareFeet).toBe(84.03);
    expect(q.costMinor).toBe(98985); // 84.0277… × $11.78
    expect(q.priceMinor).toBe(138579); // × 1.4
    expect(q.sku).toBe('R-SSG-0808CLM');
  });

  it('prices the 2in option off the same square footage', () => {
    const q = computeFloorPadding(8, 8, '2');
    expect(q.costMinor).toBe(64281); // 84.0277… × $7.65
    expect(q.priceMinor).toBe(89993);
    expect(q.sku).toBe('R-SSG-0808CLM-2');
  });

  it('reproduces the published 10ft x 10ft price', () => {
    expect(computeFloorPadding(10, 10, '3.25').priceMinor).toBe(205646);
    expect(computeFloorPadding(10, 10, '2').priceMinor).toBe(133547);
  });

  it('pads the SKU dimensions to two digits each, length first', () => {
    expect(matSku(10, 8, '3.25')).toBe('R-SSG-1008CLM');
    expect(matSku(20, 10, '2')).toBe('R-SSG-2010CLM-2');
  });
});

describe('floor padding on the proposal', () => {
  it('emits a priced mat line under the mat system group', () => {
    const { lines } = computeAdventureProposal(
      frame({ floorPadding: true, floorPadThickness: '3.25' }),
    );
    const mat = lines.find((l) => l.sku === 'R-SSG-0808CLM');
    expect(mat).toBeTruthy();
    expect(mat!.quantity).toBe(1);
    expect(mat!.rateMinor).toBe(138579);
    expect(mat!.costEach).toBe(98985);
    expect(mat!.needsPrice).toBeFalsy();
  });

  it('emits nothing when floor padding is declined', () => {
    const { lines } = computeAdventureProposal(frame({ floorPadding: false }));
    expect(lines.some((l) => (l.sku || '').startsWith('R-SSG-'))).toBe(false);
  });

  it('carries the mat into revenue, COGS and margin', () => {
    const off = explainAdventure(frame({ floorPadding: false })).totals;
    const on = explainAdventure(frame({ floorPadding: true, floorPadThickness: '2' })).totals;
    expect(on.revenueMinor - off.revenueMinor).toBe(89993);
    expect(on.cogsMinor - off.cogsMinor).toBe(64281);
    expect(on.marginMinor - off.marginMinor).toBe(89993 - 64281);
  });
});

describe('column wraps, ladder legs and packs price from the catalog', () => {
  it('resolves each configurator part to its catalog rate and cost', () => {
    // V-rings are no longer a Hardware quantity — they arrive with a cargo net and print
    // in that section, so the net has to be switched on for B07MB985GW to appear at all.
    const { lines } = computeAdventureProposal(
      frame({
        matColumn: true,
        uShaped: 1,
        completeWrap: 3,
        matLadderLeg: true,
        ladders: 1,
        cargoNet: true,
        cargoNet8x6: true,
        cargoNet8x6Qty: 1,
        carabiner: 2,
        webbingSling: 4,
      }),
    );
    for (const part of ['SSUSP67', 'SSCW67', 'SSUSP72', 'B07MB985GW', 'B0CDVDZSB1', '6820H-LAN']) {
      const l = lines.find((x) => x.sku === part);
      expect(l, part).toBeTruthy();
      expect(l!.rateMinor, part).toBeGreaterThan(0);
      expect(l!.needsPrice, part).toBeFalsy();
    }
    expect(lines.find((l) => l.sku === 'SSCW67')!.quantity).toBe(3);
    expect(lines.find((l) => l.sku === 'SSUSP72')!.quantity).toBe(1);
  });

  it('does not price V-rings from a bare Hardware quantity any more', () => {
    // The Hardware section no longer offers them, so an answer left on an older proposal
    // must not quietly add a line the rep cannot see or remove in the configurator.
    const { lines } = computeAdventureProposal(frame({ vRings: 2 }));
    expect(lines.some((l) => l.sku === 'B07MB985GW')).toBe(false);
  });

  it('prices the cargo net and its own fixings under Cargo Net', () => {
    const { lines } = computeAdventureProposal(
      frame({
        cargoNet: true,
        cargoNet10x8: true,
        cargoNet10x8Qty: 2,
        cargoHwCarabinerQty: 3,
        cargoHwVRingQty: 4,
      }),
    );
    const net = lines.find((l) => l.sku === 'B07V3J9S2R');
    expect(net).toBeTruthy();
    expect(net!.quantity).toBe(2);
    // The net's carabiner is the 50-pack of snap hooks, NOT the 4-pack auto-locking
    // carabiner answered under Essential Carabiners & Connectors.
    const snap = lines.find((l) => l.sku === 'B0937DRYYF');
    expect(snap).toBeTruthy();
    expect(snap!.quantity).toBe(3);
    const vring = lines.find((l) => l.sku === 'B07MB985GW');
    expect(vring).toBeTruthy();
    expect(vring!.quantity).toBe(4);
  });

  it('carries them into revenue and COGS', () => {
    const off = explainAdventure(frame()).totals;
    const on = explainAdventure(frame({ matColumn: true, uShaped: 2, completeWrap: 2 })).totals;
    expect(on.revenueMinor).toBeGreaterThan(off.revenueMinor);
  });
});
