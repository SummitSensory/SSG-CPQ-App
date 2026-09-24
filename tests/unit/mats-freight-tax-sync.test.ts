import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The Mat Freight Tax Pass-Through, synced with the freight on a released proposal.
 *
 * Bryan (2026-09-24): syncing freight on a released proposal must also sync the mats
 * freight tax off the deal board (formula_mkzde17n) into the proposal, and bill it to
 * the QuickBooks R-TAX item (item 207). Money rules pinned here:
 *   - the invoice is billed the DIFFERENCE, never the tax a second time;
 *   - a tax already applied or billed is never rewritten by a later board change;
 *   - a blank board column changes nothing;
 *   - a freight-only batch still may not move the tax by a cent.
 */

type Entry = Record<string, unknown> & { id: string; status: string; amountMinor: number };
const db = vi.hoisted(() => ({
  entries: [] as Array<
    Record<string, unknown> & { id: string; status: string; amountMinor: number }
  >,
  version: {} as Record<string, unknown>,
  board: {} as Record<string, string | null>,
  seq: 0,
  crossBorder: false,
  invoiceSnapshotId: null as string | null,
  snapshots: {} as Record<string, Date>,
  trueUps: [] as Array<{ id: string; newSnapshotId: string | null }>,
}));

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...orig,
    env: { ...orig.env, MONDAY_API_TOKEN: 't', MONDAY_DEALS_BOARD_ID: '6527740233' },
    isMondayPushConfigured: () => true,
  };
});
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    proposalVersion: {
      findUnique: async () => db.version,
      findUniqueOrThrow: async () => db.version,
    },
    opportunity: { findFirst: async () => null },
    proposalCrossBorderSnapshot: { count: async () => (db.crossBorder ? 1 : 0) },
    qboTransaction: {
      findMany: async () =>
        db.invoiceSnapshotId
          ? [{ proposalId: 'p1', totalsSnapshot: { priceSnapshotId: db.invoiceSnapshotId } }]
          : [],
    },
    priceSnapshot: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in
          .filter((id) => db.snapshots[id])
          .map((id) => ({ id, createdAt: db.snapshots[id]! })),
    },
    freightTrueUp: {
      findFirst: async () => ({ id: 'tu-1' }),
      create: async () => ({ id: 'tu-1' }),
      findMany: async () => db.trueUps,
    },
    freightEntry: {
      findMany: async ({ where }: { where: { bucket?: unknown; source?: string } }) =>
        db.entries
          .filter((e) => {
            const b = where.bucket as string | { in: string[] } | undefined;
            if (typeof b === 'string' && e.bucket !== b) return false;
            if (b && typeof b === 'object' && !b.in.includes(String(e.bucket))) return false;
            if (where.source && e.source !== where.source) return false;
            return e.status !== 'VOID';
          })
          .reverse(),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `e${++db.seq}`, createdAt: new Date() } as unknown as Entry;
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
  subitemFreightForProposal: async () => ({ requested: false }),
}));
vi.mock('../../src/integrations/monday/client.js', () => ({
  mondayQuery: async () => ({
    items: [
      {
        id: '123',
        name: 'Bloom Pediatric Therapy',
        column_values: Object.entries(db.board).map(([id, v]) => ({
          id,
          text: null,
          display_value: v,
        })),
      },
    ],
  }),
}));

import { syncVersion } from '../../src/integrations/monday/freightPull.js';
import {
  entriesOnInvoice,
  stillToBill,
} from '../../src/integrations/quickbooks/freightInvoiced.js';
import {
  applyFreightEntries,
  assertFreightOnlyChange,
  billableMinor,
  MATS_TAX,
} from '../../src/proposals/freightTrueUp.js';
import {
  buildFreightLines,
  emptyFreightAmounts,
  freightTotal,
} from '../../src/integrations/quickbooks/freightInvoice.js';

const TAX_COL = 'formula_mkzde17n';

/** A released version: $10,000 of product and a $250.00 mat freight tax on its header. */
function releasedVersion(meta: Record<string, unknown> = {}) {
  return {
    proposalId: 'p1',
    frozen: true,
    items: [
      {
        ref: 'a',
        sku: 'A-1',
        name: 'A',
        lineType: 'PRODUCT',
        quantity: 1,
        unitPriceMinor: 1000000,
        costEach: 400000,
      },
    ],
    sections: [{ id: 'meta', data: { projectId: '123', taxAmountMinor: 25000, ...meta } }],
  };
}

beforeEach(() => {
  db.entries = [];
  db.seq = 0;
  db.version = releasedVersion();
  db.board = {};
  db.crossBorder = false;
  db.invoiceSnapshotId = null;
  db.snapshots = {};
  db.trueUps = [];
});

describe('billableMinor — the invoice is billed the difference, never the tax twice', () => {
  it('bills freight in full and a tax increase as the increase', () => {
    expect(billableMinor({ bucket: 'MATS', amountMinor: 52044 })).toBe(52044);
    expect(billableMinor({ bucket: MATS_TAX, amountMinor: 31000, priorAmountMinor: 25000 })).toBe(
      6000,
    );
  });
  it('bills nothing for a tax that did not go up', () => {
    expect(billableMinor({ bucket: MATS_TAX, amountMinor: 25000, priorAmountMinor: 25000 })).toBe(
      0,
    );
    expect(billableMinor({ bucket: MATS_TAX, amountMinor: 20000, priorAmountMinor: 25000 })).toBe(
      0,
    );
  });
});

describe('applying the tax to the proposal', () => {
  const v = releasedVersion({ tbdTax: 'TBD' });

  it('replaces the Tax field with the board figure and clears the TBD wording', () => {
    const applied = applyFreightEntries(v.sections, v.items, [], { taxMinor: 31000 });
    expect(applied.before.tax).toBe(25000);
    expect(applied.after.tax).toBe(31000);
    expect(applied.taxChange).toEqual({ fromMinor: 25000, toMinor: 31000 });
    const meta = (applied.sections as Array<{ id: string; data: Record<string, unknown> }>)[0]!
      .data;
    expect(meta.taxAmountMinor).toBe(31000);
    expect(meta.tbdTax).toBe('');
    // Subtotal, discount and cost are untouched, so the guard lets it through.
    expect(() =>
      assertFreightOnlyChange(applied.before, applied.after, { allowTax: true }),
    ).not.toThrow();
  });

  it('still refuses a tax move that did not come from a synced tax figure', () => {
    const applied = applyFreightEntries(v.sections, v.items, [], { taxMinor: 31000 });
    expect(() => assertFreightOnlyChange(applied.before, applied.after)).toThrow(
      /tax pass-through/,
    );
  });

  it('still refuses a price move even when the tax is allowed to change', () => {
    const before = { subtotal: 1000000, discount: 0, tax: 25000, cogs: 400000 } as never;
    const after = { subtotal: 1100000, discount: 0, tax: 31000, cogs: 400000 } as never;
    expect(() => assertFreightOnlyChange(before, after, { allowTax: true })).toThrow(
      /product subtotal/,
    );
  });

  it('adds nothing to the tax when a batch is freight only', () => {
    const applied = applyFreightEntries(v.sections, v.items, [
      { bucket: 'MATS', scope: 'JOB', amountMinor: 52044, absolute: true },
    ]);
    expect(applied.after.tax).toBe(25000);
    expect(applied.taxChange).toBeNull();
  });
});

describe('QuickBooks — the tax increase bills to R-TAX (FREIGHT_TAX, item 207)', () => {
  it('adds one tax row, on the freight-tax item, for the increase only', () => {
    process.env.QBO_ITEM_ID_FREIGHT_TAX = '207';
    process.env.QBO_ITEM_ID_FREIGHT_MATS = '372';
    const amounts = { ...emptyFreightAmounts(), MATS: 52044n, MATS_TAX: 6000n };
    const lines = buildFreightLines({ amounts });
    expect(lines).toHaveLength(2);
    const tax = lines.find((l) => /tax/i.test(String(l.Description)))!;
    expect(tax.Amount).toBe(60);
    expect((tax.SalesItemLineDetail as { ItemRef: { value: string } }).ItemRef.value).toBe('207');
    expect(freightTotal(amounts)).toBe(58044n);
  });
  it('adds no tax row when nothing is owed', () => {
    const lines = buildFreightLines({ amounts: { ...emptyFreightAmounts(), MATS: 52044n } });
    expect(lines).toHaveLength(1);
  });
});

describe('syncVersion — staging the tax off formula_mkzde17n', () => {
  it('stages the board figure with the proposal’s current tax as the prior', async () => {
    db.board = { [TAX_COL]: '310.00' };
    const r = await syncVersion('v1', 'u1');
    expect(r.matsTax).toMatchObject({
      state: 'staged',
      boardMinor: 31000,
      onProposalMinor: 25000,
      changed: true,
    });
    const tax = db.entries.filter((e) => e.bucket === MATS_TAX);
    expect(tax).toHaveLength(1);
    expect(tax[0]).toMatchObject({
      status: 'STAGED',
      amountMinor: 31000,
      priorAmountMinor: 25000,
      absolute: true,
      source: 'MONDAY',
      mondayColumnId: TAX_COL,
    });
  });

  it('does not stage a second copy on the next read', async () => {
    db.board = { [TAX_COL]: '310.00' };
    await syncVersion('v1', 'u1');
    const r = await syncVersion('v1', 'u1');
    expect(r.matsTax).toMatchObject({ state: 'staged', changed: false });
    expect(db.entries.filter((e) => e.bucket === MATS_TAX)).toHaveLength(1);
  });

  it('withdraws a staged figure once the proposal already carries the board’s tax', async () => {
    db.board = { [TAX_COL]: '310.00' };
    await syncVersion('v1', 'u1');
    db.board = { [TAX_COL]: '250.00' };
    const r = await syncVersion('v1', 'u1');
    expect(r.matsTax).toMatchObject({ state: 'onProposal' });
    expect(db.entries.filter((e) => e.bucket === MATS_TAX)).toHaveLength(0);
  });

  it('never rewrites a tax already applied or billed — it is reported as a conflict', async () => {
    db.entries.push({
      id: 'applied-tax',
      bucket: MATS_TAX,
      source: 'MONDAY',
      status: 'PUSHED',
      amountMinor: 31000,
      priorAmountMinor: 25000,
    });
    db.board = { [TAX_COL]: '350.00' };
    const r = await syncVersion('v1', 'u1');
    expect(r.matsTax).toMatchObject({
      state: 'conflict',
      recordedMinor: 31000,
      recordedStatus: 'PUSHED',
    });
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0]!.amountMinor).toBe(31000);
  });

  it('changes nothing when the board column is blank', async () => {
    db.board = { [TAX_COL]: '' };
    const r = await syncVersion('v1', 'u1');
    expect(r.matsTax).toMatchObject({ state: 'none', boardMinor: null });
    expect(db.entries).toHaveLength(0);
  });

  it('still stages steel and mats freight exactly as before', async () => {
    db.board = { formula_mky8s42a: '1262.70', formula_mkzd3p9s: '520.44', [TAX_COL]: '310.00' };
    const r = await syncVersion('v1', 'u1');
    expect(r.updated.map((u) => [u.bucket, u.amountMinor])).toEqual([
      ['STEEL', 126270],
      ['MATS', 52044],
    ]);
    expect(db.entries.map((e) => e.bucket).sort()).toEqual(['MATS', 'MATS_TAX', 'STEEL']);
  });
});

describe('syncVersion — review fixes', () => {
  it('treats a board 0 as "not quoted" — the formula returns 0 when R-Tax is blank', async () => {
    db.board = { [TAX_COL]: '310.00' };
    await syncVersion('v1', 'u1'); // staged
    db.board = { [TAX_COL]: '0' };
    const r = await syncVersion('v1', 'u1');
    expect(r.matsTax).toMatchObject({ state: 'none', boardMinor: null, changed: true });
    // Never staged as "cut the tax to $0", and the stale staged figure is withdrawn.
    expect(db.entries.filter((e) => e.bucket === MATS_TAX)).toHaveLength(0);
  });

  it('never stages the tax on a cross-border (Canadian) version', async () => {
    db.crossBorder = true;
    db.board = { [TAX_COL]: '310.00' };
    const r = await syncVersion('v1', 'u1');
    expect(r.matsTax).toMatchObject({ state: 'none', skipped: 'cross-border' });
    expect(db.entries.filter((e) => e.bucket === MATS_TAX)).toHaveLength(0);
  });
});

describe('entriesOnInvoice — never bill what the invoice already carries', () => {
  const applied = (id: string, trueUpId: string, over: Record<string, unknown> = {}) => ({
    id,
    trueUpId,
    proposalId: 'p1',
    status: 'APPLIED',
    bucket: MATS_TAX,
    amountMinor: 31000,
    priorAmountMinor: 25000,
    ...over,
  });

  it('counts a figure applied BEFORE the invoice was raised as already on it', async () => {
    db.trueUps = [{ id: 'tu-a', newSnapshotId: 'snap-apply' }];
    db.snapshots = {
      'snap-apply': new Date('2026-09-24T10:00:00Z'),
      'snap-invoice': new Date('2026-09-24T10:00:00Z'), // the invoice used the applied snapshot
    };
    db.invoiceSnapshotId = 'snap-apply';
    const e = [
      applied('t1', 'tu-a'),
      applied('m1', 'tu-a', { bucket: 'MATS', amountMinor: 52044, priorAmountMinor: null }),
    ];
    expect([...(await entriesOnInvoice(e as never))].sort()).toEqual(['m1', 't1']);
    expect(await stillToBill(e as never)).toHaveLength(0);
  });

  it('bills a figure applied AFTER the invoice was raised', async () => {
    db.trueUps = [{ id: 'tu-a', newSnapshotId: 'snap-apply' }];
    db.snapshots = {
      'snap-invoice': new Date('2026-09-20T10:00:00Z'),
      'snap-apply': new Date('2026-09-24T10:00:00Z'),
    };
    db.invoiceSnapshotId = 'snap-invoice';
    const e = [applied('t1', 'tu-a')];
    expect((await entriesOnInvoice(e as never)).size).toBe(0);
    const bill = await stillToBill(e as never);
    expect(bill.map((x) => x.id)).toEqual(['t1']);
    expect(billableMinor(bill[0]!)).toBe(6000);
  });

  it('bills nothing, and counts nothing on the invoice, when there is no invoice yet', async () => {
    db.trueUps = [{ id: 'tu-a', newSnapshotId: 'snap-apply' }];
    db.snapshots = { 'snap-apply': new Date('2026-09-24T10:00:00Z') };
    const e = [applied('t1', 'tu-a')];
    expect((await entriesOnInvoice(e as never)).size).toBe(0);
  });

  it('never offers a tax that went down', async () => {
    db.invoiceSnapshotId = null;
    const e = [applied('t1', 'tu-a', { amountMinor: 20000 })];
    expect(await stillToBill(e as never)).toHaveLength(0);
  });
});
