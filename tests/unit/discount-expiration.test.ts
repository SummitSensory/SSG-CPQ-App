import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { withDiscountExpirationFor, type ProposalSection } from '../../src/proposals/sections.js';

/**
 * A discount on a proposal expires with the proposal unless the rep sets an earlier
 * date (meta.discountExpiration) — and it never expires later than the proposal
 * does, however the two dates were arrived at. The rule lives once, in
 * public/app.js, and is handed to the document renderer, so it is tested here from
 * the shipped file itself and then through the renderer.
 */

const app = readFileSync(join(__dirname, '..', '..', 'public', 'app.js'), 'utf8').split(/\r?\n/);

function clientFn<T extends (...a: never[]) => unknown>(name: string): T {
  const i = app.findIndex((l) => l.startsWith(`  function ${name}(`));
  const j = app.findIndex((l, k) => k > i && l === '  }');
  expect(i, `${name} not found in public/app.js`).toBeGreaterThanOrEqual(0);
  const src = app.slice(i, j + 1).join('\n');
  return new Function(`${src}\nreturn ${name};`)() as T;
}

type Meta = Record<string, unknown>;
const discountExpiration = clientFn<(m: Meta | null) => string>('discountExpiration');

describe('discountExpiration (public/app.js)', () => {
  it('expires with the proposal when there is no override', () => {
    expect(discountExpiration({ expiration: '2026-10-09' })).toBe('2026-10-09');
    expect(discountExpiration({ expiration: '2026-10-09', discountExpiration: '' })).toBe(
      '2026-10-09',
    );
  });

  it('uses an override that is earlier than the proposal expiration', () => {
    expect(discountExpiration({ expiration: '2026-10-09', discountExpiration: '2026-10-05' })).toBe(
      '2026-10-05',
    );
  });

  it('never extends past the proposal expiration', () => {
    expect(discountExpiration({ expiration: '2026-10-09', discountExpiration: '2026-12-31' })).toBe(
      '2026-10-09',
    );
  });

  it('uses the override alone when the proposal has no expiration', () => {
    expect(discountExpiration({ discountExpiration: '2026-10-05' })).toBe('2026-10-05');
  });

  it('is empty when neither date is set, and ignores anything that is not a date', () => {
    expect(discountExpiration({})).toBe('');
    expect(discountExpiration(null)).toBe('');
    expect(discountExpiration({ expiration: '2026-10-09', discountExpiration: 'soon' })).toBe(
      '2026-10-09',
    );
  });
});

interface Doc {
  lines: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  meta: Meta;
  crossBorder: null;
}

let D: { useRules: (r: unknown) => void; html: (doc: Doc) => string };

beforeAll(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {};
  vm.runInThisContext(
    readFileSync(join(__dirname, '..', '..', 'public', 'proposal-document.js'), 'utf8'),
  );
  D = (globalThis as unknown as { window: { SSGProposalDocument: typeof D } }).window
    .SSGProposalDocument;
  D.useRules({
    overrideMinor: () => 0,
    depositOf: (t: number) => Math.round(t / 2),
    depositPct: () => 50,
    stripOptional: (n: string) => n,
    showsFreightTbd: () => false,
    proposalModelCode: () => '',
    discountLabel: () => 'Discount',
    discountExpiration,
    rt: (s: string) => s,
    freightTbdNote: 'Freight TBD.',
    documentUser: () => ({ name: 'Rep', title: 'Sales' }),
    fmtDate: (v: string) => String(v),
    todayISO: () => '2026-10-02',
  });
});

afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

function doc(meta: Meta): Doc {
  return {
    meta,
    crossBorder: null,
    lines: [
      { lineType: 'PRODUCT', name: 'Spider Cage', sku: 'A-2200', quantity: 1, rateMinor: 100000 },
    ],
    totals: {
      subtotal: 100000,
      discountPct: 10,
      discount: 10000,
      tpFreight: 0,
      tax: 0,
      structureFreight: 0,
      matsFreight: 0,
      stdFreight: 0,
      total: 90000,
      deposit: 45000,
      weight: 0,
    },
  };
}

function printedExpiry(html: string): string {
  const m = /Discount expires ([^<]*)</.exec(html);
  expect(m, 'no discount expiry printed').toBeTruthy();
  return m![1]!;
}

describe('proposal document — discount expiry line', () => {
  it('prints the proposal expiration when there is no override', () => {
    expect(printedExpiry(D.html(doc({ expiration: '2026-10-09' })))).toBe('2026-10-09');
  });

  it('prints an earlier override', () => {
    const html = D.html(doc({ expiration: '2026-10-09', discountExpiration: '2026-10-05' }));
    expect(printedExpiry(html)).toBe('2026-10-05');
  });

  it('prints the proposal expiration, not a later override', () => {
    const html = D.html(doc({ expiration: '2026-10-09', discountExpiration: '2026-11-30' }));
    expect(printedExpiry(html)).toBe('2026-10-09');
  });

  it('says "with this proposal" when there is no date at all', () => {
    expect(printedExpiry(D.html(doc({})))).toBe('with this proposal');
  });
});

describe('withDiscountExpirationFor (cloning a version)', () => {
  const meta = (data: Meta): ProposalSection => ({
    id: 'meta',
    type: 'CUSTOMER_INFO',
    title: 'Proposal',
    order: 0,
    enabled: true,
    data,
  });
  const dataOf = (out: ProposalSection[]) => out.find((s) => s.id === 'meta')?.data;

  it('keeps an override that is still ahead and before the new expiration', () => {
    const out = withDiscountExpirationFor(
      [meta({ discountExpiration: '2026-10-05' })],
      '2026-10-02',
      '2026-10-09',
    );
    expect(dataOf(out)).toEqual({ discountExpiration: '2026-10-05' });
  });

  it('drops an override already in the past', () => {
    const out = withDiscountExpirationFor(
      [meta({ expiration: '2026-10-09', discountExpiration: '2026-09-20' })],
      '2026-10-02',
      '2026-10-09',
    );
    expect(dataOf(out)).toEqual({ expiration: '2026-10-09' });
  });

  it('drops an override on or after the new expiration', () => {
    const out = withDiscountExpirationFor(
      [meta({ discountExpiration: '2026-10-09' })],
      '2026-10-02',
      '2026-10-09',
    );
    expect(dataOf(out)).toEqual({});
  });

  it('keeps a future override when the version has no expiration at all', () => {
    const out = withDiscountExpirationFor(
      [meta({ discountExpiration: '2026-12-01' })],
      '2026-10-02',
      null,
    );
    expect(dataOf(out)).toEqual({ discountExpiration: '2026-12-01' });
  });

  it('leaves sections without an override, and the input array, untouched', () => {
    const input = [meta({ discountExpiration: '2026-09-01' })];
    withDiscountExpirationFor(input, '2026-10-02', '2026-10-09');
    expect(input[0]?.data).toEqual({ discountExpiration: '2026-09-01' });
    const plain = [meta({ expiration: '2026-10-09' })];
    expect(withDiscountExpirationFor(plain, '2026-10-02', '2026-10-09')).toEqual(plain);
  });
});
