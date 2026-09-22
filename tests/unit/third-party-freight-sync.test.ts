import { describe, it, expect, beforeEach, vi } from 'vitest';
/**
 * syncVersion's third-party step: freight-request quotes from monday staged as
 * THERAPEUTIC entries on a frozen version.
 *
 * The board is mocked at subitemFreightForProposal and the database with a small
 * in-memory FreightEntry table, so the rules are exercised end to end — what gets
 * staged, what is left alone, and what is withdrawn — without a board or Postgres.
 */
type Entry = Record<string, unknown> & { id: string; status: string; amountMinor: number };
const db = vi.hoisted(() => ({
  entries: [] as Array<
    Record<string, unknown> & { id: string; status: string; amountMinor: number }
  >,
  version: {} as Record<string, unknown>,
  board: {
    requested: true,
    skus: [] as unknown[],
    readAt: '2026-09-22T00:00:00Z',
    error: null as string | null,
  },
  seq: 0,
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    proposalVersion: {
      findUnique: async () => db.version,
      findUniqueOrThrow: async () => db.version,
    },
    opportunity: { findFirst: async () => null },
    freightTrueUp: {
      findFirst: async () => ({ id: 'tu-1' }),
      create: async () => ({ id: 'tu-1' }),
    },
    freightEntry: {
      findMany: async ({ where }: { where: { bucket?: unknown; source?: string } }) =>
        db.entries.filter(
          (e) =>
            (where.bucket === 'THERAPEUTIC' ? e.bucket === 'THERAPEUTIC' : true) &&
            (where.source ? e.source === where.source : true) &&
            e.status !== 'VOID',
        ),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `e${++db.seq}` } as Entry;
        db.entries.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = db.entries.find((e) => e.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        db.entries = db.entries.filter((e) => e.id !== where.id);
      },
    },
  },
}));
vi.mock('../../src/lib/audit.js', () => ({ recordAudit: async () => undefined }));
vi.mock('../../src/integrations/monday/subitemFreight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/monday/subitemFreight.js')>()),
  subitemFreightForProposal: async () => db.board,
}));

import { syncVersion } from '../../src/integrations/monday/freightPull.js';

const line = (ref: string, sku: string, tpFreightMinor = 0) => ({
  ref,
  sku,
  name: sku,
  lineType: 'PRODUCT',
  quantity: 1,
  tpFreightMinor,
});
const quoted = (sku: string, amountMinor: number) => ({
  sku,
  name: sku,
  state: 'QUOTED',
  amountMinor,
  vendor: 'Southpaw Enterprises',
  rfqRef: 'RFQ-1-SE',
  quoteRef: 'Q-77',
  subitemId: '555',
});

beforeEach(() => {
  db.entries = [];
  db.seq = 0;
  db.board = { requested: true, skus: [], readAt: '2026-09-22T00:00:00Z', error: null };
  db.version = {
    proposalId: 'p1',
    frozen: true,
    sections: [{ id: 'meta', data: {} }],
    proposal: { organizationId: 'org-1' },
    items: [
      line('r1', '150045'),
      line('r2', 'A-2', 5_000),
      line('r3', 'SPLIT'),
      line('r4', 'SPLIT'),
    ],
  };
});

describe('third-party freight from freight-request subitems', () => {
  it('stages a quote on an item with no freight, as a monday-sourced THERAPEUTIC entry', async () => {
    db.board.skus = [quoted('150045', 77_297)];
    const r = await syncVersion('v1', 'actor');
    expect(r.thirdParty?.staged).toEqual([
      { sku: '150045', entryId: 'e1', amountMinor: 77_297, lines: 1, changed: true },
    ]);
    expect(db.entries[0]).toMatchObject({
      bucket: 'THERAPEUTIC',
      scope: 'LINES',
      source: 'MONDAY',
      status: 'STAGED',
      amountMinor: 77_297,
      vendorQuoteRef: 'Q-77',
      mondayColumnId: 'formula_mm73ym5c',
      allocations: [{ ref: 'r1', sku: '150045', name: '150045', amountMinor: 77_297 }],
    });
  });

  it('splits one SKU across every line carrying it, summing exactly', async () => {
    db.board.skus = [quoted('SPLIT', 1_001)];
    await syncVersion('v1', 'actor');
    const alloc = db.entries[0]!.allocations as Array<{ ref: string; amountMinor: number }>;
    expect(alloc.map((a) => a.ref)).toEqual(['r3', 'r4']);
    expect(alloc.reduce((a, x) => a + x.amountMinor, 0)).toBe(1_001);
  });

  it('never stages onto a line that already carries different freight — reports it instead', async () => {
    db.board.skus = [quoted('A-2', 9_000)];
    const r = await syncVersion('v1', 'actor');
    expect(db.entries).toHaveLength(0);
    expect(r.thirdParty?.differs).toEqual([
      { sku: 'A-2', boardMinor: 9_000, onProposalMinor: 5_000 },
    ]);
  });

  it('is idempotent: a second read updates nothing and creates no duplicate', async () => {
    db.board.skus = [quoted('150045', 77_297)];
    await syncVersion('v1', 'actor');
    const r = await syncVersion('v1', 'actor');
    expect(db.entries).toHaveLength(1);
    expect(r.thirdParty?.staged[0]?.changed).toBe(false);
  });

  it('re-stages a changed quote in place', async () => {
    db.board.skus = [quoted('150045', 77_297)];
    await syncVersion('v1', 'actor');
    db.board.skus = [quoted('150045', 80_000)];
    await syncVersion('v1', 'actor');
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0]!.amountMinor).toBe(80_000);
  });

  it('withdraws a staged quote once the board stops quoting it', async () => {
    db.board.skus = [quoted('150045', 77_297)];
    await syncVersion('v1', 'actor');
    db.board.skus = [{ ...quoted('150045', 0), state: 'DROPPED', amountMinor: null }];
    const r = await syncVersion('v1', 'actor');
    expect(db.entries).toHaveLength(0);
    expect(r.thirdParty?.withdrawn).toEqual(['150045']);
    expect(r.thirdParty?.dropped).toEqual(['150045']);
  });

  it('reports, never moves, a quote that changed after it was applied', async () => {
    db.board.skus = [quoted('150045', 77_297)];
    await syncVersion('v1', 'actor');
    db.entries[0]!.status = 'APPLIED';
    db.board.skus = [quoted('150045', 90_000)];
    const r = await syncVersion('v1', 'actor');
    expect(db.entries[0]!.amountMinor).toBe(77_297);
    expect(r.thirdParty?.conflicts).toEqual([
      { sku: '150045', boardMinor: 90_000, recordedMinor: 77_297, status: 'APPLIED' },
    ]);
  });

  it('leaves a draft alone — the builder fills a draft, not the true-up', async () => {
    db.version.frozen = false;
    db.board.skus = [quoted('150045', 77_297)];
    const r = await syncVersion('v1', 'actor');
    expect(r.thirdParty).toBeNull();
    expect(db.entries).toHaveLength(0);
  });
});
