import { describe, it, expect, beforeEach, vi } from 'vitest';
/**
 * Administration → Orders & vendors → Portal colour areas: the list of areas.
 *
 * "Add an area" (public/portal-color-areas.js) relies on this contract: an area
 * mapped ahead of any customer answering it stays on the list, alongside every area
 * customers have answered — so a mapping made before the portal first asks a new
 * question is not lost when the screen reloads.
 */
const db = vi.hoisted(() => ({
  items: [] as Array<{ orderId: string; answers: unknown }>,
  mappings: [] as Array<{ areaKey: string; sku: string }>,
  skus: [] as Array<{ part: string; description: string }>,
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    orderPortalItem: { findMany: async () => db.items },
    portalColorAreaMapping: {
      findMany: async () =>
        [...db.mappings].sort(
          (a, b) => a.areaKey.localeCompare(b.areaKey) || a.sku.localeCompare(b.sku),
        ),
    },
    sku: {
      findMany: async ({ where }: { where: { OR: Array<{ part: { equals: string } }> } }) => {
        const wanted = new Set(where.OR.map((o) => o.part.equals.toUpperCase()));
        return db.skus.filter((s) => wanted.has(s.part.toUpperCase()));
      },
    },
  },
}));

vi.mock('../../src/lib/audit.js', () => ({ recordAudit: async () => undefined }));

import { listColorAreas } from '../../src/portal/colorAreaMapping.js';

describe('listColorAreas', () => {
  beforeEach(() => {
    db.items = [];
    db.mappings = [];
    db.skus = [];
  });

  it('lists an area that is mapped but that no customer has answered yet', async () => {
    db.mappings = [{ areaKey: 'climb_slide_mat.climb_slide_piece_1', sku: 'CS-100' }];
    db.skus = [{ part: 'CS-100', description: 'Climb & slide top pad' }];

    const areas = await listColorAreas();

    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({
      areaKey: 'climb_slide_mat.climb_slide_piece_1',
      label: 'Climb slide mat — Climb slide piece 1',
      orderCount: 0,
      samples: [],
      parts: [{ sku: 'CS-100', name: 'Climb & slide top pad' }],
    });
  });

  it('merges answered and pre-mapped areas into one sorted list', async () => {
    db.items = [
      {
        orderId: 'o1',
        answers: {
          selections: { adventure_mat: { adventure_mat_system: { brand: 'vinyl', code: 'Lime' } } },
        },
      },
    ];
    db.mappings = [{ areaKey: 'slide_platform_paint.slide_platform', sku: 'SP-1' }];

    const areas = await listColorAreas();

    expect(areas.map((a) => a.areaKey)).toEqual([
      'adventure_mat.adventure_mat_system',
      'slide_platform_paint.slide_platform',
    ]);
    expect(areas[0]).toMatchObject({ orderCount: 1, parts: [] });
    expect(areas[1]).toMatchObject({ orderCount: 0, parts: [{ sku: 'SP-1', name: null }] });
  });
});
