import { describe, it, expect, beforeEach, vi } from 'vitest';
/**
 * The safety rules the code audit asked to be pinned down, against an in-memory
 * database:
 *
 *   - an applied (or CONFLICT) submission whose ADDRESS has not moved is never
 *     re-applied — no section re-pointing, no owner email — however often the
 *     board-wide refresh runs, and newly added columns are stored quietly;
 *   - a delivery-preference change reaches only editable sections following the
 *     portal address;
 *   - Mark reviewed marks only the version the person saw, refuses a second review,
 *     claims before applying colours and releases the claim if applying fails, and
 *     ticks Staff Reviewed only for a real submission row;
 *   - the refresh throttle is an atomic claim, and a failed run does not hold it;
 *   - obtainedAt dates.
 */
type Row = Record<string, unknown> & { id: string };

const db = vi.hoisted(() => ({
  subs: [] as Array<Record<string, unknown> & { id: string }>,
  sections: [] as Array<Record<string, unknown> & { id: string }>,
  items: [] as Array<Record<string, unknown> & { id: string }>,
  logs: [] as Array<Record<string, unknown> & { id: string }>,
  events: [] as unknown[],
  seq: 0,
}));
const applyColors = vi.hoisted(() => vi.fn());
const setColumnValues = vi.hoisted(() => vi.fn());

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/config/env.js')>();
  return { ...orig, env: { ...orig.env, MONDAY_API_TOKEN: 'test-token' } };
});

vi.mock('../../src/lib/prisma.js', () => {
  const match = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const o = v as { not?: unknown; in?: unknown[] };
        if ('not' in o) return row[k] !== o.not;
        if ('in' in o) return (o.in ?? []).includes(row[k]);
      }
      return row[k] === v;
    });
  const table = (name: 'subs' | 'sections' | 'items' | 'logs') => ({
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      const w = (where.orderId_kind as Record<string, unknown> | undefined) ?? where;
      const row = db[name].find((r) => match(r, w));
      return row ? { ...row } : null;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      [...db[name]].reverse().find((r) => match(r, where)) ?? null,
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      db[name].filter((r) => match(r, where ?? {})),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (name === 'logs' && data.eventId && db.logs.some((l) => l.eventId === data.eventId)) {
        throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
      }
      const row = { id: `${name}-${++db.seq}`, ...data } as Row;
      db[name].push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = db[name].find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const rows = db[name].filter((r) => match(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  });
  return {
    prisma: {
      portalDeliverySubmission: table('subs'),
      bomVendorSection: table('sections'),
      orderPortalItem: table('items'),
      integrationSyncLog: table('logs'),
      orderEvent: { create: async ({ data }: { data: unknown }) => db.events.push(data) },
      user: { findMany: async () => [] },
      acceptedOrder: { findMany: async () => [], findUnique: async () => null },
    },
  };
});
vi.mock('../../src/lib/audit.js', () => ({ recordAudit: async () => undefined }));
vi.mock('../../src/integrations/monday/client.js', () => ({
  mondayQuery: async () => ({ boards: [{ items_page: { cursor: null, items: [] } }] }),
  setColumnValues,
}));
vi.mock('../../src/integrations/monday/discovery.js', () => ({
  fetchItemById: async () => null,
  fetchAllItems: async () => {
    throw new Error('monday is down');
  },
}));
vi.mock('../../src/portal/colorAreas.js', () => ({ applyColorPicksToOrder: applyColors }));

import { ingestDeliverySubmission } from '../../src/integrations/monday/portalDelivery.js';
import {
  reviewPortalItem,
  refreshPortal,
  obtainedAtFor,
  calendarDate,
  SUBMISSION_SOURCE,
} from '../../src/portal/orderPortal.js';

/** A submission row as the board returns it (column id → text). */
const boardRow = (over: Record<string, string> = {}) => ({
  name: 'Wiggle Room Therapy and Play',
  text: {
    text_mm571ym4: '13075275702',
    text_mm57sf21: '17233 Ventura Blvd',
    text_mm57g87z: 'Encino',
    text_mm57hhxm: 'CA',
    text_mm57wkbf: '91316',
    text_mm57n32a: 'United States',
    text_mm57830j: 'Jennifer Fattal',
    text_mm5767gr: '8185551212',
    text_mm5712dx: 'No, I need liftgate delivery',
    date_mm57s4r5: '2026-09-21',
    ...over,
  },
});

beforeEach(() => {
  db.subs = [];
  db.sections = [];
  db.items = [];
  db.logs = [];
  db.events = [];
  db.seq = 0;
  applyColors.mockReset();
  setColumnValues.mockReset().mockResolvedValue(undefined);
});

/** A stored, applied submission matching boardRow(), minus the columns added later. */
function storedApplied(status = 'APPLIED') {
  db.subs.push({
    id: 'sub-1',
    mondayItemId: 'm-1',
    mondayOrderItemId: '13075275702',
    orderId: 'ord-1',
    shipToAddressId: 'addr-1',
    status,
    customerEmail: null,
    addressConfirmed: null,
    line1: '17233 Ventura Blvd',
    line2: null,
    city: 'Encino',
    region: 'CA',
    postalCode: '91316',
    country: 'United States',
    formattedAddress: null,
    pocName: 'Jennifer Fattal',
    pocPhone: '8185551212',
    pocEmail: null,
    secondaryPocName: null,
    secondaryPocPhone: null,
    secondaryPocEmail: null,
    loadingDock: 'No, I need liftgate delivery',
    deliveryTiming: null,
    preferredDeliveryDate: null,
    specialInstructions: null,
    restrictedChanges: null,
    freightAckBy: null,
    freightAckDate: null,
    // columns added by this build — NULL on every row stored before it
    submittedDate: null,
    preferredComm: null,
    textNumber: null,
    secondaryPreferredComm: null,
    secondaryMobile: null,
    raw: {},
  });
  db.sections.push(
    {
      id: 'sec-draft',
      orderId: 'ord-1',
      status: 'DRAFT',
      shipToAddressId: 'addr-1',
      loadingDock: 'Hand-corrected',
    },
    {
      id: 'sec-sent',
      orderId: 'ord-1',
      status: 'SUBMITTED',
      shipToAddressId: 'addr-1',
      loadingDock: 'Old',
    },
  );
}

describe('ingest never re-applies an unchanged address', () => {
  it('stores the newly added columns quietly on the first refresh after deploy', async () => {
    storedApplied();
    const r = await ingestDeliverySubmission('m-1', boardRow());
    expect(r).toBe('unchanged');
    expect(db.subs[0]!.submittedDate).toEqual(new Date('2026-09-21T00:00:00.000Z'));
    // Nothing on the order was touched: the hand-corrected value survives.
    expect(db.sections.find((s) => s.id === 'sec-draft')!.loadingDock).toBe('Hand-corrected');
    expect(db.events).toHaveLength(0);
  });

  it('does not re-apply (or re-email) a CONFLICT submission on every refresh', async () => {
    storedApplied('CONFLICT');
    const r = await ingestDeliverySubmission('m-1', boardRow({ text_mm5767gr: '8185559999' }));
    expect(r).toBe('unchanged');
    expect(db.subs[0]!.status).toBe('CONFLICT');
    expect(db.subs[0]!.pocPhone).toBe('8185559999');
    expect(db.events).toHaveLength(0);
  });

  it('carries a changed delivery preference to editable sections only', async () => {
    storedApplied();
    await ingestDeliverySubmission('m-1', boardRow({ text_mm5712dx: 'Yes, we have a dock' }));
    expect(db.sections.find((s) => s.id === 'sec-draft')!.loadingDock).toBe('Yes, we have a dock');
    expect(db.sections.find((s) => s.id === 'sec-sent')!.loadingDock).toBe('Old');
    expect(db.events).toHaveLength(1);
  });
});

describe('Mark reviewed', () => {
  const item = (over: Record<string, unknown> = {}) => {
    db.items.push({
      id: 'it-1',
      orderId: 'ord-1',
      kind: 'COLOR',
      state: 'PROVIDED',
      contentHash: 'h2',
      reviewedHash: null,
      reviewedAt: null,
      reviewedById: null,
      answers: { selections: {} },
      sourceItemId: 'mfg-1',
      ...over,
    });
  };

  it('refuses when the answers changed since the page loaded, and applies nothing', async () => {
    item();
    await expect(reviewPortalItem('ord-1', 'COLOR', 'u1', 'h1')).rejects.toThrow(/changed/);
    expect(applyColors).not.toHaveBeenCalled();
    expect(db.items[0]!.reviewedHash).toBeNull();
  });

  it('refuses a second review of the same version', async () => {
    item({ reviewedHash: 'h2' });
    await expect(reviewPortalItem('ord-1', 'COLOR', 'u1', 'h2')).rejects.toThrow(/already/);
    expect(applyColors).not.toHaveBeenCalled();
  });

  it('releases the claim when applying the colours fails', async () => {
    item();
    applyColors.mockRejectedValueOnce(new Error('db down'));
    await expect(reviewPortalItem('ord-1', 'COLOR', 'u1', 'h2')).rejects.toThrow('db down');
    expect(db.items[0]!.reviewedHash).toBeNull();
  });

  it('ticks Staff Reviewed only for a delivery read from a submission row', async () => {
    item({ kind: 'DELIVERY', sourceItemId: 'mfg-1' });
    await reviewPortalItem('ord-1', 'DELIVERY', 'u1', 'h2');
    expect(setColumnValues).not.toHaveBeenCalled();

    db.items = [];
    item({ kind: 'DELIVERY', sourceItemId: SUBMISSION_SOURCE + 'sub-row-9' });
    await reviewPortalItem('ord-1', 'DELIVERY', 'u1', 'h2');
    expect(setColumnValues).toHaveBeenCalledWith(expect.any(String), 'sub-row-9', {
      boolean_mm576c3b: { checked: 'true' },
    });
  });
});

describe('refresh throttle', () => {
  it('records a failed run as failed, so it does not hold the throttle', async () => {
    const r = await refreshPortal({});
    expect(r.error).toMatch(/monday is down/);
    expect(db.logs[0]).toMatchObject({ status: 'error' });
    // The next page open tries again rather than being told "refreshed just now".
    const again = await refreshPortal({ force: true });
    expect(again.throttled).toBe(false);
  });

  it('lets only one refresh claim a window', async () => {
    db.logs.push({
      id: 'l1',
      entity: 'portal-refresh',
      status: 'running',
      eventId: `portal-refresh:auto:${Math.floor(Date.now() / 60_000)}`,
    });
    const r = await refreshPortal({});
    expect(r.throttled).toBe(true);
  });
});

describe('obtainedAt', () => {
  const now = new Date('2026-09-23T15:00:00Z');
  it('uses the Submitted Date the first time, "now" for a later change', () => {
    const given = calendarDate(new Date('2026-09-21T00:00:00Z'));
    expect(obtainedAtFor('PROVIDED', given, null, now)).toEqual(given);
    expect(obtainedAtFor('PROVIDED', given, { contentHash: 'x', obtainedAt: given }, now)).toEqual(
      now,
    );
    expect(obtainedAtFor('NOT_PROVIDED', given, null, now)).toBeNull();
  });

  it('stores a calendar date at noon UTC, so no US time zone shows the day before', () => {
    expect(calendarDate(new Date('2026-09-21T00:00:00Z')).toISOString()).toBe(
      '2026-09-21T12:00:00.000Z',
    );
  });
});
