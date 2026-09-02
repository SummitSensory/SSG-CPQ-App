import { describe, it, expect } from 'vitest';
import {
  buildContentSnapshot,
  computeIntegrityHash,
  depositFromSnapshot,
  defaultRequirements,
  defaultTasks,
  procurementFromItems,
  type AcceptedVersionLike,
  type PriceSnapshotLike,
} from '../../src/handoff/lock.js';

const version: AcceptedVersionLike = {
  id: 'v1',
  version: 2,
  proposalId: 'p1',
  status: 'ACCEPTED',
  frozen: true,
  priceSnapshotId: 'ps1',
  sections: [{ id: 's1', type: 'PRICING_TABLE', enabled: true }],
  items: [
    { ref: 'l1', productId: 'prod1', name: 'Therapy Swing', quantity: 2, kind: 'INCLUDED' },
    { ref: 'l2', productId: 'prod2', name: 'Optional Mat', quantity: 1, kind: 'OPTIONAL' },
  ],
};
const snap: PriceSnapshotLike = {
  id: 'ps1',
  currency: 'USD',
  grandTotal: 100000n,
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
    const changedTotal = computeIntegrityHash(
      buildContentSnapshot(version, { ...snap, grandTotal: 120000n }),
    );
    const changedItems = computeIntegrityHash(
      buildContentSnapshot({ ...version, items: [] }, snap),
    );
    expect(changedTotal).not.toBe(base);
    expect(changedItems).not.toBe(base);
  });

  it('seeds a requirement for every operational category', () => {
    const cats = defaultRequirements().map((r) => r.category);
    for (const c of [
      'PRODUCTION',
      'CUSTOM_PRODUCT',
      'SHIPPING',
      'INSTALLATION',
      'TRAINING',
      'CUSTOMER_RESPONSIBILITY',
      'FACILITY_ACCESS',
      'REQUIRED_DOCUMENT',
    ]) {
      expect(cats).toContain(c);
    }
  });

  it('adds a deposit-invoice task only when a deposit is required', () => {
    expect(defaultTasks(true).some((t) => /deposit/i.test(t.title))).toBe(true);
    expect(defaultTasks(false).some((t) => /deposit/i.test(t.title))).toBe(false);
  });

  it('seeds Installation/Training by default, and drops each when told the job excludes it', () => {
    expect(defaultRequirements().map((r) => r.category)).toEqual(
      expect.arrayContaining(['INSTALLATION', 'TRAINING']),
    );
    expect(defaultTasks(false).map((t) => t.category)).toEqual(
      expect.arrayContaining(['INSTALLATION', 'TRAINING']),
    );

    const noInstall = defaultRequirements({ installation: false }).map((r) => r.category);
    expect(noInstall).not.toContain('INSTALLATION');
    expect(noInstall).toContain('TRAINING');

    const noTraining = defaultTasks(false, { training: false }).map((t) => t.category);
    expect(noTraining).not.toContain('TRAINING');
    expect(noTraining).toContain('INSTALLATION');

    const neither = defaultRequirements({ training: false, installation: false }).map(
      (r) => r.category,
    );
    expect(neither).not.toContain('INSTALLATION');
    expect(neither).not.toContain('TRAINING');
  });

  it('builds the procurement list from INCLUDED items only', () => {
    const list = procurementFromItems(version.items);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ productId: 'prod1', name: 'Therapy Swing', quantity: 2 });
  });

  it('positions each INCLUDED item by its own order, skipping past OPTIONAL/ALTERNATE ones', () => {
    const items = [
      { ref: 'l1', productId: 'p1', name: 'Frame', quantity: 1, kind: 'INCLUDED' },
      { ref: 'l2', productId: 'p2', name: 'Optional Mat', quantity: 1, kind: 'OPTIONAL' },
      { ref: 'l3', productId: 'p3', name: 'Ladder', quantity: 1, kind: 'INCLUDED' },
      { ref: 'l4', productId: 'p4', name: 'Alt Slide', quantity: 1, kind: 'ALTERNATE' },
      { ref: 'l5', productId: 'p5', name: 'Trolley', quantity: 1, kind: 'INCLUDED' },
    ];
    const list = procurementFromItems(items);
    expect(list.map((p) => [p.name, p.proposalLineOrder])).toEqual([
      ['Frame', 0],
      ['Ladder', 1],
      ['Trolley', 2],
    ]);
  });

  it('gives every fastener out of an exploded kit its kit line’s own position', () => {
    const items = [
      { ref: 'l1', productId: 'p1', name: 'Frame', quantity: 1, kind: 'INCLUDED' },
      {
        ref: 'l2',
        sku: 'H-1000',
        name: 'Hardware Kit',
        quantity: 2,
        kind: 'INCLUDED',
        components: [
          { part: '6820H-LA', name: 'Hex Bolt', qty: 4 },
          { part: '6820H-LB', name: 'Washer', qty: 8 },
        ],
      },
      { ref: 'l3', productId: 'p3', name: 'Ladder', quantity: 1, kind: 'INCLUDED' },
    ];
    const list = procurementFromItems(items);
    // Frame (position 0), the kit's two fasteners (both position 1, the kit's own
    // slot), then Ladder (position 2) — the kit itself never appears as a line.
    expect(list.map((p) => [p.sku ?? p.name, p.proposalLineOrder])).toEqual([
      ['Frame', 0],
      ['6820H-LA', 1],
      ['6820H-LB', 1],
      ['Ladder', 2],
    ]);
    expect(list.filter((p) => p.isHardwareComponent)).toHaveLength(2);
  });
});
