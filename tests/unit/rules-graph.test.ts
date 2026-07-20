import { describe, it, expect } from 'vitest';
import { findCycle, buildDependencyEdges, assertNoCycles } from '../../src/rules/graph.js';
import type { RuleDef } from '../../src/rules/types.js';

describe('dependency cycle prevention', () => {
  it('detects a direct cycle', () => {
    expect(findCycle([['A', 'B'], ['B', 'A']])).not.toBeNull();
  });
  it('detects a transitive cycle', () => {
    expect(findCycle([['A', 'B'], ['B', 'C'], ['C', 'A']])).not.toBeNull();
  });
  it('passes an acyclic graph', () => {
    expect(findCycle([['A', 'B'], ['B', 'C'], ['A', 'C']])).toBeNull();
  });

  it('builds edges from REQUIRES and AUTO_INCLUDE rules', () => {
    const rules: RuleDef[] = [
      { id: 'r1', version: 1, type: 'REQUIRES', outcome: 'BLOCK', target: { productId: 'A' }, params: { productId: 'B' } },
      { id: 'r2', version: 1, type: 'AUTO_INCLUDE_COMPONENT', outcome: 'AUTO_ADD', target: { productId: 'B' }, params: { componentProductId: 'A' } },
    ];
    // A -> B -> A is a cycle.
    expect(buildDependencyEdges(rules)).toEqual([['A', 'B'], ['B', 'A']]);
    expect(() => assertNoCycles(rules)).toThrow(/Circular/);
  });

  it('allows a valid dependency chain', () => {
    const rules: RuleDef[] = [
      { id: 'r1', version: 1, type: 'REQUIRES', outcome: 'BLOCK', target: { productId: 'A' }, params: { productId: 'B' } },
      { id: 'r2', version: 1, type: 'AUTO_INCLUDE_COMPONENT', outcome: 'AUTO_ADD', target: { productId: 'B' }, params: { componentProductId: 'C' } },
    ];
    expect(() => assertNoCycles(rules)).not.toThrow();
  });
});
