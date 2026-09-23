import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/**
 * public/order-portal.js — the Orders pages' customer-portal columns, list filters and
 * the order page's Customer Portal card. The pure pieces are pinned here without a
 * browser: the chip / CSV / sort rules Bryan approved for the columns, the filter
 * matching the filter row and Filters panel share, and the readable rendering of the
 * customer's answers (including shapes it has never seen, which must render, not fail).
 */

const root = join(__dirname, '..', '..');
const ui = readFileSync(join(root, 'public', 'ssg-ui.js'), 'utf8');
const src = readFileSync(join(root, 'public', 'order-portal.js'), 'utf8');

type Entry = { display: string; obtainedAt: string | null };
type Row = Record<string, unknown> & { portal?: Record<string, Entry> | null; status?: string };
type Col = {
  key: string;
  label: string;
  filter?: string;
  portalKind?: string;
  defaultOn?: boolean;
  plain: (r: Row) => string;
  sort?: (r: Row) => number;
  cell?: (r: Row) => string;
};
interface OrderPortal {
  KINDS: string[];
  entryOf: (row: Row, kind: string) => Entry;
  chipHtml: (e: Entry, now?: number) => string;
  plainOf: (e: Entry) => string;
  sortKeyOf: (e: Entry) => number;
  hasNew: (row: Row) => boolean;
  columns: () => Col[];
  fmtPhone: (v: unknown) => string;
  relTime: (iso: string | null, now?: number) => string;
  humanize: (k: string) => string;
  matchFilter: (col: Col, row: Row, v: unknown, now?: number) => boolean;
  rowPasses: (
    cols: Col[],
    state: { cols: Record<string, unknown>; unreviewed: boolean },
    row: Row,
    now?: number,
  ) => boolean;
  activeCount: (
    cols: Col[],
    state: { cols: Record<string, unknown>; unreviewed: boolean },
  ) => number;
  answersHtml: (kind: string, a: unknown) => string;
  deliverySignature: (items: Array<Record<string, unknown>>) => string;
}

let OP: OrderPortal;

beforeAll(() => {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(ui, ctx);
  vm.runInContext(src, ctx);
  OP = (ctx as unknown as { window: { SSGOrderPortal: OrderPortal } }).window.SSGOrderPortal;
});

const NOW = new Date(2026, 8, 22, 12, 0, 0).getTime(); // Sep 22 2026, local noon
const row = (portal: Record<string, Entry>, extra: Record<string, unknown> = {}): Row => ({
  portal,
  ...extra,
});

describe('portal column cells', () => {
  it('shows NEW amber with the date, REVIEWED green with the date, NONE "-", NA "N/A"', () => {
    const iso = new Date(2026, 8, 22, 9).toISOString();
    const n = OP.chipHtml({ display: 'NEW', obtainedAt: iso }, NOW);
    expect(n).toContain('New · Sep 22');
    expect(n).toContain('#fdf6e3'); // the app's amber (In progress) chip
    const r = OP.chipHtml({ display: 'REVIEWED', obtainedAt: iso }, NOW);
    expect(r).toContain('Reviewed · Sep 22');
    expect(r).toContain('#eaf3ee'); // the app's green (Complete) chip
    expect(OP.chipHtml({ display: 'NONE', obtainedAt: null })).toContain('>-<');
    expect(OP.chipHtml({ display: 'NONE', obtainedAt: null })).toContain('muted');
    expect(OP.chipHtml({ display: 'NA', obtainedAt: null })).toContain('N/A');
  });

  it('adds the year only when it is not this year', () => {
    const old = new Date(2025, 2, 3, 9).toISOString();
    expect(OP.chipHtml({ display: 'NEW', obtainedAt: old }, NOW)).toMatch(/2025/);
  });

  it('exports plain CSV values', () => {
    const iso = new Date(2026, 8, 22, 9).toISOString();
    expect(OP.plainOf({ display: 'NEW', obtainedAt: iso })).toBe('New 2026-09-22');
    expect(OP.plainOf({ display: 'REVIEWED', obtainedAt: iso })).toBe('Reviewed 2026-09-22');
    expect(OP.plainOf({ display: 'NONE', obtainedAt: null })).toBe('-');
    expect(OP.plainOf({ display: 'NA', obtainedAt: null })).toBe('N/A');
  });

  it('sorts NEW < REVIEWED < NA < NONE, then by date', () => {
    const a = OP.sortKeyOf({ display: 'NEW', obtainedAt: '2026-09-20T00:00:00Z' });
    const b = OP.sortKeyOf({ display: 'NEW', obtainedAt: '2026-09-21T00:00:00Z' });
    const c = OP.sortKeyOf({ display: 'REVIEWED', obtainedAt: '2020-01-01T00:00:00Z' });
    const d = OP.sortKeyOf({ display: 'NA', obtainedAt: null });
    const e = OP.sortKeyOf({ display: 'NONE', obtainedAt: null });
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThan(d);
    expect(d).toBeLessThan(e);
  });

  it('treats a missing or malformed portal as "-" everywhere, never a crash', () => {
    expect(OP.entryOf({ portal: null }, 'DELIVERY').display).toBe('NONE');
    expect(OP.entryOf({}, 'COLOR').display).toBe('NONE');
    expect(
      OP.entryOf(row({ BILLING: { display: 'WAT', obtainedAt: null } }), 'BILLING').display,
    ).toBe('NONE');
    expect(OP.hasNew({ portal: null })).toBe(false);
    expect(OP.hasNew(row({ REQUIRED: { display: 'NEW', obtainedAt: null } }))).toBe(true);
  });

  it('offers five columns, Delivery / Color / Billing on by default', () => {
    const cols = OP.columns();
    expect(cols.map((c) => c.label)).toEqual([
      'Delivery',
      'Color',
      'Billing',
      'Portal: Contact',
      'Portal: Required',
    ]);
    expect(cols.filter((c) => c.defaultOn).map((c) => c.label)).toEqual([
      'Delivery',
      'Color',
      'Billing',
    ]);
    expect(new Set(cols.map((c) => c.key)).size).toBe(5);
    const r = row({ COLOR: { display: 'REVIEWED', obtainedAt: '2026-09-01T12:00:00Z' } });
    expect(cols[1]!.plain(r)).toMatch(/^Reviewed 2026-09-0[12]$/);
  });
});

describe('formatters', () => {
  it('formats North American phone numbers and leaves the rest alone', () => {
    expect(OP.fmtPhone('5551234567')).toBe('(555) 123-4567');
    expect(OP.fmtPhone('+1 555.123.4567')).toBe('(555) 123-4567');
    expect(OP.fmtPhone('555-1234')).toBe('555-1234');
    expect(OP.fmtPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(OP.fmtPhone(null)).toBe('');
  });

  it('says how long ago, in words', () => {
    expect(OP.relTime(new Date(NOW - 10_000).toISOString(), NOW)).toBe('just now');
    expect(OP.relTime(new Date(NOW - 4 * 60_000).toISOString(), NOW)).toBe('4 min ago');
    expect(OP.relTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3 h ago');
    expect(OP.relTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2 days ago');
    expect(OP.relTime(null, NOW)).toBe('never');
  });

  it('humanizes keys', () => {
    expect(OP.humanize('preferredDeliveryDate')).toBe('Preferred delivery date');
    expect(OP.humanize('billing_zip')).toBe('Billing zip');
  });
});

describe('list filters', () => {
  const textCol: Col = {
    key: 'customer',
    label: 'Customer',
    plain: (r) => String(r.customer ?? ''),
  };
  const moneyCol: Col = { key: 'total', label: 'Total', plain: (r) => String(r.total ?? '') };
  const dateCol: Col = {
    key: 'createdAt',
    label: 'Created',
    filter: 'date',
    plain: (r) => String(r.createdAt ?? ''),
  };
  const statusCol: Col = {
    key: 'status',
    label: 'Status',
    filter: 'status',
    plain: (r) => String(r.status),
  };
  const choiceCol: Col = {
    key: 'qbo',
    label: 'QuickBooks',
    filter: 'choice',
    plain: (r) => String(r.qbo),
  };

  it('text: contains, case-insensitive; numbers take > < = comparisons', () => {
    expect(OP.matchFilter(textCol, { customer: 'Summit Clinic' }, 'clin')).toBe(true);
    expect(OP.matchFilter(textCol, { customer: 'Summit Clinic' }, 'zoo')).toBe(false);
    expect(OP.matchFilter(textCol, { customer: 'x' }, '')).toBe(true);
    expect(OP.matchFilter(moneyCol, { total: '8662.50' }, '>1000')).toBe(true);
    expect(OP.matchFilter(moneyCol, { total: '8662.50' }, '<= 8,000')).toBe(false);
    expect(OP.matchFilter(moneyCol, { total: '' }, '>0')).toBe(false);
  });

  it('dates: any, presets, no date, and a from/to range', () => {
    const r = { createdAt: new Date(2026, 8, 18, 10).toISOString() };
    expect(OP.matchFilter(dateCol, r, { preset: '', from: '', to: '' }, NOW)).toBe(true);
    expect(OP.matchFilter(dateCol, r, { preset: '7', from: '', to: '' }, NOW)).toBe(true);
    expect(OP.matchFilter(dateCol, { createdAt: '2026-08-01' }, { preset: '7' }, NOW)).toBe(false);
    expect(OP.matchFilter(dateCol, { createdAt: '' }, { preset: 'none' }, NOW)).toBe(true);
    expect(OP.matchFilter(dateCol, r, { preset: 'none' }, NOW)).toBe(false);
    expect(
      OP.matchFilter(dateCol, r, { preset: 'custom', from: '2026-09-18', to: '2026-09-18' }, NOW),
    ).toBe(true);
    expect(OP.matchFilter(dateCol, r, { preset: 'custom', from: '2026-09-19', to: '' }, NOW)).toBe(
      false,
    );
    expect(OP.matchFilter(dateCol, r, { preset: 'year' }, NOW)).toBe(true);
  });

  it('status takes several; choice and portal take one', () => {
    expect(OP.matchFilter(statusCol, { status: 'READY' }, ['NEW', 'READY'])).toBe(true);
    expect(OP.matchFilter(statusCol, { status: 'BLOCKED' }, ['NEW', 'READY'])).toBe(false);
    expect(OP.matchFilter(statusCol, { status: 'BLOCKED' }, [])).toBe(true);
    expect(OP.matchFilter(choiceCol, { qbo: 'Linked' }, 'Linked')).toBe(true);
    expect(OP.matchFilter(choiceCol, { qbo: 'Not pushed' }, 'Linked')).toBe(false);
    const delivery = OP.columns()[0]!;
    const r = row({ DELIVERY: { display: 'NA', obtainedAt: null } });
    expect(OP.matchFilter(delivery, r, 'NA')).toBe(true);
    expect(OP.matchFilter(delivery, r, 'NEW')).toBe(false);
    expect(OP.matchFilter(delivery, row({}), 'NONE')).toBe(true);
  });

  it('combines every filter, including "has anything unreviewed", and counts them', () => {
    const cols = [textCol, statusCol, ...OP.columns()];
    const a = row(
      { BILLING: { display: 'NEW', obtainedAt: null } },
      { customer: 'Acme', status: 'NEW' },
    );
    const b = row({}, { customer: 'Acme', status: 'NEW' });
    const state = { cols: { customer: 'acme' } as Record<string, unknown>, unreviewed: true };
    expect(OP.rowPasses(cols, state, a)).toBe(true);
    expect(OP.rowPasses(cols, state, b)).toBe(false);
    expect(OP.activeCount(cols, state)).toBe(2);
    state.cols.status = ['READY'];
    expect(OP.rowPasses(cols, state, a)).toBe(false);
    expect(OP.activeCount(cols, state)).toBe(3);
    expect(OP.activeCount(cols, { cols: { status: [], customer: '  ' }, unreviewed: false })).toBe(
      0,
    );
  });
});

describe('answers, readably', () => {
  it('lays out delivery: address, dock, timing, contacts with formatted phones', () => {
    const html = OP.answersHtml('DELIVERY', {
      line1: '1 Main St',
      line2: 'Suite 4',
      city: 'Denver',
      region: 'CO',
      postalCode: '80202',
      country: 'US',
      loadingDock: 'Yes',
      deliveryTiming: 'Weekday mornings',
      preferredDeliveryDate: '2026-10-05',
      specialInstructions: 'Call ahead',
      pocName: 'Pat Doe',
      pocPhone: '3035550100',
      pocEmail: 'pat@example.com',
      secondaryPocName: 'Sam Roe',
      secondaryPocPhone: '720-555-0199',
    });
    expect(html).toContain('1 Main St<br>Suite 4<br>Denver, CO 80202<br>US');
    expect(html).toContain('Loading dock');
    expect(html).toContain('Weekday mornings');
    expect(html).toContain('(303) 555-0100');
    expect(html).toContain('(720) 555-0199');
    expect(html).toContain('Secondary point of contact');
    expect(html).toContain('mailto:pat@example.com');
  });

  it('lays out billing, saying when the contact is the primary one', () => {
    const html = OP.answersHtml('BILLING', {
      billingAddress: '9 Elm',
      billingCity: 'Boulder',
      billingState: 'CO',
      billingZip: '80301',
      billingContactSameAsPrimary: true,
      billingPhone: '3035550111',
    });
    expect(html).toContain('9 Elm<br>Boulder, CO 80301');
    expect(html).toContain('Same as the primary point of contact');
    expect(html).toContain('(303) 555-0111');
  });

  it('lists each colour area with its brand and code', () => {
    const html = OP.answersHtml('COLOR', {
      selections: { structure_frame_paint: { legs: { brand: 'cardinal', code: 'T009-BL01' } } },
      totalUpcharge: 150,
    });
    expect(html).toContain('Structure frame paint');
    expect(html).toContain('Legs');
    expect(html).toContain('Cardinal T009-BL01');
    expect(html).toContain('$150.00');
  });

  it('renders shapes it does not know key by key, escaped, instead of failing', () => {
    const html = OP.answersHtml('DELIVERY', {
      deliveryWindow: '<b>AM</b>',
      nested: { dockHeight: 48 },
    });
    expect(html).toContain('Delivery window');
    expect(html).toContain('&lt;b&gt;AM&lt;/b&gt;');
    expect(html).toContain('Dock height');
    expect(OP.answersHtml('BILLING', 'just some text')).toContain('just some text');
    expect(OP.answersHtml('DELIVERY', null)).toBe('');
  });

  it('shows status only for contact and required', () => {
    expect(OP.answersHtml('CONTACT', { anything: 1 })).toBe('');
    expect(OP.answersHtml('REQUIRED', { anything: 1 })).toBe('');
  });

  it('notices a delivery change and nothing else', () => {
    const base = [
      { kind: 'DELIVERY', display: 'NEW', obtainedAt: 'a', answers: { line1: 'x' } },
      { kind: 'COLOR', display: 'NONE', obtainedAt: null, answers: null },
    ];
    const colorOnly = [base[0]!, { ...base[1]!, display: 'NEW' }];
    const moved = [{ ...base[0]!, answers: { line1: 'y' } }, base[1]!];
    expect(OP.deliverySignature(base)).toBe(OP.deliverySignature(colorOnly));
    expect(OP.deliverySignature(base)).not.toBe(OP.deliverySignature(moved));
  });
});
