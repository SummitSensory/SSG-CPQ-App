import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/**
 * Retest for AUD-021 (docs/SOFTWARE_AUDIT.md): both `todayISO` and `fmtDate` used to
 * answer in UTC, which is the wrong calendar day for part of every evening anywhere
 * west of Greenwich — the proposal date, expiration date and discount-expiry line all
 * printed a day early on the document a customer signs. That was never covered by a
 * test, so the fix could regress silently. This pins the local-timezone behavior
 * without needing a browser: `public/ssg-ui.js` is the one place these primitives are
 * defined now (proposal-document.js, app.js and every screen alias or inject them from
 * here), so proving it here proves the whole chain by construction.
 */

const src = readFileSync(join(__dirname, '..', '..', 'public', 'ssg-ui.js'), 'utf8');

let SSGUI: {
  todayISO: () => string;
  fmtDate: (v: string) => string;
  isoLocal: (d: Date) => string;
};
let originalTZ: string | undefined;

beforeAll(() => {
  originalTZ = process.env.TZ;
  // Mountain — the zone named in the audit's own repro steps ("6:30pm Mountain").
  process.env.TZ = 'America/Denver';
  // Run in this realm, not a separate vm context: vitest's fake timers patch the
  // global `Date` here, and a sandboxed context would get its own, unpatched one.
  (globalThis as unknown as { window: Record<string, unknown> }).window = {};
  vm.runInThisContext(src);
  SSGUI = (globalThis as unknown as { window: { SSGUI: typeof SSGUI } }).window.SSGUI;
});

afterAll(() => {
  process.env.TZ = originalTZ;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('AUD-021 retest: dates answer in the reader local zone, not UTC', () => {
  it('todayISO reports the local calendar day, not the UTC day', () => {
    // 2026-06-15 20:00 Mountain Daylight Time (UTC-6) is already 2026-06-16 in UTC.
    // The bug (`new Date().toISOString().slice(0, 10)`) would answer 2026-06-16.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T02:00:00Z'));
    try {
      expect(SSGUI.todayISO()).toBe('2026-06-15');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fmtDate reads a bare YYYY-MM-DD as a calendar date, not a UTC instant', () => {
    // The bug (`new Date('2026-06-15')` alone) parses a bare date as UTC midnight,
    // which renders as the 14th anywhere west of Greenwich.
    const day = /\b(\d{1,2}),/.exec(SSGUI.fmtDate('2026-06-15'))?.[1];
    expect(day).toBe('15');
  });

  it('isoLocal round-trips a local evening instant to the same local day', () => {
    const eightPmLocal = new Date('2026-06-16T02:30:00Z'); // 8:30pm MDT on the 15th
    expect(SSGUI.isoLocal(eightPmLocal)).toBe('2026-06-15');
  });
});
