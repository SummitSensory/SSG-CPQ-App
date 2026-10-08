import { describe, it, expect } from 'vitest';
import { evaluateConfiguration } from '../../src/rules/engine.js';
import { findCycle, buildDependencyEdges, assertNoCycles } from '../../src/rules/graph.js';
import { validateRuleDefinition } from '../../src/rules/validation.js';
import type { RuleDef } from '../../src/rules/types.js';

/**
 * Audit: src/rules (engine, graph, validation). Edge cases outside rules-engine.test.ts:
 * zero / negative quantity, category-wide auto-includes, ratio math, self-loops and
 * rules that validate but can never fire.
 */

const rule = (over: Partial<RuleDef> & Pick<RuleDef, 'type' | 'outcome'>): RuleDef => ({
  id: over.id ?? 'r1',
  version: 1,
  target: {},
  params: {},
  ...over,
});

describe('rules engine — edge cases (PASS)', () => {
  it('AUTO_CALCULATED_COMPONENT equals exact integer ceil for every qty/ratio in a grid', () => {
    for (let qty = 0; qty <= 60; qty++)
      for (const [num, den] of [
        [1, 3],
        [2, 7],
        [5, 4],
        [3, 10],
        [7, 7],
      ] as const) {
        const r = evaluateConfiguration(
          [
            rule({
              type: 'AUTO_CALCULATED_COMPONENT',
              outcome: 'AUTO_ADD',
              target: { productId: 'A' },
              params: { componentProductId: 'C', ratioNum: num, ratioDen: den },
            }),
          ],
          { lines: [{ productId: 'A', quantity: qty }] },
        );
        const exact = Number((BigInt(qty) * BigInt(num) + BigInt(den) - 1n) / BigInt(den));
        const got = r.autoAdds.find((a) => a.productId === 'C')?.quantity ?? 0;
        expect(got, `${qty}*${num}/${den}`).toBe(exact);
      }
  });

  it('ratioDen of 0 is a configuration error, not Infinity', () => {
    expect(() =>
      evaluateConfiguration(
        [
          rule({
            type: 'AUTO_CALCULATED_COMPONENT',
            outcome: 'AUTO_ADD',
            target: { productId: 'A' },
            params: { componentProductId: 'C', ratioNum: 1, ratioDen: 0 },
          }),
        ],
        { lines: [{ productId: 'A', quantity: 3 }] },
      ),
    ).toThrow(/ratioDen/);
  });

  it('MIN_QUANTITY fires for a zero and a negative quantity', () => {
    const r = evaluateConfiguration(
      [
        rule({
          type: 'MIN_QUANTITY',
          outcome: 'BLOCK',
          target: { kind: 'K' },
          params: { min: 1 },
        }),
      ],
      {
        lines: [
          { productId: 'A', kind: 'K', quantity: 0 },
          { productId: 'B', kind: 'K', quantity: -2 },
        ],
      },
    );
    expect(r.findings.map((f) => f.subjectProductId)).toEqual(['A', 'B']);
    expect(r.blocked).toBe(true);
  });

  it('a missing room measurement is REQUEST_INFORMATION even when the rule outcome is BLOCK', () => {
    const r = evaluateConfiguration(
      [
        rule({
          type: 'MIN_CEILING_HEIGHT',
          outcome: 'BLOCK',
          target: { productId: 'A' },
          params: { minCeilingHeightIn: 120 },
        }),
      ],
      { lines: [{ productId: 'A', quantity: 1 }] },
    );
    expect(r.blocked).toBe(false);
    expect(r.requests).toHaveLength(1);
  });

  it('an empty ruleset and an empty configuration evaluate cleanly', () => {
    const r = evaluateConfiguration([], { lines: [] });
    expect(r).toMatchObject({ findings: [], autoAdds: [], blocked: false, rulesUsed: [] });
  });
});

describe('rules graph (PASS)', () => {
  it('detects a self-loop (A requires A)', () => {
    expect(findCycle([['A', 'A']])).toEqual(['A', 'A']);
  });

  it('detects a cycle that mixes REQUIRES and AUTO_INCLUDE edges', () => {
    const rules: RuleDef[] = [
      rule({
        id: 'x',
        type: 'REQUIRES',
        outcome: 'BLOCK',
        target: { productId: 'A' },
        params: { productId: 'B' },
      }),
      rule({
        id: 'y',
        type: 'AUTO_INCLUDE_COMPONENT',
        outcome: 'AUTO_ADD',
        target: { productId: 'B' },
        params: { componentProductId: 'A' },
      }),
    ];
    expect(buildDependencyEdges(rules)).toHaveLength(2);
    expect(() => assertNoCycles(rules)).toThrow(/Circular/);
  });

  it('a diamond (A→B, A→C, B→D, C→D) is not a cycle', () => {
    expect(
      findCycle([
        ['A', 'B'],
        ['A', 'C'],
        ['B', 'D'],
        ['C', 'D'],
      ]),
    ).toBeNull();
  });
});

describe('rules validation (PASS)', () => {
  it('rejects zero/negative/fractional thresholds and a mismatched outcome', () => {
    expect(
      validateRuleDefinition({
        key: 'k',
        type: 'MIN_QUANTITY',
        outcome: 'BLOCK',
        target: {},
        params: { min: 0 },
      }),
    ).not.toHaveLength(0);
    expect(
      validateRuleDefinition({
        key: 'k',
        type: 'AUTO_CALCULATED_COMPONENT',
        outcome: 'AUTO_ADD',
        target: {},
        params: { componentProductId: 'C', ratioNum: 1.5, ratioDen: 2 },
      }),
    ).not.toHaveLength(0);
    expect(
      validateRuleDefinition({
        key: 'k',
        type: 'EXCLUDES',
        outcome: 'AUTO_ADD',
        target: {},
        params: { productId: 'B' },
      }).map((e) => e.field),
    ).toContain('outcome');
  });
});

describe('rules engine — confirmed defects (it.fails)', () => {
  it.fails(
    'BUG: a category-wide AUTO_INCLUDE over two lines adds max(qty) instead of the sum',
    () => {
      // Two different frames in the "frames" category each need 1 anchor kit per unit.
      // Dedupe keeps Math.max across ALL raw adds — intended for two rules adding the
      // same part — so 2 + 3 frames come out as 3 kits rather than 5.
      const r = evaluateConfiguration(
        [
          rule({
            type: 'AUTO_INCLUDE_COMPONENT',
            outcome: 'AUTO_ADD',
            target: { categoryId: 'frames' },
            params: { componentProductId: 'ANCHOR', perUnit: 1 },
          }),
        ],
        {
          lines: [
            { productId: 'F1', categoryId: 'frames', quantity: 2 },
            { productId: 'F2', categoryId: 'frames', quantity: 3 },
          ],
        },
      );
      expect(r.autoAdds.find((a) => a.productId === 'ANCHOR')?.quantity).toBe(5);
    },
  );

  it.fails(
    'BUG: AUTO_INCLUDE_COMPONENT on a zero-quantity line emits a zero-quantity auto-add',
    () => {
      // AUTO_CALCULATED_COMPONENT guards `qty > 0`; AUTO_INCLUDE_COMPONENT does not.
      const r = evaluateConfiguration(
        [
          rule({
            type: 'AUTO_INCLUDE_COMPONENT',
            outcome: 'AUTO_ADD',
            target: { productId: 'A' },
            params: { componentProductId: 'C' },
          }),
        ],
        { lines: [{ productId: 'A', quantity: 0 }] },
      );
      expect(r.autoAdds).toHaveLength(0);
    },
  );

  it.fails(
    'BUG: validation accepts a REQUIRES rule with an empty target, which can never fire',
    () => {
      // The engine skips every subject-based rule when target is empty (`if (!subject) break`),
      // so this rule activates successfully and silently does nothing.
      const errors = validateRuleDefinition({
        key: 'needs-b',
        type: 'REQUIRES',
        outcome: 'BLOCK',
        target: {},
        params: { productId: 'B' },
      });
      const fires =
        evaluateConfiguration(
          [
            rule({
              type: 'REQUIRES',
              outcome: 'BLOCK',
              target: {},
              params: { productId: 'B' },
            }),
          ],
          { lines: [{ productId: 'A', quantity: 1 }] },
        ).findings.length > 0;
      expect(errors.length > 0 || fires).toBe(true);
    },
  );
});
