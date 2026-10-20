import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/**
 * A catalog product name prints on the proposal exactly as the catalog spells it.
 *
 * The PRODUCT row used to run the name through tc(), the heading title-caser, whose
 * /\b([a-z])/ rule raised every letter after any non-letter: the catalog's
 * "Passthrough Freight Charge for Belt(s) / Boot(s)" (3RD-FREIGHT) printed as
 * "Passthrough Freight Charge For Belt(S) / Boot(S)".
 *
 * Fixed twice over: the product row (and the item column of the freight-notes grid,
 * which prints the same name) no longer title-cases at all, and tc() itself — still
 * used for section, sub-section and note headings — no longer capitalises a letter
 * after "(" or an apostrophe inside a word.
 */

interface Doc {
  lines: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  meta: Record<string, unknown>;
  crossBorder: null;
}

const root = join(__dirname, '..', '..', 'public');
const src = readFileSync(join(root, 'proposal-document.js'), 'utf8');
const appSrc = readFileSync(join(root, 'app.js'), 'utf8');

let SSGProposalDocument: { useRules: (r: unknown) => void; html: (doc: Doc) => string };

beforeAll(() => {
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
    discountExpiration: () => '',
    rt: (s: string) => s,
    freightTbdNote: 'Freight TBD.',
    documentUser: () => ({ name: 'Bryan Shepherd', title: 'President' }),
    fmtDate: (v: string) => String(v),
    todayISO: () => '2026-10-20',
  });
});

afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

function doc(lines: Array<Record<string, unknown>>): Doc {
  return {
    meta: {},
    crossBorder: null,
    lines,
    totals: {
      subtotal: 32188,
      discountPct: 0,
      discount: 0,
      tpFreight: 0,
      tax: 0,
      structureFreight: 0,
      matsFreight: 0,
      stdFreight: 0,
      total: 32188,
      deposit: 16094,
      weight: 0,
    },
  };
}

const FREIGHT = 'Passthrough Freight Charge for Belt(s) / Boot(s)';

describe('proposal document — product names print verbatim', () => {
  it('prints the 3RD-FREIGHT catalog name exactly as written', () => {
    const html = SSGProposalDocument.html(
      doc([
        { lineType: 'GROUP', name: 'Flex Accessories' },
        { lineType: 'SUBGROUP', name: 'Belts' },
        {
          lineType: 'PRODUCT',
          name: 'Leather Belt (Size - XX Small)',
          sku: 'FLEX-BELT-XXS',
          quantity: 1,
          rateMinor: 22688,
        },
        { lineType: 'PRODUCT', name: FREIGHT, sku: '3RD-FREIGHT', quantity: 1, rateMinor: 9500 },
      ]),
    );
    expect(html).toContain(`>${FREIGHT}</td>`);
    expect(html).toContain('>Leather Belt (Size - XX Small)</td>');
    expect(html).not.toContain('Belt(S)');
    expect(html).not.toContain('Charge For');
  });

  it('does not title-case a lower-case product name or one with an apostrophe', () => {
    const html = SSGProposalDocument.html(
      doc([
        { lineType: 'GROUP', name: 'Swings' },
        {
          lineType: 'PRODUCT',
          name: "kid's cuddle swing",
          sku: 'CS-1',
          quantity: 1,
          rateMinor: 100,
        },
      ]),
    );
    // esc() writes the apostrophe as &#39;.
    expect(html).toContain('>kid&#39;s cuddle swing</td>');
    expect(html).not.toMatch(/Kid.{1,6}S Cuddle/);
  });

  it('prints the product name verbatim in the freight-notes grid too', () => {
    const html = SSGProposalDocument.html(
      doc([
        { lineType: 'GROUP', name: 'Flex Accessories' },
        {
          lineType: 'PRODUCT',
          name: FREIGHT,
          sku: '3RD-FREIGHT',
          quantity: 1,
          rateMinor: 9500,
          returnable: 'NO',
        },
      ]),
    );
    const grid = /<thead><tr><th[^>]*>Item<\/th>[\s\S]*?<\/tbody>/.exec(html);
    expect(grid, 'freight-notes grid not found').toBeTruthy();
    expect(grid![0]).toContain(`>${FREIGHT}</td>`);
  });
});

describe('proposal document — heading title case', () => {
  it('still title-cases headings, but not a letter after "(" or an apostrophe mid-word', () => {
    const html = SSGProposalDocument.html(
      doc([
        { lineType: 'GROUP', name: 'flex accessories' },
        { lineType: 'SUBGROUP', name: 'belt(s) and boot(s)' },
        { lineType: 'NOTE', name: "kid's corner (optional) x-small/large", description: 'n' },
        { lineType: 'PRODUCT', name: 'Belt', sku: 'B', quantity: 1, rateMinor: 100 },
      ]),
    );
    expect(html).toContain('>Flex Accessories</td>');
    expect(html).toContain('>Belt(s) And Boot(s)');
    expect(html).toContain('>Kid&#39;s Corner (Optional) X-Small/Large</b>');
    expect(html).not.toContain('(S)');
  });
});

describe('app.js tc() — the builder’s heading title-caser', () => {
  const line = /^ {2}function tc\(s\) \{.*\}$/m.exec(appSrc);
  const tc = vm.runInNewContext(`(${line![0].trim()})`) as (s: string) => string;

  it('is found in app.js', () => {
    expect(line).toBeTruthy();
  });

  it.each([
    ['belt(s) / boot(s)', 'Belt(s) / Boot(s)'],
    ["kid's corner", "Kid's Corner"],
    ['cuddle swings (optional)', 'Cuddle Swings (Optional)'],
    ['x-small', 'X-Small'],
    ['summit soar series', 'Summit Soar Series'],
    ['3rd party freight', '3rd Party Freight'],
    ['McDonald', 'McDonald'],
    ['', ''],
  ])('%j → %j', (input, want) => {
    expect(tc(input)).toBe(want);
  });
});
