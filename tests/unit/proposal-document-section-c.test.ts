import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/**
 * Section C ("Canadian Import Terms") is a fully data-driven, ordered list — see
 * src/crossborder/sectionC.ts. Nothing about which rows exist, their labels, or a
 * TEXT row's wording is hardcoded in public/proposal-document.js; this file only
 * knows how to print d.crossBorder.sectionCItems, which arrives already resolved
 * and order-sorted from crossBorderStateFor(). Same for the Acceptance-page
 * addendum (d.crossBorder.acceptanceText) and the tariff-audit clause
 * (d.crossBorder.auditLanguageText) — both are org-default-or-per-proposal-override
 * text resolved server-side, never fixed strings in this file.
 *
 * Section A/B labels are purely additive headings around content that already
 * renders the same way on a Canadian proposal — they must never appear on a
 * domestic one.
 */

interface CrossBorder {
  applicable: boolean;
  fx?: { rate?: string | null };
  result?: {
    lines?: Array<{ usdMinor: number | null; category?: string }>;
    separatelyPayable?: { usdMinor: number };
  } | null;
  importerOfRecord?: string | null;
  customsBrokerName?: string | null;
  customsBrokerAddress?: string | null;
  countryOfOrigin?: string | null;
  tariffClassificationCode?: string | null;
  tariff9979Claimed?: boolean | null;
  gstHstTreatment?: string | null;
  hostSystemModel?: string | null;
  sectionCItems?: Array<Record<string, unknown>>;
  acceptanceText?: string | null;
  auditLanguageText?: string | null;
  sectionBSubtext?: string | null;
  sectionBSubtextSizePt?: number | null;
}

interface Doc {
  lines: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  meta: Record<string, unknown>;
  crossBorder: CrossBorder | null;
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

function baseTotals(): Record<string, number> {
  return {
    subtotal: 100000,
    discountPct: 0,
    discount: 0,
    tpFreight: 0,
    tax: 0,
    structureFreight: 0,
    matsFreight: 0,
    stdFreight: 0,
    total: 100000,
    deposit: 50000,
    weight: 0,
  };
}

function baseLines(): Array<Record<string, unknown>> {
  return [
    { lineType: 'GROUP', name: 'Summit Flex Series' },
    { lineType: 'PRODUCT', name: 'Spider Cage', sku: 'A-2200', quantity: 1, rateMinor: 100000 },
  ];
}

function canadianDoc(cb: Partial<CrossBorder>): Doc {
  return {
    meta: {},
    lines: baseLines(),
    totals: baseTotals(),
    crossBorder: { applicable: true, fx: { rate: '1.35' }, ...cb },
  };
}

function domesticDoc(): Doc {
  return { meta: {}, lines: baseLines(), totals: baseTotals(), crossBorder: null };
}

describe('proposal document — Section C (Canadian Import Terms)', () => {
  it('prints nothing when the proposal has no Section C items at all', () => {
    const html = SSGProposalDocument.html(canadianDoc({ sectionCItems: [] }));
    expect(html).not.toContain('Canadian Import Terms');
  });

  it('renders a BOUND row’s live value and a TEXT row’s own wording, in list order', () => {
    const html = SSGProposalDocument.html(
      canadianDoc({
        importerOfRecord: 'SUMMIT',
        sectionCItems: [
          {
            id: '1',
            kind: 'BOUND',
            boundField: 'importerOfRecord',
            label: 'Importer of record',
            order: 0,
          },
          {
            id: '2',
            kind: 'TEXT',
            label: 'CUSMA',
            text: 'Summit certifies the goods as originating.',
            order: 1,
          },
        ],
      }),
    );
    expect(html).toContain('Section C — Canadian Import Terms');
    // Row labels print title-cased (tc()) regardless of how they were typed in.
    const iorIdx = html.indexOf('Importer Of Record');
    const iorValIdx = html.indexOf('Summit Sensory Gym', iorIdx);
    const cusmaIdx = html.indexOf('CUSMA');
    expect(iorIdx).toBeGreaterThan(-1);
    expect(iorValIdx).toBeGreaterThan(iorIdx);
    expect(cusmaIdx).toBeGreaterThan(iorValIdx);
    expect(html).toContain('Summit certifies the goods as originating.');
  });

  it('prints "Not yet determined" for a BOUND row with no data behind it, never a blank or a false zero', () => {
    const html = SSGProposalDocument.html(
      canadianDoc({
        countryOfOrigin: null,
        sectionCItems: [
          {
            id: '1',
            kind: 'BOUND',
            boundField: 'countryOfOrigin',
            label: 'Country of origin',
            order: 0,
          },
        ],
      }),
    );
    expect(html).toContain('Not yet determined');
  });

  it('sums only duty/surtax/brokerage categories for the "Duties, surtax and brokerage" row, never the separate GST/HST sales-tax line', () => {
    const html = SSGProposalDocument.html(
      canadianDoc({
        sectionCItems: [
          {
            id: '1',
            kind: 'BOUND',
            boundField: 'dutiesEstimate',
            label: 'Duties, surtax and brokerage',
            order: 0,
          },
        ],
        result: {
          lines: [
            { category: 'CUSTOMS_DUTY', usdMinor: 5000 },
            { category: 'BROKERAGE', usdMinor: 2500 },
            // If this sales-tax line were included, the row would read $107.50
            // instead of the correct $75.00 — the exact bug this test guards.
            { category: 'SALES_TAX', usdMinor: 3250 },
          ],
        },
      }),
    );
    expect(html).toContain('$75.00');
    expect(html).not.toContain('$107.50');
  });

  it('skips a blank TEXT row instead of printing an empty value', () => {
    const html = SSGProposalDocument.html(
      canadianDoc({
        sectionCItems: [
          { id: '1', kind: 'TEXT', label: 'Special note', text: '  ', order: 0 },
          {
            id: '2',
            kind: 'TEXT',
            label: 'Design intent documentation',
            text: 'On request.',
            order: 1,
          },
        ],
      }),
    );
    expect(html).not.toContain('Special note');
    expect(html).not.toContain('Special Note');
    // Title-cased (tc()) on the way out, like every other row label.
    expect(html).toContain('Design Intent Documentation');
  });

  it('renders a renamed BOUND row’s label while still tracking the live value', () => {
    const html = SSGProposalDocument.html(
      canadianDoc({
        hostSystemModel: 'Summit Soar S2',
        sectionCItems: [
          {
            id: '1',
            kind: 'BOUND',
            boundField: 'hostSystemModel',
            label: 'This is a totally custom label',
            order: 0,
          },
        ],
      }),
    );
    // Title-cased (tc()) on the way out — the admin's own wording, capitalized.
    expect(html).toContain('This Is A Totally Custom Label');
    expect(html).toContain('Summit Soar S2');
  });

  it('never renders Section C, or Section A/B labels, on a domestic proposal', () => {
    const html = SSGProposalDocument.html(domesticDoc());
    expect(html).not.toContain('Canadian Import Terms');
    expect(html).not.toContain('Section A');
    expect(html).not.toContain('Section B');
  });

  it('prints Section A and Section B labels on a Canadian proposal', () => {
    const html = SSGProposalDocument.html(canadianDoc({}));
    expect(html).toContain('Section A — Therapeutic Apparatus');
    expect(html).toContain('Section B — Delivery and Post-Importation Services');
  });
});

describe('proposal document — Acceptance-page text and the tariff-audit clause', () => {
  it('prints nothing on the Acceptance page when acceptanceText is blank/unset', () => {
    const html = SSGProposalDocument.html(canadianDoc({ acceptanceText: null }));
    // The addendum's own div style (10.5px, line-height:1.55) is distinct from the
    // "Sign below to accept..." sentence above it (11.5px, line-height:1.6), so this
    // checks specifically for the addendum block, not acceptance-page text in general.
    expect(html).not.toContain('font-size:10.5px;color:#5b6478;line-height:1.55');
  });

  it('prints the resolved acceptance text on the Acceptance page when set', () => {
    const html = SSGProposalDocument.html(
      canadianDoc({ acceptanceText: 'This proposal is subject to CBSA final determination.' }),
    );
    expect(html).toContain('This proposal is subject to CBSA final determination.');
  });

  it('prints no audit clause when auditLanguageText is blank/unset', () => {
    const html = SSGProposalDocument.html(canadianDoc({ auditLanguageText: null }));
    expect(html).not.toContain('In the Event of a CBSA Reassessment');
  });

  it('prints the resolved audit-language clause when set', () => {
    const html = SSGProposalDocument.html(
      canadianDoc({ auditLanguageText: 'Summit will absorb the difference on any reassessment.' }),
    );
    expect(html).toContain('In the Event of a CBSA Reassessment');
    expect(html).toContain('Summit will absorb the difference on any reassessment.');
  });

  it('escapes admin-authored text so it cannot inject markup', () => {
    const html = SSGProposalDocument.html(
      canadianDoc({ acceptanceText: '<script>alert(1)</script>' }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('proposal document — Section B and Section C subtext', () => {
  it('prints nothing under a Section C row when it has no subtext', () => {
    const html = SSGProposalDocument.html(
      canadianDoc({
        sectionCItems: [{ id: '1', kind: 'TEXT', label: 'CUSMA', text: 'Certified.', order: 0 }],
      }),
    );
    // The subtext block's own font-size-in-px signature never appears at all.
    // Checks the subtext block's own stable marker, not its inline CSS — a cosmetic
    // style change to cbSubtextHtml must not make this negative assertion vacuous.
    expect(html).not.toContain('data-role="cb-subtext"');
  });

  it('renders a Section C row’s subtext through rt() (the shared bold/italic renderer) at the requested size', () => {
    // useRules() mocks rt() as an identity passthrough in this harness (its own
    // markup processing is exercised elsewhere) — this asserts cbSubtextHtml
    // actually routes subtext through rt(), sized, not that rt() itself works.
    const html = SSGProposalDocument.html(
      canadianDoc({
        sectionCItems: [
          {
            id: '1',
            kind: 'TEXT',
            label: 'CUSMA',
            text: 'Certified.',
            order: 0,
            subtext: 'Confirmed with **broker** on *2026-09-15*.',
            subtextSizePt: 11,
          },
        ],
      }),
    );
    expect(html).toContain('font-size:11px;color:#5c6157;line-height:1.5;');
    expect(html).toContain('Confirmed with **broker** on *2026-09-15*.');
  });

  it('clamps a Section C row subtext size to 12pt even if a stray value slipped through', () => {
    const html = SSGProposalDocument.html(
      canadianDoc({
        sectionCItems: [
          {
            id: '1',
            kind: 'TEXT',
            label: 'CUSMA',
            text: 'Certified.',
            order: 0,
            subtext: 'Oversized on purpose.',
            subtextSizePt: 40,
          },
        ],
      }),
    );
    expect(html).toContain('font-size:12px;color:#5c6157;line-height:1.5;');
  });

  it('prints nothing for Section B subtext when unset', () => {
    const html = SSGProposalDocument.html(canadianDoc({ sectionBSubtext: null }));
    // Checks the subtext block's own stable marker, not its inline CSS — a cosmetic
    // style change to cbSubtextHtml must not make this negative assertion vacuous.
    expect(html).not.toContain('data-role="cb-subtext"');
  });

  it('prints the resolved Section B subtext at its resolved size', () => {
    const html = SSGProposalDocument.html(
      canadianDoc({
        sectionBSubtext: 'Freight excludes appointment delivery.',
        sectionBSubtextSizePt: 8,
      }),
    );
    expect(html).toContain('font-size:8px;color:#5c6157;line-height:1.5;');
    expect(html).toContain('Freight excludes appointment delivery.');
  });

  it('never renders Section B subtext on a domestic proposal', () => {
    const html = SSGProposalDocument.html(domesticDoc());
    // Checks the subtext block's own stable marker, not its inline CSS — a cosmetic
    // style change to cbSubtextHtml must not make this negative assertion vacuous.
    expect(html).not.toContain('data-role="cb-subtext"');
  });
});

describe('proposal document — Configuration Schedule heading', () => {
  function bundleDoc(canadian: boolean): Doc {
    return {
      meta: {},
      totals: baseTotals(),
      crossBorder: canadian ? { applicable: true, fx: { rate: '1.35' } } : null,
      lines: [
        { lineType: 'GROUP', name: 'Summit Flex Series' },
        {
          lineType: 'PRODUCT',
          name: 'Complete System',
          sku: 'FLEX-1',
          quantity: 1,
          rateMinor: 500000,
        },
        {
          lineType: 'PRODUCT',
          name: '— Suspension Frame',
          sku: 'FLEX-1A',
          quantity: 1,
          rateMinor: 0,
        },
        { lineType: 'PRODUCT', name: '— Impact Floor', sku: 'FLEX-1B', quantity: 1, rateMinor: 0 },
      ],
    };
  }

  it('prints the Configuration Schedule heading once, before the bundle-child rows, on a Canadian proposal', () => {
    const html = SSGProposalDocument.html(bundleDoc(true));
    const headingIdx = html.indexOf('Configuration Schedule — Components of the System Above');
    const firstChildIdx = html.indexOf('Suspension Frame');
    expect(headingIdx).toBeGreaterThan(-1);
    expect(firstChildIdx).toBeGreaterThan(headingIdx);
    // Printed exactly once even though there are two bundle-child rows.
    expect(html.split('Configuration Schedule — Components of the System Above').length - 1).toBe(
      1,
    );
  });

  it('never prints the Configuration Schedule heading on a domestic proposal', () => {
    const html = SSGProposalDocument.html(bundleDoc(false));
    expect(html).not.toContain('Configuration Schedule');
  });

  it('prints one heading per bundled system, not one for the whole document', () => {
    const html = SSGProposalDocument.html({
      meta: {},
      totals: baseTotals(),
      crossBorder: { applicable: true, fx: { rate: '1.35' } },
      lines: [
        { lineType: 'GROUP', name: 'Summit Flex Series' },
        {
          lineType: 'PRODUCT',
          name: 'Complete System',
          sku: 'FLEX-1',
          quantity: 1,
          rateMinor: 500000,
        },
        {
          lineType: 'PRODUCT',
          name: '— Suspension Frame',
          sku: 'FLEX-1A',
          quantity: 1,
          rateMinor: 0,
        },
        { lineType: 'GROUP', name: 'Summit Foundation System' },
        {
          lineType: 'PRODUCT',
          name: 'Complete System',
          sku: 'FND-1',
          quantity: 1,
          rateMinor: 300000,
        },
        { lineType: 'PRODUCT', name: '— Base Plate', sku: 'FND-1A', quantity: 1, rateMinor: 0 },
      ],
    });
    expect(html.split('Configuration Schedule — Components of the System Above').length - 1).toBe(
      2,
    );
  });
});
