import { describe, it, expect } from 'vitest';
import { computeFloorPadding, matSku } from '../../src/proposals/matPricing.js';
import { computeAdventureProposal, explainAdventure, type AdvAnswers } from '../../src/proposals/adventureSeries.js';

const frame = (over: Partial<AdvAnswers> = {}): AdvAnswers => ({
  length: 8, width: 8, config: 'Square', legs: 4, ladders: 0, ...over,
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
    const { lines } = computeAdventureProposal(frame({ floorPadding: true, floorPadThickness: '3.25' }));
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
