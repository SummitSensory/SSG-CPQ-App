import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/**
 * The layout rules a Canadian proposal follows and a domestic one does not — see
 * public/proposal-document.js:
 *
 *   - Section A is ONE priced line (the complete system, at the Section A total), with
 *     every component beneath it as the Configuration Schedule, priced "Included".
 *   - No deposit prints, whatever meta.showDeposit says.
 *   - The Section A/B/C headings are the top tier: black, bold, larger than anything
 *     they contain.
 *   - The import-charges block lists every charge it totals (the import sales tax was
 *     summed but not listed), and its landed cost is the document's own total plus
 *     those charges.
 *   - Section C and the cross-border terms are marked data-flow so the paginator breaks
 *     between their rows instead of clipping them.
 */

interface Line {
  category: string;
  label: string;
  usdMinor: number | null;
  status?: string;
  includedInSellerTotal?: boolean;
  percent?: string | null;
}

interface Doc {
  title?: string;
  sectionAName?: string;
  lines: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  meta: Record<string, unknown>;
  crossBorder: Record<string, unknown> | null;
}

const src = readFileSync(join(__dirname, '..', '..', 'public', 'proposal-document.js'), 'utf8');

let SSGProposalDocument: { useRules: (r: unknown) => void; html: (doc: Doc) => string };

beforeAll(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {};
  vm.runInThisContext(src);
  SSGProposalDocument = (
    globalThis as unknown as {
      window: { SSGProposalDocument: typeof SSGProposalDocument };
    }
  ).window.SSGProposalDocument;
  SSGProposalDocument.useRules({
    overrideMinor: () => 0,
    depositOf: (t: number) => Math.round(t / 2),
    depositPct: () => 50,
    stripOptional: (n: string) => n,
    showsFreightTbd: () => false,
    proposalModelCode: () => 'K-4002',
    discountLabel: () => 'Discount',
    discountExpiration: () => '',
    rt: (s: string) => s,
    freightTbdNote: 'Freight TBD.',
    documentUser: () => ({ name: 'Bryan Shepherd', title: 'President' }),
    fmtDate: (v: string) => String(v),
    todayISO: () => '2026-09-26',
  });
});

afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

/** P-2026-000171's lines and totals, reduced to what the layout reads. */
function lines(): Array<Record<string, unknown>> {
  return [
    { lineType: 'GROUP', name: 'SUMMIT SOAR SERIES', description: 'Engineered swing frame.' },
    {
      lineType: 'PRODUCT',
      name: 'Summit Soar S2 - Mobile Free-Standing Swing Frame',
      sku: 'K-4002',
      quantity: 1,
      rateMinor: 441100,
      tpFreightMinor: 2500,
    },
    { lineType: 'GROUP', name: 'SUMMIT SOAR MATS & ACCESSORIES' },
    {
      lineType: 'PRODUCT',
      name: 'Gusset Plate Padding',
      sku: 'SFGPC',
      quantity: 2,
      rateMinor: 17550,
    },
  ];
}

function totals(): Record<string, number> {
  return {
    subtotal: 476200,
    discountPct: 0,
    discount: 0,
    tpFreight: 2500,
    tax: 0,
    structureFreight: 129145,
    matsFreight: 49430,
    stdFreight: 0,
    total: 657275,
    deposit: 328638,
    weight: 0,
  };
}

function canadian(extra: Partial<Doc> = {}, cb: Record<string, unknown> = {}): Doc {
  return {
    title: 'Summit Soar S2',
    meta: { showDeposit: true },
    lines: lines(),
    totals: totals(),
    crossBorder: { applicable: true, fx: { rate: '1.4145' }, ...cb },
    ...extra,
  };
}

function domestic(): Doc {
  return { ...canadian(), crossBorder: null };
}

describe('Canadian proposal — Section A is one priced line', () => {
  it('prints the Section A name, model, quantity 1 and the Section A total on one line', () => {
    const html = SSGProposalDocument.html(
      canadian({ sectionAName: 'Summit Soar Series Complete Therapeutic System — Model K-4002' }),
    );
    const row = /<tr data-role="cb-section-a-line"[^>]*>([\s\S]*?)<\/tr>/.exec(html);
    const cells = row?.[1] ?? '';
    expect(cells).toContain('Summit Soar Series Complete Therapeutic System — Model K-4002');
    expect(cells).toContain('K-4002');
    expect(cells).toContain('>1<');
    // Rate and Amount are both the Section A subtotal.
    expect(cells.split('$4,762.00').length - 1).toBe(2);
  });

  it('falls back to meta.sectionAName, then the proposal title', () => {
    const fromMeta = SSGProposalDocument.html(
      canadian({ meta: { sectionAName: 'Typed In The Builder' } }),
    );
    expect(fromMeta).toContain('Typed In The Builder');
    const fromTitle = SSGProposalDocument.html(canadian());
    expect(/<tr data-role="cb-section-a-line"[^>]*>[\s\S]*?Summit Soar S2/.test(fromTitle)).toBe(
      true,
    );
  });

  it('prints the first section description once, under the Section A line', () => {
    const html = SSGProposalDocument.html(canadian());
    expect(html.split('Engineered swing frame.').length - 1).toBe(1);
    expect(html.indexOf('Engineered swing frame.')).toBeGreaterThan(
      html.indexOf('cb-section-a-line'),
    );
  });

  it('lists every component as Included, with no per-line price, subtotal or freight row', () => {
    const html = SSGProposalDocument.html(canadian());
    expect(html).toContain('Configuration Schedule — Components of the System Above');
    expect(html.split('>Included<').length - 1).toBe(2);
    // The per-line figures are gone from the table…
    expect(html).not.toContain('$4,411.00');
    expect(html).not.toContain('$351.00');
    expect(/<td colspan="4"[^>]*>Subtotal<\/td>/.test(html)).toBe(false);
    // …and the per-line third-party freight is carried only in Section B.
    expect(html).not.toContain('+ Third-Party Freight');
    expect(html).toMatch(/Third-Party Freight<\/span><span[^>]*><span[^>]*>USD \$25\.00/);
  });

  it('leaves a domestic proposal itemized and priced line by line', () => {
    const html = SSGProposalDocument.html(domestic());
    expect(html).not.toContain('cb-section-a-line');
    expect(html).not.toContain('Configuration Schedule');
    expect(html).toContain('$4,411.00');
    expect(html).not.toContain('>Included<');
  });
});

describe('Canadian proposal — no deposit', () => {
  it('prints no deposit line and no deposit clause even when showDeposit is on', () => {
    const html = SSGProposalDocument.html(canadian());
    expect(html).not.toContain('Deposit Due');
    expect(html).not.toContain('with a deposit of');
  });

  it('still prints the deposit on a domestic proposal', () => {
    const html = SSGProposalDocument.html(domestic());
    expect(html).toContain('Deposit Due (50%)');
    expect(html).toContain('with a deposit of');
  });
});

describe('Canadian proposal — section headings', () => {
  it('prints Section A, B and C headings black, bold and larger than their contents', () => {
    const html = SSGProposalDocument.html(
      canadian(
        {},
        {
          sectionCItems: [{ id: '1', kind: 'TEXT', label: 'Classification', text: 'X.', order: 0 }],
        },
      ),
    );
    const headings = html.match(/<div data-role="cb-section-heading"[^>]*>[^<]*<\/div>/g) ?? [];
    expect(headings.map((h) => h.replace(/<[^>]+>/g, ''))).toEqual([
      'Section A — Therapeutic Apparatus',
      'Section B — Delivery and Post-Importation Services',
      'Section C — Canadian Import Terms',
    ]);
    for (const h of headings) {
      expect(h).toContain('font-size:15px');
      expect(h).toContain('font-weight:700');
      expect(h).toContain('color:#000');
      expect(h).toContain('data-keep-next');
    }
  });
});

describe('Canadian proposal — estimated charges payable at import', () => {
  const borderLines: Line[] = [
    { category: 'TARIFF_SURTAX', label: 'Estimated Tariff', usdMinor: 0, percent: '0' },
    { category: 'BROKERAGE', label: 'Customs Brokerage', usdMinor: 40000 },
    { category: 'SALES_TAX', label: 'GST + QST', usdMinor: 5990, percent: '14.975' },
  ];

  function withBorder(): Doc {
    return canadian(
      {},
      {
        result: {
          lines: borderLines.map((l) => ({
            status: 'ESTIMATED',
            includedInSellerTotal: false,
            ...l,
          })),
          separatelyPayable: { usdMinor: 45990 },
          // The engine's own figure, deliberately wrong here: the document must not use it.
          estimatedLandedCost: { usdMinor: 45990 },
        },
      },
    );
  }

  it('lists the import sales-tax line it totals', () => {
    const html = SSGProposalDocument.html(withBorder());
    expect(html).toMatch(/GST \+ QST <span[^>]*>14\.975%<\/span>/);
    expect(html).toContain('USD $59.90');
  });

  it('prints landed cost as the total payable to Summit plus the charges payable at import', () => {
    const html = SSGProposalDocument.html(withBorder());
    // 6,572.75 payable to Summit + 459.90 at import.
    expect(html).toMatch(/Estimated total landed cost[\s\S]*?USD \$7,032\.65/);
  });
});

describe('Canadian proposal — pagination hints and one body size', () => {
  const withTerms = {
    sectionCItems: [{ id: '1', kind: 'TEXT', label: 'Classification', text: 'X.', order: 0 }],
    crossBorderTerms: [
      { id: 't1', title: 'Currency', text: 'USD controls.', order: 0, condition: 'ALWAYS' },
    ],
  };

  it('marks Section C and the cross-border terms data-flow, headings data-keep-next', () => {
    const html = SSGProposalDocument.html(canadian({}, withTerms));
    expect(html.split('<div data-flow').length - 1).toBe(2);
    expect(html).toMatch(/<div data-keep-next[^>]*>Cross-Border Terms<\/div>/);
  });

  it('prints Section C rows and the cross-border terms at the same 11px body size', () => {
    const html = SSGProposalDocument.html(canadian({}, withTerms));
    expect(html).toContain('<div data-flow style="font-size:11px;');
    expect(html).toContain('<div style="display:flex;gap:14px;font-size:11px;');
    expect(html).not.toContain('font-size:9.5px;line-height:1.6;color:#5c6157;');
  });

  it('keeps the paragraphs of a multi-paragraph Section C row', () => {
    const html = SSGProposalDocument.html(
      canadian(
        {},
        {
          sectionCItems: [
            { id: '1', kind: 'TEXT', label: 'Reassessment', text: 'One.\n\nTwo.', order: 0 },
          ],
        },
      ),
    );
    expect(html).toMatch(/white-space:pre-line;">One\.\n\nTwo\./);
  });
});
