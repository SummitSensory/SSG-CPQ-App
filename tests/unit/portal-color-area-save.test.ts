import { describe, it, expect, beforeEach, vi } from 'vitest';
/**
 * Saving an area's parts: piece numbers and part-number patterns.
 */
const db = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; areaKey: string; sku: string; piece: number | null }>,
  skus: [] as Array<{ part: string; description: string }>,
  next: 1,
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    portalColorAreaMapping: {
      findMany: async ({ where }: { where: { areaKey: string } }) =>
        db.rows.filter((r) => r.areaKey === where.areaKey),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        db.rows = db.rows.filter((r) => !where.id.in.includes(r.id));
        return { count: 0 };
      },
      createMany: async ({
        data,
      }: {
        data: Array<{ areaKey: string; sku: string; piece: number | null }>;
      }) => {
        for (const d of data)
          db.rows.push({ id: `r${db.next++}`, areaKey: d.areaKey, sku: d.sku, piece: d.piece });
        return { count: data.length };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { piece: number | null };
      }) => {
        const r = db.rows.find((x) => x.id === where.id)!;
        r.piece = data.piece;
        return r;
      },
    },
    sku: {
      findMany: async ({ where }: { where: { OR: Array<{ part: { equals: string } }> } }) => {
        const wanted = new Set(where.OR.map((o) => o.part.equals.toUpperCase()));
        return db.skus.filter((s) => wanted.has(s.part.toUpperCase()));
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));
vi.mock('../../src/lib/audit.js', () => ({ recordAudit: async () => undefined }));

import { saveColorArea } from '../../src/portal/colorAreaMapping.js';

describe('saveColorArea', () => {
  beforeEach(() => {
    db.rows = [];
    db.skus = [{ part: 'CS-90', description: '90 degree climb & slide mat system' }];
    db.next = 1;
  });

  it('stores a piece per part and a pattern without calling it an unknown part', async () => {
    const r = await saveColorArea(
      'climb_slide_mat.climb_slide_piece_2',
      [{ sku: 'cs-90', piece: 2 }, { sku: 'r-ssg-*clm*' }],
      'u1',
    );
    expect(r.parts).toEqual([
      { sku: 'CS-90', name: '90 degree climb & slide mat system', piece: 2 },
      { sku: 'R-SSG-*CLM*', name: null, piece: null },
    ]);
    expect(r.unknownSkus).toEqual([]);
    expect(db.rows.map((x) => [x.sku, x.piece])).toEqual([
      ['CS-90', 2],
      ['R-SSG-*CLM*', null],
    ]);
  });

  it('changing only the piece updates the row in place', async () => {
    await saveColorArea('a.b', [{ sku: 'CS-90', piece: 1 }], 'u1');
    const id = db.rows[0]!.id;
    const r = await saveColorArea('a.b', [{ sku: 'CS-90', piece: 3 }], 'u1');
    expect(db.rows).toEqual([{ id, areaKey: 'a.b', sku: 'CS-90', piece: 3 }]);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it('still accepts bare part numbers from an older screen', async () => {
    const r = await saveColorArea('a.b', ['CS-90'], 'u1');
    expect(r.parts).toEqual([
      { sku: 'CS-90', name: '90 degree climb & slide mat system', piece: null },
    ]);
  });

  // Review 2026-09-24 (M2): a tab still running the old screen sends bare part
  // numbers; saving from it must not wipe the pieces.
  it('bare part numbers keep the pieces already stored', async () => {
    await saveColorArea('a.b', [{ sku: 'CS-90', piece: 2 }], 'u1');
    const r = await saveColorArea('a.b', ['CS-90'], 'u1');
    expect(db.rows.map((x) => [x.sku, x.piece])).toEqual([['CS-90', 2]]);
    expect(r.parts[0]!.piece).toBe(2);
  });

  it('refuses a pattern that is too broad, and a bad piece', async () => {
    await expect(saveColorArea('a.b', [{ sku: '*' }], 'u1')).rejects.toThrow(/too broad/);
    await expect(saveColorArea('a.b', [{ sku: 'R*' }], 'u1')).rejects.toThrow(/too broad/);
    await expect(saveColorArea('a.b', [{ sku: 'CS-90', piece: 0 }], 'u1')).rejects.toThrow(/Piece/);
    await expect(saveColorArea('a.b', [{ sku: 'CS-90', piece: 8 }], 'u1')).rejects.toThrow(/Piece/);
  });
});
