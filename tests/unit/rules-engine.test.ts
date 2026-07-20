import { describe, it, expect } from 'vitest';
import { evaluateConfiguration } from '../../src/rules/engine.js';
import type { RuleDef, Configuration } from '../../src/rules/types.js';

// Helper to build a single-rule evaluation.
function evalOne(rule: Partial<RuleDef> & Pick<RuleDef, 'type' | 'outcome'>, config: Configuration) {
  const full: RuleDef = { id: 'r1', version: 1, target: {}, params: {}, ...rule };
  return evaluateConfiguration([full], config);
}
const line = (productId: string, quantity = 1, extra: Record<string, unknown> = {}) => ({ productId, quantity, ...extra });

describe('rules engine — one test per rule type', () => {
  it('REQUIRES: blocks when required product absent, passes when present', () => {
    const rule = { type: 'REQUIRES' as const, outcome: 'BLOCK' as const, target: { productId: 'A' }, params: { productId: 'B' } };
    expect(evalOne(rule, { lines: [line('A')] }).blocked).toBe(true);
    expect(evalOne(rule, { lines: [line('A'), line('B')] }).blocked).toBe(false);
  });

  it('EXCLUDES: blocks when both present', () => {
    const rule = { type: 'EXCLUDES' as const, outcome: 'BLOCK' as const, target: { productId: 'A' }, params: { productId: 'B' } };
    expect(evalOne(rule, { lines: [line('A'), line('B')] }).blocked).toBe(true);
    expect(evalOne(rule, { lines: [line('A')] }).blocked).toBe(false);
  });

  it('COMPATIBLE_WITH: emits an ALLOW confirmation when paired', () => {
    const rule = { type: 'COMPATIBLE_WITH' as const, outcome: 'ALLOW' as const, target: { productId: 'A' }, params: { productId: 'B' } };
    const res = evalOne(rule, { lines: [line('A'), line('B')] });
    expect(res.findings[0].outcome).toBe('ALLOW');
    expect(res.blocked).toBe(false);
  });

  it('INCOMPATIBLE_WITH: warns when both present', () => {
    const rule = { type: 'INCOMPATIBLE_WITH' as const, outcome: 'WARN' as const, target: { productId: 'A' }, params: { productId: 'B' } };
    const res = evalOne(rule, { lines: [line('A'), line('B')] });
    expect(res.findings[0].outcome).toBe('WARN');
  });

  it('MIN_QUANTITY / MAX_QUANTITY', () => {
    const min = { type: 'MIN_QUANTITY' as const, outcome: 'BLOCK' as const, target: { productId: 'A' }, params: { min: 3 } };
    expect(evalOne(min, { lines: [line('A', 2)] }).blocked).toBe(true);
    expect(evalOne(min, { lines: [line('A', 3)] }).blocked).toBe(false);
    const max = { type: 'MAX_QUANTITY' as const, outcome: 'BLOCK' as const, target: { productId: 'A' }, params: { max: 5 } };
    expect(evalOne(max, { lines: [line('A', 6)] }).blocked).toBe(true);
  });

  it('MIN_ROOM_DIMENSIONS: requests info when missing, blocks when too small', () => {
    const rule = { type: 'MIN_ROOM_DIMENSIONS' as const, outcome: 'BLOCK' as const, target: { productId: 'A' }, params: { minLengthIn: 120, minWidthIn: 100 } };
    expect(evalOne(rule, { lines: [line('A')] }).requests.length).toBe(1);
    expect(evalOne(rule, { lines: [line('A')], context: { room: { lengthIn: 100, widthIn: 100 } } }).blocked).toBe(true);
    expect(evalOne(rule, { lines: [line('A')], context: { room: { lengthIn: 120, widthIn: 100 } } }).blocked).toBe(false);
  });

  it('MIN_CEILING_HEIGHT: requests info then blocks', () => {
    const rule = { type: 'MIN_CEILING_HEIGHT' as const, outcome: 'BLOCK' as const, target: { productId: 'A' }, params: { minCeilingHeightIn: 108 } };
    expect(evalOne(rule, { lines: [line('A')] }).requests.length).toBe(1);
    expect(evalOne(rule, { lines: [line('A')], context: { room: { ceilingHeightIn: 96 } } }).blocked).toBe(true);
  });

  it('CLEARANCE: requests info then warns', () => {
    const rule = { type: 'CLEARANCE' as const, outcome: 'WARN' as const, target: { productId: 'A' }, params: { minClearanceIn: 24 } };
    expect(evalOne(rule, { lines: [line('A')] }).requests.length).toBe(1);
    expect(evalOne(rule, { lines: [line('A')], context: { room: { clearanceIn: 12 } } }).findings[0].outcome).toBe('WARN');
  });

  it('STRUCTURAL/INSTALLATION/FREIGHT: request info when fact missing; no assumption made', () => {
    const rule = { type: 'STRUCTURAL' as const, outcome: 'REQUIRE_APPROVAL' as const, target: { productId: 'A' }, params: { factKey: 'wallRated', expected: true } };
    // Missing fact -> REQUEST_INFORMATION, NOT a pass and NOT an approval.
    const missing = evalOne(rule, { lines: [line('A')] });
    expect(missing.requests.length).toBe(1);
    expect(missing.approvals.length).toBe(0);
    // Fact present but wrong -> the rule's outcome (approval).
    const wrong = evalOne(rule, { lines: [line('A')], context: { facts: { wallRated: false } } });
    expect(wrong.approvals.length).toBe(1);
    // Fact present and correct -> nothing fires.
    const ok = evalOne(rule, { lines: [line('A')], context: { facts: { wallRated: true } } });
    expect(ok.findings.length).toBe(0);
  });

  it('AUTO_INCLUDE_COMPONENT: auto-adds per unit', () => {
    const rule = { type: 'AUTO_INCLUDE_COMPONENT' as const, outcome: 'AUTO_ADD' as const, target: { productId: 'A' }, params: { componentProductId: 'MNT', perUnit: 2 } };
    const res = evalOne(rule, { lines: [line('A', 3)] });
    expect(res.autoAdds).toEqual([{ productId: 'MNT', quantity: 6, sources: [{ ruleId: 'r1', ruleVersion: 1 }] }]);
  });

  it('AUTO_CALCULATED_COMPONENT: integer ceil, no float drift', () => {
    const rule = { type: 'AUTO_CALCULATED_COMPONENT' as const, outcome: 'AUTO_ADD' as const, target: { productId: 'A' }, params: { componentProductId: 'BOLT', ratioNum: 1, ratioDen: 3 } };
    // 7 units * 1/3 -> ceil = 3
    expect(evalOne(rule, { lines: [line('A', 7)] }).autoAdds[0].quantity).toBe(3);
  });

  it('SUGGESTED_ACCESSORY / SUGGESTED_UPGRADE: recommend when absent', () => {
    const acc = { type: 'SUGGESTED_ACCESSORY' as const, outcome: 'RECOMMEND' as const, target: { productId: 'A' }, params: { productId: 'ACC' } };
    expect(evalOne(acc, { lines: [line('A')] }).recommendations.length).toBe(1);
    expect(evalOne(acc, { lines: [line('A'), line('ACC')] }).recommendations.length).toBe(0);
  });

  it('APPROVAL_REQUIRED: surfaces an approval', () => {
    const rule = { type: 'APPROVAL_REQUIRED' as const, outcome: 'REQUIRE_APPROVAL' as const, target: { productId: 'A' }, approvalRole: 'SALES_MANAGER', params: {} };
    const res = evalOne(rule, { lines: [line('A')] });
    expect(res.approvals.length).toBe(1);
    expect(res.approvals[0].message).toContain('SALES_MANAGER');
  });

  it('MISSING_INFORMATION: requests info until provided', () => {
    const rule = { type: 'MISSING_INFORMATION' as const, outcome: 'REQUEST_INFORMATION' as const, target: {}, params: { infoKey: 'installDate', label: 'Install date' } };
    expect(evalOne(rule, { lines: [line('A')] }).requests.length).toBe(1);
    expect(evalOne(rule, { lines: [line('A')], context: { provided: ['installDate'] } }).requests.length).toBe(0);
  });
});

describe('rules engine — edge cases', () => {
  it('explains WHY every finding fired (non-empty message + facts)', () => {
    const rule = { type: 'REQUIRES' as const, outcome: 'BLOCK' as const, target: { productId: 'A' }, params: { productId: 'B' } };
    const f = evalOne(rule, { lines: [line('A')] }).findings[0];
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.facts).toHaveProperty('required', 'B');
  });

  it('custom message template is interpolated', () => {
    const rule = { type: 'MIN_QUANTITY' as const, outcome: 'BLOCK' as const, target: { productId: 'A' }, params: { min: 5 }, message: 'Need {min}, got {quantity}' };
    expect(evalOne(rule, { lines: [line('A', 1)] }).findings[0].message).toBe('Need 5, got 1');
  });

  it('prevents duplicate automatic additions across multiple rules', () => {
    const r1: RuleDef = { id: 'r1', version: 1, type: 'AUTO_INCLUDE_COMPONENT', outcome: 'AUTO_ADD', target: { productId: 'A' }, params: { componentProductId: 'X', perUnit: 1 } };
    const r2: RuleDef = { id: 'r2', version: 1, type: 'AUTO_INCLUDE_COMPONENT', outcome: 'AUTO_ADD', target: { productId: 'B' }, params: { componentProductId: 'X', perUnit: 3 } };
    const res = evaluateConfiguration([r1, r2], { lines: [line('A', 1), line('B', 1)] });
    expect(res.autoAdds.length).toBe(1);       // X added once
    expect(res.autoAdds[0].quantity).toBe(3);  // max of the two
    expect(res.autoAdds[0].sources.length).toBe(2);
  });

  it('never auto-adds a product already in the configuration', () => {
    const rule = { type: 'AUTO_INCLUDE_COMPONENT' as const, outcome: 'AUTO_ADD' as const, target: { productId: 'A' }, params: { componentProductId: 'X', perUnit: 1 } };
    expect(evalOne(rule, { lines: [line('A'), line('X')] }).autoAdds.length).toBe(0);
  });

  it('throws on a misconfigured threshold rather than assuming a value', () => {
    const rule: RuleDef = { id: 'r1', version: 1, type: 'MIN_CEILING_HEIGHT', outcome: 'BLOCK', target: { productId: 'A' }, params: {} };
    expect(() => evaluateConfiguration([rule], { lines: [line('A')] })).toThrow(/missing numeric param/);
  });

  it('rules applying to whole config (empty target) evaluate once', () => {
    const rule = { type: 'MISSING_INFORMATION' as const, outcome: 'REQUEST_INFORMATION' as const, target: {}, params: { infoKey: 'x' } };
    expect(evalOne(rule, { lines: [line('A'), line('B'), line('C')] }).requests.length).toBe(1);
  });

  it('rulesUsed captures every evaluated rule version (for proposal snapshots)', () => {
    const r1: RuleDef = { id: 'r1', version: 4, type: 'EXCLUDES', outcome: 'BLOCK', target: { productId: 'A' }, params: { productId: 'Z' } };
    const res = evaluateConfiguration([r1], { lines: [line('A')] });
    expect(res.rulesUsed).toEqual([{ ruleId: 'r1', version: 4 }]);
  });
});
