import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The BOM column headings store (src/handoff/bomColumnLabels.ts), against a stub table. */

const ROWS = new Map<string, string>();

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    uiSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        ROWS.has(where.key) ? { key: where.key, value: ROWS.get(where.key) } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        ROWS.set(where.key, create.value);
        return create;
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        ROWS.delete(where.key);
        return { count: 1 };
      },
    },
  },
}));

const { BOM_COLUMNS, BOM_COLUMN_LABELS_KEY, loadBomColumnLabels, saveBomColumnLabels } =
  await import('../../src/handoff/bomColumnLabels.js');

beforeEach(() => ROWS.clear());

describe('BOM column headings', () => {
  it('reads the defaults when nothing is saved, with Cost Each renamed to Vendor Cost', async () => {
    const labels = await loadBomColumnLabels();
    expect(labels.part).toBe('Part #');
    expect(labels.costEach).toBe('Vendor Cost');
    expect(labels.secondaryCharge).toBe('Vendor Cost'); // was "Their charge"
    expect(Object.keys(labels)).toHaveLength(BOM_COLUMNS.length);
  });

  it('stores only what differs from the default, and a blank goes back to the default', async () => {
    const saved = await saveBomColumnLabels(
      { costEach: 'Their Price', qty: '', part: 'Part #', notes: '  Remarks  ' },
      'u1',
    );
    expect(saved).toMatchObject({ costEach: 'Their Price', qty: 'Qty', notes: 'Remarks' });
    expect(JSON.parse(ROWS.get(BOM_COLUMN_LABELS_KEY)!)).toEqual({
      costEach: 'Their Price',
      notes: 'Remarks',
    });
    expect((await loadBomColumnLabels()).costEach).toBe('Their Price');
  });

  it('removes the row when every heading is back to its default', async () => {
    await saveBomColumnLabels({ costEach: 'X' }, 'u1');
    await saveBomColumnLabels({}, 'u1');
    expect(ROWS.has(BOM_COLUMN_LABELS_KEY)).toBe(false);
  });

  it('ignores unknown keys and a damaged saved row rather than failing the BOM', async () => {
    await saveBomColumnLabels({ nonsense: 'Hi' } as Record<string, string>, 'u1');
    expect(ROWS.has(BOM_COLUMN_LABELS_KEY)).toBe(false);
    ROWS.set(BOM_COLUMN_LABELS_KEY, '{not json');
    expect((await loadBomColumnLabels()).part).toBe('Part #');
  });

  it('cuts a heading to 40 characters', async () => {
    const saved = await saveBomColumnLabels({ notes: 'x'.repeat(60) }, 'u1');
    expect(saved.notes).toHaveLength(40);
  });
});
