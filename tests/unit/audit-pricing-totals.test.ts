import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { versionTotals, countedRevenueByLine } from '../../src/proposals/analytics.js';
import { compareVersions } from '../../src/proposals/compare.js';
import type { ProposalItem, ProposalSection } from '../../src/proposals/sections.js';
import { Money, priceForMarginMinor } from '../../src/lib/money.js';
import { sequenceOf, formatNumber, isUniqueViolation } from '../../src/lib/documentNumber.js';
import { formatProposalNumber } from '../../src/proposals/status.js';

/**
 * Audit: proposal totals (src/proposals/analytics.ts versionTotals — what the price
 * snapshot, accepted order and QuickBooks are built from) against the browser's own
 * total (public/app.js versionTotalMinor — the Versions table, and the same formula
 * the printed document uses), plus money/number helpers.
 */

// ---------------------------------------------------------------- client loader
const APP = readFileSync(join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');

/** Pull a top-level `  function name(...) { ... }` out of app.js by brace matching. */
function clientSource(name: string): string {
  const start = APP.indexOf(`\n  function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in public/app.js`);
  let i = APP.indexOf('{', start);
  let depth = 0;
  for (; i < APP.length; i++) {
    const c = APP[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  return APP.slice(start + 1, i + 1);
}

type ClientVersion = { sections: unknown; items: unknown };
const clientVersionTotal = new Function(
  [
    'overrideMinor',
    'metaAmount',
    'stdFreightOf',
    'discountOf',
    'isBundleChild',
    'countedRevenueByIndex',
    'versionTotalMinor',
  ]
    .map(clientSource)
    .join('\n') + '\nreturn versionTotalMinor;',
)() as (v: ClientVersion) => number;

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const meta = (data: Record<string, unknown>) => [{ id: 'meta', data }];

describe('screen/document vs snapshot total parity (PASS)', () => {
  it('client versionTotalMinor === server versionTotals().total over 400 random well-formed proposals', () => {
    const r = prng(7);
    const int = (m: number) => Math.floor(r() * m);
    for (let k = 0; k < 400; k++) {
      const items: Record<string, unknown>[] = [];
      const n = 1 + int(12);
      for (let i = 0; i < n; i++) {
        const roll = r();
        if (roll < 0.15) items.push({ lineType: 'GROUP', name: 'G' + i });
        else if (roll < 0.35)
          items.push({
            lineType: 'PRODUCT',
            name: '— part ' + i,
            quantity: int(5),
            rateMinor: r() < 0.5 ? 0 : int(50_000),
          });
        else
          items.push({
            lineType: 'PRODUCT',
            name: 'Item ' + i,
            quantity: int(10),
            rateMinor: int(500_000),
            tpFreightMinor: r() < 0.3 ? int(20_000) : 0,
          });
      }
      const sections = meta({
        discountMode: r() < 0.5 ? 'PCT' : 'AMT',
        discountPct: int(30),
        discountAmountMinor: int(100_000),
        taxAmountMinor: int(80_000),
        structureFreightMinor: r() < 0.5 ? int(90_000) : undefined,
        freightMinor: int(40_000),
        matsFreightMinor: int(30_000),
        stdFreightOn: r() < 0.5,
        stdFreightMinor: int(10_000),
        tbdTax: r() < 0.2 ? '1,234.56' : '',
      });
      expect(clientVersionTotal({ sections, items }), `case ${k}`).toBe(
        versionTotals(items, sections).total,
      );
    }
  });

  it('a bundle is counted once on both sides even when its components carry rates', () => {
    const items = [
      { lineType: 'PRODUCT', name: 'Slackline Bundle', quantity: 1, rateMinor: 10947 },
      { lineType: 'PRODUCT', name: '— Line', quantity: 1, rateMinor: 5000 },
      { lineType: 'PRODUCT', name: '— Ratchet', quantity: 1, rateMinor: 5947 },
    ];
    expect(versionTotals(items, []).subtotal).toBe(10947);
    expect(clientVersionTotal({ items, sections: [] })).toBe(10947);
    expect(countedRevenueByLine(items)).toEqual([10947, 0, 0]);
  });

  it('discount is clamped to [0, subtotal] in both modes', () => {
    const items = [{ lineType: 'PRODUCT', name: 'x', quantity: 1, rateMinor: 1000 }];
    expect(
      versionTotals(items, meta({ discountMode: 'AMT', discountAmountMinor: 5000 })).total,
    ).toBe(0);
    expect(
      versionTotals(items, meta({ discountMode: 'AMT', discountAmountMinor: -500 })).total,
    ).toBe(1000);
  });
});

describe('totals — fixed defects (formerly it.fails)', () => {
  it('BUG: a bundle component saved without lineType totals differently in the browser and in the snapshot', () => {
    // Server isBundleChild defaults lineType to PRODUCT; public/app.js isBundleChild
    // requires `lineType === 'PRODUCT'` literally. BuilderLineSchema makes lineType
    // optional, so an API-written / imported row can arrive without it.
    const items = [
      { lineType: 'PRODUCT', name: 'Bundle', quantity: 1, rateMinor: 10000 },
      { name: '— Component', quantity: 1, rateMinor: 4000 },
    ];
    expect(clientVersionTotal({ items, sections: [] })).toBe(versionTotals(items, []).total);
  });

  it('BUG: percentage discount is float math — 1.15% of $30.00 is 34.5¢, rounds to 34¢ not 35¢', () => {
    // discountOf: Math.round((3000 * 1.15) / 100) → 3449.9999999999995 / 100 → 34.
    // BuilderMetaSchema accepts any finite discountPct in [0,100], so 2-dp percentages are legal.
    const items = [{ lineType: 'PRODUCT', name: 'x', quantity: 1, rateMinor: 3000 }];
    expect(versionTotals(items, meta({ discountPct: 1.15 })).discount).toBe(35);
  });

  it('BUG: a typed TBD override of "1.005" parses through parseFloat×100 to 100¢, not half-up 101¢', () => {
    const t = versionTotals([], meta({ tbdTax: '1.005' }));
    expect(t.tax).toBe(101);
  });
});

describe('version comparison (compareVersions)', () => {
  const s: ProposalSection[] = [];
  it('reports added / removed / changed lines keyed by ref (PASS)', () => {
    const a = { sections: s, items: [{ ref: 'a', rateMinor: 1 }, { ref: 'b' }] as ProposalItem[] };
    const b = { sections: s, items: [{ ref: 'a', rateMinor: 2 }, { ref: 'c' }] as ProposalItem[] };
    const d = compareVersions(a, b).items.map((e) => `${e.kind}:${e.path}`);
    expect(d.sort()).toEqual(['added:item:c', 'changed:item:a', 'removed:item:b']);
  });

  it('BUG: lines without a ref (or with a duplicate ref) collapse into one map key, hiding changes', () => {
    const a = {
      sections: s,
      items: [{ rateMinor: 100 }, { rateMinor: 200 }] as unknown as ProposalItem[],
    };
    const b = {
      sections: s,
      items: [{ rateMinor: 999 }, { rateMinor: 200 }] as unknown as ProposalItem[],
    };
    expect(compareVersions(a, b).items.length).toBeGreaterThan(0);
  });
});

describe('money & document-number helpers (PASS)', () => {
  it('Money.parse handles negative sub-dollar amounts and single-digit cents', () => {
    expect(Money.parse('-0.5', 'usd').minorUnits).toBe(-50n);
    expect(Money.parse('-0.05', 'USD').toString()).toBe('-0.05 USD');
    expect(Money.parse('0.5', 'USD').minorUnits).toBe(50n);
    expect(() => Money.parse('1e3', 'USD')).toThrow();
    expect(() => Money.parse('1.234', 'USD')).toThrow();
    expect(() => Money.ofMinor(1.5, 'USD')).toThrow();
  });

  it('priceForMarginMinor always earns at least the requested margin (to the bps) across a grid', () => {
    for (const cost of [1, 7, 99, 1234, 60000, 100_000])
      for (const m of [0, 0.01, 12.5, 33.33, 40, 66.67, 99.99]) {
        const price = priceForMarginMinor(cost, m);
        const bps = BigInt(Math.round(m * 100));
        // Rounded half-up, so price is within half a cent of cost/(1-m).
        const exact2x = (2n * BigInt(cost) * 10_000n) / (10_000n - bps);
        expect(price * 2n - exact2x).toBeGreaterThanOrEqual(-1n);
        expect(price * 2n - exact2x).toBeLessThanOrEqual(2n);
      }
  });

  it('sequenceOf / formatNumber round-trip, and foreign or malformed numbers count as 0', () => {
    const prefix = 'P-2026-';
    for (const seq of [1, 79, 999_999])
      expect(sequenceOf(formatNumber(prefix, seq), prefix)).toBe(seq);
    expect(formatProposalNumber(2026, 42)).toBe('P-2026-000042');
    expect(sequenceOf('P-2025-000500', prefix)).toBe(0);
    expect(sequenceOf('P-2026-abc', prefix)).toBe(0);
    expect(sequenceOf('P-2026--5', prefix)).toBe(0);
    expect(sequenceOf(null, prefix)).toBe(0);
  });

  it('isUniqueViolation matches the target column in either array or string form', () => {
    expect(isUniqueViolation({ code: 'P2002', meta: { target: ['number'] } }, 'number')).toBe(true);
    expect(
      isUniqueViolation({ code: 'P2002', meta: { target: 'Proposal_number_key' } }, 'number'),
    ).toBe(true);
    expect(
      isUniqueViolation({ code: 'P2002', meta: { target: ['proposalVersionId'] } }, 'number'),
    ).toBe(false);
    expect(isUniqueViolation({ code: 'P2025' }, 'number')).toBe(false);
  });
});
