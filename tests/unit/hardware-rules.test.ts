import { describe, it, expect } from 'vitest';
import { hardwareBOM, type AdvAnswers } from '../../src/proposals/adventureSeries.js';
import { DEFAULT_HARDWARE_RULES, mergeHardwareRules, type HardwareRule } from '../../src/proposals/hardwareRules.js';

// A 10' × 10' square, 4 legs, one ladder, 4 saddle brackets (2 swivel), one V-ring
// 10-pack, no trolley or zip line. Frame BOM: A-2245 3, A-2246 1, A-2242 4,
// P-2531 1, A-2253 1, P-2330 5, P-2028 8, P-2124 4.
const answers: AdvAnswers = {
  length: 10, width: 10, config: 'Square', legs: 4, ladders: 1,
  brackets: true, bracketsQty: 4, swivel360: 2, forged: 0, swingHanger: 0, vRings: 1,
};

const qtyOf = (part: string, rules?: HardwareRule[]): number =>
  (hardwareBOM(answers, rules).find((r) => r.part === part) || { qty: 0 }).qty;

describe('hardware quantity rules (workbook defaults)', () => {
  it('reproduces the v73 fastener counts', () => {
    expect(qtyOf('6820H-LAK')).toBe(17); // ceil((A-2245 3 + A-2246 1) × 4 + 1)
    expect(qtyOf('6820H-LAC-G')).toBe(2); // brackets 4 − swivel 2
    expect(qtyOf('6820H-LA')).toBe(26); // A-2242 4×6 + A-2253 1×2
    expect(qtyOf('6820H-LC')).toBe(28); // ceil(26 × 1.02) to a multiple of 2
    expect(qtyOf('6820H-LB')).toBe(58); // ceil((26 × 2) × 1.1)
    expect(qtyOf('6820H-LF')).toBe(15); // ceil((P-2124 4 + LAF 10) × 1.05)
    expect(qtyOf('6820H-LM')).toBe(41); // ceil((5×2 + 10×2 + 4) × 1.2)
    expect(qtyOf('6820H-LAH')).toBe(12); // P-2531 1×10 + A-2253 1×2
    expect(qtyOf('6820H-LAF')).toBe(10); // V-ring packs 1 × 10
  });

  it('omits the parts the workbook hard-zeroes', () => {
    for (const part of ['6820H-LAG', '6820H-LH', '6820H-LN']) expect(qtyOf(part)).toBe(0);
  });

  it('resolves rows that depend on other rows in any declaration order', () => {
    // LC depends on LA, which is declared after it in the rule list.
    const laIndex = DEFAULT_HARDWARE_RULES.findIndex((r) => r.part === '6820H-LA');
    const lcIndex = DEFAULT_HARDWARE_RULES.findIndex((r) => r.part === '6820H-LC');
    expect(lcIndex).toBeLessThan(laIndex);
    expect(qtyOf('6820H-LC')).toBeGreaterThan(0);
  });
});

describe('database overrides', () => {
  it('applies an edited coefficient without touching the other rules', () => {
    const rules = mergeHardwareRules([
      { part: '6820H-LAK', name: '1/2" × 4" Titen HD Screw Anchor, Zinc', terms: [{ source: 'bom:A-2245', coefficient: 5 }, { source: 'bom:A-2246', coefficient: 5 }], constant: 1, factor: 1, roundMode: 'CEIL', roundStep: 1, mode: 'SUM', minZero: true, active: true },
    ]);
    expect(qtyOf('6820H-LAK', rules)).toBe(21); // ceil(4 × 5 + 1)
    expect(qtyOf('6820H-LA', rules)).toBe(26); // untouched
  });

  it('switching a rule off removes the fastener', () => {
    const rules = mergeHardwareRules([{ part: '6820H-LAH', active: false }]);
    expect(qtyOf('6820H-LAH', rules)).toBe(0);
  });

  it('falls back to the workbook defaults when nothing is overridden', () => {
    expect(mergeHardwareRules([])).toBe(DEFAULT_HARDWARE_RULES);
    expect(mergeHardwareRules(null)).toBe(DEFAULT_HARDWARE_RULES);
  });
});
