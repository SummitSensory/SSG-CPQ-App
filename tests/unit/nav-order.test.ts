import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/**
 * public/nav-order.js — each user's own order for the left-hand tabs. The ordering
 * rules are pinned here without a browser:
 *
 *  - a saved tab the user cannot see (their role hides it, or it no longer exists)
 *    is never shown;
 *  - a tab added after the order was saved appears at its default position rather
 *    than vanishing or jumping to the end;
 *  - a malformed saved value falls back to the default order.
 */

interface NavOrder {
  DEFAULT_ORDER: string[];
  merge: (saved: unknown, present: string[]) => string[];
  defaultOrderOf: (domIds: string[]) => string[];
  moveTo: (order: string[], id: string, targetId: string, side: 'before' | 'after') => string[];
  step: (order: string[], id: string, delta: number) => string[];
}

let N: NavOrder;

beforeAll(() => {
  const src = readFileSync(join(__dirname, '..', '..', 'public', 'nav-order.js'), 'utf8');
  const window: { SSGNavOrder?: NavOrder } = {};
  vm.runInNewContext(src, { window, document: {} });
  const raw = window.SSGNavOrder!;
  // Arrays built inside the vm context have that context's Array prototype; copy them
  // out so toEqual compares contents rather than realms.
  const out = (a: string[]): string[] => Array.from(a);
  N = {
    DEFAULT_ORDER: out(raw.DEFAULT_ORDER),
    merge: (s, p) => out(raw.merge(s, p)),
    defaultOrderOf: (d) => out(raw.defaultOrderOf(d)),
    moveTo: (o, i, t, s) => out(raw.moveTo(o, i, t, s)),
    step: (o, i, d) => out(raw.step(o, i, d)),
  };
});

const ADMIN_TABS = [
  'dashboard',
  'crm',
  'catalog',
  'proposals',
  'strategic-partnerships',
  'reports',
  'insights',
  'goals',
  'orders',
  'receivables',
  'belts',
  'admin',
  'integrations',
];

describe('nav order merge', () => {
  it('no saved order is the default order', () => {
    expect(N.merge(null, ADMIN_TABS)).toEqual(ADMIN_TABS);
    expect(N.merge(undefined, ADMIN_TABS)).toEqual(ADMIN_TABS);
  });

  it('applies a saved order', () => {
    const saved = [
      'proposals',
      'crm',
      'dashboard',
      'catalog',
      ...ADMIN_TABS.slice(3).filter((t) => t !== 'proposals'),
    ];
    expect(N.merge(saved, ADMIN_TABS)).toEqual(saved);
  });

  it('drops saved tabs the user cannot see (forbidden or removed)', () => {
    // A sales rep: no Administration, no Integrations, no Receivables.
    const rep = ADMIN_TABS.filter((t) => !['admin', 'integrations', 'receivables'].includes(t));
    const saved = ['integrations', 'admin', 'proposals', 'crm', 'gone-forever', ...rep];
    const out = N.merge(saved, rep);
    expect(out).not.toContain('admin');
    expect(out).not.toContain('integrations');
    expect(out).not.toContain('gone-forever');
    expect(out.slice(0, 2)).toEqual(['proposals', 'crm']);
    expect([...out].sort()).toEqual([...rep].sort());
  });

  it('puts a tab added after the order was saved at its default position', () => {
    // Saved before Insights and Goals existed, with Reports moved to the top.
    const saved = ['reports', 'dashboard', 'crm', 'catalog', 'proposals', 'orders', 'belts'];
    const present = [
      'dashboard',
      'crm',
      'catalog',
      'proposals',
      'reports',
      'insights',
      'goals',
      'orders',
      'belts',
    ];
    // Insights and Goals follow Reports, which is where they sit by default.
    expect(N.merge(saved, present)).toEqual([
      'reports',
      'insights',
      'goals',
      'dashboard',
      'crm',
      'catalog',
      'proposals',
      'orders',
      'belts',
    ]);
  });

  it('a new tab that is first by default goes first', () => {
    expect(N.merge(['crm', 'catalog'], ['brand-new', 'crm', 'catalog'])).toEqual([
      'brand-new',
      'crm',
      'catalog',
    ]);
  });

  it('ignores junk in a saved value: duplicates, non-strings, a non-array', () => {
    expect(N.merge(['crm', 'crm', 7, null, 'dashboard'], ['dashboard', 'crm'])).toEqual([
      'crm',
      'dashboard',
    ]);
    expect(N.merge('crm,dashboard', ['dashboard', 'crm'])).toEqual(['dashboard', 'crm']);
    expect(N.merge({ crm: 1 }, ['dashboard', 'crm'])).toEqual(['dashboard', 'crm']);
  });

  it('every present tab appears exactly once, whatever was saved', () => {
    const saved = ['belts', 'nope', 'crm', 'belts', 'admin'];
    const out = N.merge(saved, ADMIN_TABS);
    expect(out).toHaveLength(ADMIN_TABS.length);
    expect(new Set(out).size).toBe(ADMIN_TABS.length);
  });
});

describe('default order', () => {
  it('restores the default order from a reordered sidebar', () => {
    const shuffled = [...ADMIN_TABS].reverse();
    expect(N.defaultOrderOf(shuffled)).toEqual(ADMIN_TABS);
  });

  it('keeps a plugin tab it does not know next to the tab it was installed beside', () => {
    expect(N.defaultOrderOf(['crm', 'dashboard', 'proposals', 'new-plugin', 'catalog'])).toEqual([
      'dashboard',
      'crm',
      'catalog',
      'proposals',
      'new-plugin',
    ]);
  });
});

describe('moving tabs', () => {
  const order = ['dashboard', 'crm', 'catalog', 'proposals'];

  it('drops a dragged tab before or after its target', () => {
    expect(N.moveTo(order, 'proposals', 'dashboard', 'before')).toEqual([
      'proposals',
      'dashboard',
      'crm',
      'catalog',
    ]);
    expect(N.moveTo(order, 'dashboard', 'catalog', 'after')).toEqual([
      'crm',
      'catalog',
      'dashboard',
      'proposals',
    ]);
  });

  it('moves one place up or down, and stops at the ends', () => {
    expect(N.step(order, 'crm', -1)).toEqual(['crm', 'dashboard', 'catalog', 'proposals']);
    expect(N.step(order, 'crm', 1)).toEqual(['dashboard', 'catalog', 'crm', 'proposals']);
    expect(N.step(order, 'dashboard', -1)).toEqual(order);
    expect(N.step(order, 'proposals', 1)).toEqual(order);
  });

  it('never mutates the order it was given', () => {
    const copy = [...order];
    N.moveTo(order, 'crm', 'proposals', 'after');
    N.step(order, 'crm', 1);
    expect(order).toEqual(copy);
  });
});
