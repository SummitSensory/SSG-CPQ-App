import type { RuleDef } from './types.js';

/**
 * Rules that create dependency edges between products: REQUIRES and
 * AUTO_INCLUDE_COMPONENT / AUTO_CALCULATED_COMPONENT all mean "if A, then B".
 * A cycle among these would loop forever during auto-inclusion, so we reject it.
 */
export function buildDependencyEdges(rules: RuleDef[]): Array<[string, string]> {
  const edges: Array<[string, string]> = [];
  for (const r of rules) {
    const from = r.target.productId;
    if (!from) continue;
    if (r.type === 'REQUIRES') {
      const to = String(r.params.productId ?? '');
      if (to) edges.push([from, to]);
    } else if (r.type === 'AUTO_INCLUDE_COMPONENT' || r.type === 'AUTO_CALCULATED_COMPONENT') {
      const to = String(r.params.componentProductId ?? '');
      if (to) edges.push([from, to]);
    }
  }
  return edges;
}

/** Return one cycle (list of node ids) if the directed graph has any, else null. */
export function findCycle(edges: Array<[string, string]>): string[] | null {
  const adj = new Map<string, string[]>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push(b);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const nodes = new Set<string>();
  for (const [a, b] of edges) { nodes.add(a); nodes.add(b); }

  function dfs(node: string): string[] | null {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const idx = stack.indexOf(next);
        return stack.slice(idx).concat(next);
      }
      if (c === WHITE) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  }

  for (const n of nodes) {
    if ((color.get(n) ?? WHITE) === WHITE) {
      const cycle = dfs(n);
      if (cycle) return cycle;
    }
  }
  return null;
}

/** Throw-friendly check used before activating a rule. */
export function assertNoCycles(rules: RuleDef[]): void {
  const cycle = findCycle(buildDependencyEdges(rules));
  if (cycle) {
    throw new Error(`Circular product dependency detected: ${cycle.join(' -> ')}`);
  }
}
