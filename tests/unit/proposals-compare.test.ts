import { describe, it, expect } from 'vitest';
import { compareVersions, type VersionSnapshot } from '../../src/proposals/compare.js';
import type { ProposalSection, ProposalItem } from '../../src/proposals/sections.js';

const sec = (id: string, over: Partial<ProposalSection> = {}): ProposalSection => ({
  id, type: 'EXECUTIVE_SUMMARY', title: id, order: 0, enabled: true, ...over,
});
const item = (ref: string, qty: number): ProposalItem => ({ ref, productId: 'p-' + ref, name: ref, kind: 'INCLUDED', quantity: qty });

describe('proposal version comparison', () => {
  it('detects added, removed and changed items', () => {
    const a: VersionSnapshot = { sections: [], items: [item('L1', 1), item('L2', 2)] };
    const b: VersionSnapshot = { sections: [], items: [item('L1', 3), item('L3', 1)] };
    const diff = compareVersions(a, b);
    const byPath = Object.fromEntries(diff.items.map((d) => [d.path, d.kind]));
    expect(byPath['item:L1']).toBe('changed'); // qty 1 -> 3
    expect(byPath['item:L2']).toBe('removed');
    expect(byPath['item:L3']).toBe('added');
  });

  it('detects section text changes', () => {
    const a: VersionSnapshot = { sections: [sec('s1', { body: 'old' })], items: [] };
    const b: VersionSnapshot = { sections: [sec('s1', { body: 'new' })], items: [] };
    expect(compareVersions(a, b).sections[0]).toMatchObject({ path: 'section:s1', kind: 'changed' });
  });

  it('reports meta changes (price snapshot, expiration)', () => {
    const a: VersionSnapshot = { sections: [], items: [], priceSnapshotId: 'ps1', expirationDate: '2026-01-01' };
    const b: VersionSnapshot = { sections: [], items: [], priceSnapshotId: 'ps2', expirationDate: '2026-02-01' };
    const paths = compareVersions(a, b).meta.map((m) => m.path);
    expect(paths).toContain('priceSnapshotId');
    expect(paths).toContain('expirationDate');
  });

  it('reports no differences for identical versions', () => {
    const v: VersionSnapshot = { sections: [sec('s1')], items: [item('L1', 1)], priceSnapshotId: 'ps1' };
    const diff = compareVersions(v, v);
    expect(diff.sections).toHaveLength(0);
    expect(diff.items).toHaveLength(0);
    expect(diff.meta).toHaveLength(0);
  });
});
