import { describe, it, expect } from 'vitest';
import {
  buildContentSnapshot, computeIntegrityHash, depositFromSnapshot,
  defaultRequirements, defaultTasks, procurementFromItems,
  type AcceptedVersionLike, type PriceSnapshotLike,
} from '../../src/handoff/lock.js';

const version: AcceptedVersionLike = {
  id: 'v1', version: 2, proposalId: 'p1', status: 'ACCEPTED', frozen: true, priceSnapshotId: 'ps1',
  sections: [{ id: 's1', type: 'PRICING_TABLE', enabled: true }],
  items: [
    { ref: 'l1', productId: 'prod1', name: 'Therapy Swing', quantity: 2, kind: 'INCLUDED' },
    { ref: 'l2', productId: 'prod2', name: 'Optional Mat', quantity: 1, kind: 'OPTIONAL' },
  ],
};
const snap: PriceSnapshotLike = {
  id: 'ps1', currency: 'USD', grandTotal: 100000n,
  breakdown: { payment: { deposit: 30000, progress: 0, final: 70000 } },
};

describe('accepted-order lock helpers', () => {
  it('freezes the exact version + pricing into the content snapshot', () => {
    const s = buildContentSnapshot(version, snap);
    expect(s.proposalVersionId).toBe('v1');
    expect(s.acceptedVersion).toBe(2);
    expect(s.priceSnapshotId).toBe('ps1');
    expect(s.grandTotalMinor).toBe('100000');
    expect(s.depositDueMinor).toBe('30000');
  });

  it('derives the deposit from the frozen payment schedule', () => {
    expect(depositFromSnapshot(snap)).toBe(30000n);
    expect(depositFromSnapshot({ ...snap, breakdown: {} })).toBe(0n);
  });

  it('produces a stable integrity hash for identical content', () => {
    const a = computeIntegrityHash(buildContentSnapshot(version, snap));
    const b = computeIntegrityHash(buildContentSnapshot(version, snap));
    expect(a).toBe(b);
  });

  it('changes the integrity hash if the accepted content or total changes (drift detection)', () => {
    const base = computeIntegrityHash(buildContentSnapshot(version, snap));
    const changedTotal = computeIntegrityHash(buildContentSnapshot(version, { ...snap, grandTotal: 120000n }));
    const changedItems = computeIntegrityHash(buildContentSnapshot({ ...version, items: [] }, snap));
    expect(changedTotal).not.toBe(base);
    expect(changedItems).not.toBe(base);
  });

  it('seeds a requirement for every operational category', () => {
    const cats = defaultRequirements().map((r) => r.category);
    for (const c of ['PRODUCTION', 'CUSTOM_PRODUCT', 'SHIPPING', 'INSTALLATION', 'TRAINING', 'CUSTOMER_RESPONSIBILITY', 'FACILITY_ACCESS', 'REQUIRED_DOCUMENT']) {
      expect(cats).toContain(c);
    }
  });

  it('adds a deposit-invoice task only when a deposit is required', () => {
    expect(defaultTasks(true).some((t) => /deposit/i.test(t.title))).toBe(true);
    expect(defaultTasks(false).some((t) => /deposit/i.test(t.title))).toBe(false);
  });

  it('builds the procurement list from INCLUDED items only', () => {
    const list = procurementFromItems(version.items);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ productId: 'prod1', name: 'Therapy Swing', quantity: 2 });
  });
});
