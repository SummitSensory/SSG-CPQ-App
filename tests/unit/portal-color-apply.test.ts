import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applySelection } from '../../src/portal/colorSelection.js';

/**
 * Applying a customer's colour picks must not race the customer.
 *
 * The portal link stays valid for thirty days and keeps working after a submit, on
 * purpose: a customer part-way through their choices has to be able to come back and
 * finish. `submitSelection` therefore refuses only once the selection is APPLIED — and
 * the status did not become APPLIED until the last line of `applySelection`.
 *
 * That left a window. Between reading the picks and writing them to the procurement
 * lines, a customer could change a colour. The old code did not notice, and the shape
 * of the damage was worse than a lost update: the closing write set the status but
 * never re-wrote `picks`, so the selection row ended up holding the customer's NEW
 * choice while the lines the shop reads held the OLD one. Two records, permanently
 * disagreeing, with no third to arbitrate — the order event stored only line names.
 *
 * The fix claims the row on the `submittedAt` it reviewed, inside a transaction, before
 * writing anything. These tests pin all three consequences: the happy path still
 * applies, a mid-flight resubmission is refused with nothing written, and what actually
 * reached the shop is recorded on the event.
 *
 * The race is made deterministic by resubmitting from inside the mocked
 * `specsForLines` — a real awaited seam between the read and the claim, so this is the
 * genuine ordering rather than an invented one.
 */

const h = vi.hoisted(() => ({
  store: {
    selection: null as Record<string, unknown> | null,
    lines: [] as Array<Record<string, unknown>>,
    sections: [] as Array<Record<string, unknown>>,
    lineWrites: [] as Array<{ id: string; powderColor: string | null }>,
    events: [] as Array<Record<string, unknown>>,
  },
  /** Runs at the awaited seam between reading the picks and claiming the row. */
  duringSpecLookup: null as null | (() => void),
}));

vi.mock('../../src/config/env.js', () => ({
  env: { PORTAL_COLOR_SELECTION: 'live', PORTAL_BASE_URL: 'https://portal.example.com' },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/*
 * The whole palette module. `applySelection` calls three things from it, and all three
 * are pure given a spec — so they are stubbed to the simplest spec that exercises the
 * code path (one required slot, whose pick is echoed back as the description).
 */
vi.mock('../../src/vendorColors/service.js', () => ({
  specsForLines: async (lines: Array<{ productId?: string | null }>) => {
    // The seam. In the real code this is an awaited database read; here it is where a
    // customer's resubmission lands, which is the case under test.
    if (h.duringSpecLookup) h.duringSpecLookup();
    const map = new Map<string, unknown>();
    for (const l of lines)
      if (l.productId) map.set(l.productId, { required: true, slots: ['body'] });
    return map;
  },
  normalizePicks: (_spec: unknown, picks: unknown) => picks,
  describePicks: (picks: unknown) => String((picks as { body?: string })?.body ?? ''),
  slotLabel: (s: string) => s,
  readPicks: (v: unknown) => v,
}));

vi.mock('../../src/lib/prisma.js', () => {
  const s = h.store;
  const client = {
    portalColorSelection: {
      findUnique: async () => (s.selection ? { ...s.selection } : null),
      /** The claim. Honours the status and submittedAt filters — that is the fix. */
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: { not?: string }; submittedAt?: Date | null };
        data: Record<string, unknown>;
      }) => {
        const row = s.selection;
        if (!row || row.id !== where.id) return { count: 0 };
        if (where.status?.not && row.status === where.status.not) return { count: 0 };
        if ('submittedAt' in where) {
          const a = where.submittedAt ? new Date(where.submittedAt).getTime() : null;
          const b = row.submittedAt ? new Date(row.submittedAt as Date).getTime() : null;
          if (a !== b) return { count: 0 };
        }
        s.selection = { ...row, ...data };
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        s.selection = { ...s.selection, ...data };
        return { ...s.selection };
      },
    },
    procurementLine: {
      findMany: async () => s.lines.map((l) => ({ ...l })),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { powderColor: string | null };
      }) => {
        s.lineWrites.push({ id: where.id, powderColor: data.powderColor });
        return { id: where.id };
      },
    },
    bomVendorSection: { findMany: async () => s.sections.map((x) => ({ ...x })) },
    orderEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        s.events.push(data);
        return data;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return { prisma: client };
});

const SUBMITTED_AT = new Date('2026-08-28T21:00:00.000Z');

function seed() {
  h.store.selection = {
    id: 'sel-1',
    orderId: 'ord-1',
    status: 'SUBMITTED',
    submittedAt: SUBMITTED_AT,
    picks: [{ lineId: 'line-1', sku: 'P-2526', picks: { body: 'Summit Blue' } }],
  };
  h.store.lines = [
    { id: 'line-1', productId: 'prod-1', sku: 'P-2526', name: 'Climbing wall', vendor: 'Acme' },
  ];
  h.store.sections = [{ vendor: 'Acme', status: 'DRAFT' }];
  h.store.lineWrites = [];
  h.store.events = [];
  h.duringSpecLookup = null;
}

describe('portal colour selection — applying picks', () => {
  beforeEach(seed);

  it('applies the reviewed picks and marks the selection APPLIED', async () => {
    await applySelection('sel-1', 'user-1');
    expect(h.store.lineWrites).toEqual([{ id: 'line-1', powderColor: 'Summit Blue' }]);
    expect(h.store.selection).toMatchObject({ status: 'APPLIED', appliedById: 'user-1' });
  });

  it('records on the order event what actually reached the shop', async () => {
    // The row's `picks` can be overwritten by the customer afterwards; this cannot.
    // Without it there is no durable answer to "what colour did we build against?"
    await applySelection('sel-1', 'user-1');
    const detail = h.store.events[0]!.detail as {
      colours: Array<{ line: string; sku: string | null; colour: string }>;
    };
    expect(detail.colours).toEqual([
      { line: 'Climbing wall', sku: 'P-2526', colour: 'Summit Blue' },
    ]);
  });

  it('refuses, and writes nothing, when the customer resubmits mid-apply', async () => {
    h.duringSpecLookup = () => {
      h.store.selection = {
        ...h.store.selection,
        picks: [{ lineId: 'line-1', sku: 'P-2526', picks: { body: 'Safety Yellow' } }],
        submittedAt: new Date(SUBMITTED_AT.getTime() + 1000),
      };
    };

    await expect(applySelection('sel-1', 'user-1')).rejects.toThrow(/changed while you were/i);

    // The important half: the claim fails before any line is touched, so the shop
    // never receives a colour nobody approved.
    expect(h.store.lineWrites).toEqual([]);
    expect(h.store.events).toEqual([]);
    expect(h.store.selection).toMatchObject({ status: 'SUBMITTED' });
  });

  it('refuses a second apply once another actor has applied it', async () => {
    h.duringSpecLookup = () => {
      h.store.selection = { ...h.store.selection, status: 'APPLIED' };
    };
    await expect(applySelection('sel-1', 'user-2')).rejects.toThrow(/changed while you were/i);
    expect(h.store.lineWrites).toEqual([]);
  });

  it('is a no-op when the selection was already applied before the call', async () => {
    h.store.selection = { ...h.store.selection, status: 'APPLIED' };
    const row = await applySelection('sel-1', 'user-1');
    expect((row as { status: string }).status).toBe('APPLIED');
    expect(h.store.lineWrites).toEqual([]);
  });

  it('skips a line whose vendor has already been sent its Bill of Materials', async () => {
    h.store.sections = [{ vendor: 'Acme', status: 'SUBMITTED' }];
    await applySelection('sel-1', 'user-1');
    expect(h.store.lineWrites).toEqual([]);
    const detail = h.store.events[0]!.detail as { skipped: string[] };
    expect(detail.skipped).toEqual(['Climbing wall']);
  });
});
