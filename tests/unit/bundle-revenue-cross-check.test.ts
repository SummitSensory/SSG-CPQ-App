import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { versionTotals } from '../../src/proposals/analytics.js';

/**
 * Bundle revenue (a bundle counted once, not once per row) is implemented three
 * times — src/proposals/analytics.ts (`countedRevenueMinor`), public/app.js and
 * public/proposal-document.js (both `countedRevenueByIndex`) — each carrying a
 * "must mirror"/"the two must agree" comment, but nothing asserted they actually
 * do. A future edit to the bundle rule applied to only one or two copies would
 * silently reintroduce the exact $11,268.45 → $22,536.90 double-count
 * bundle-totals.test.ts exists to catch, in whichever copy wasn't updated.
 *
 * This is the real Obie Pro fixture from bundle-totals.test.ts (same numbers, same
 * shape), run through all three implementations and checked for agreement:
 *   - analytics.ts via versionTotals().subtotal, the source of truth
 *   - app.js's copy, extracted and executed directly (the file self-boots against
 *     `document`/`window` at load time and cannot be required as-is in Node, so
 *     only the two pure functions this rule needs — `isBundleChild` and
 *     `countedRevenueByIndex` — are pulled out by source text and evaluated)
 *   - proposal-document.js's copy, exercised the same way
 *     proposal-document-subtotal-alignment.test.ts does: load the real module via
 *     vm and read the number it actually prints for the bundle's group subtotal
 */

const meta = [{ id: 'meta', data: {} }];

const bundle = [
  { lineType: 'GROUP', name: 'OBIE PRO INTERACTIVE PROJECTION SYSTEM - PEDIATRIC BUNDLE' },
  {
    lineType: 'PRODUCT',
    sku: 'OBIE-BUNDLE',
    name: 'Obie Pro Interactive Projection System - Pediatric Bundle',
    quantity: 1,
    rateMinor: 1_126_845,
    costEach: 0,
  },
  {
    lineType: 'PRODUCT',
    sku: '901240',
    name: '— Obie Mobile Cart',
    quantity: 1,
    rateMinor: 337_500,
    costEach: 250_000,
  },
  {
    lineType: 'PRODUCT',
    sku: 'WG0267',
    name: '— Obie Pro Interactive Projection System - Pediatric Game Bundle',
    quantity: 1,
    rateMinor: 776_250,
    costEach: 575_000,
  },
  {
    lineType: 'PRODUCT',
    sku: '901238',
    name: '— Obie Drop Ceiling Kit',
    quantity: 1,
    rateMinor: 13_095,
    costEach: 9_700,
  },
];

const EXPECTED_MINOR = 1_126_845; // the parent's own price — the bundle counted once

/** Pull one top-level `function name(...) { ... }` out of a source file by brace
 *  matching, so a pure helper can be evaluated on its own without loading (and
 *  therefore executing) the rest of a non-modular browser file. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function countedRevenueByIndexFrom(file: string, lines: unknown[]): number[] {
  const source = readFileSync(join(__dirname, '..', '..', 'public', file), 'utf8');
  const body = [
    extractFunction(source, 'isBundleChild'),
    extractFunction(source, 'countedRevenueByIndex'),
    'return countedRevenueByIndex(lines);',
  ].join('\n');
  const fn = new Function('lines', body) as (l: unknown[]) => number[];
  return fn(lines);
}

describe('bundle revenue math agrees across all three implementations', () => {
  it('analytics.ts (the source of truth) counts the bundle once', () => {
    expect(versionTotals(bundle, meta).subtotal).toBe(EXPECTED_MINOR);
  });

  it("app.js's countedRevenueByIndex sums to the same total", () => {
    const perLine = countedRevenueByIndexFrom('app.js', bundle);
    const sum = perLine.reduce((a, b) => a + b, 0);
    expect(sum).toBe(EXPECTED_MINOR);
  });

  it("proposal-document.js's countedRevenueByIndex sums to the same total", () => {
    const perLine = countedRevenueByIndexFrom('proposal-document.js', bundle);
    const sum = perLine.reduce((a, b) => a + b, 0);
    expect(sum).toBe(EXPECTED_MINOR);
  });
});

describe('proposal-document.js prints the same figure it computed, not a re-derived one', () => {
  interface Doc {
    lines: Array<Record<string, unknown>>;
    totals: Record<string, number>;
    meta: Record<string, unknown>;
    crossBorder: null;
  }
  let SSGProposalDocument: { useRules: (r: unknown) => void; html: (doc: Doc) => string };

  beforeAll(() => {
    const src = readFileSync(join(__dirname, '..', '..', 'public', 'proposal-document.js'), 'utf8');
    (globalThis as unknown as { window: Record<string, unknown> }).window = {};
    vm.runInThisContext(src);
    SSGProposalDocument = (
      globalThis as unknown as { window: { SSGProposalDocument: typeof SSGProposalDocument } }
    ).window.SSGProposalDocument;
    SSGProposalDocument.useRules({
      overrideMinor: () => 0,
      depositOf: (t: number) => Math.round(t / 2),
      depositPct: () => 50,
      stripOptional: (n: string) => n,
      showsFreightTbd: () => false,
      proposalModelCode: () => '',
      discountLabel: () => 'Discount',
      rt: (s: string) => s,
      freightTbdNote: 'Freight TBD.',
      documentUser: () => ({ name: 'Bryan Shepherd', title: 'President' }),
      fmtDate: (v: string) => String(v),
      todayISO: () => '2026-09-01',
    });
  });

  afterAll(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('prints "$11,268.45" as the bundle\'s group subtotal, not "$22,536.90"', () => {
    const totals = versionTotals(bundle, meta);
    const html = SSGProposalDocument.html({
      lines: bundle,
      meta: {},
      crossBorder: null,
      totals: {
        subtotal: totals.subtotal,
        discountPct: 0,
        discount: 0,
        tpFreight: 0,
        tax: 0,
        structureFreight: 0,
        matsFreight: 0,
        stdFreight: 0,
        total: totals.total,
        deposit: Math.round(totals.total / 2),
        weight: 0,
      },
    });
    const m =
      /<td[^>]*>Subtotal<\/td><td[^>]*>([^<]*)<\/td>/.exec(html) ??
      /<td colspan="4"[^>]*>Subtotal<\/td>\s*<td[^>]*>([^<]*)<\/td>/.exec(html);
    expect(m, 'no group Subtotal row found in the rendered document').toBeTruthy();
    expect(m![1]).toBe('$11,268.45');
  });
});
