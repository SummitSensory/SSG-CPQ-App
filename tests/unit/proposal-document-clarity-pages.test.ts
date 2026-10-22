import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  computeClarityPages,
  type ClaritySnapshot,
  type ClarityLine,
} from '../../src/proposals/clarityPages.js';
import {
  DEFAULT_FRAME_CODE_CONVENTION,
  LEGACY_FRAME_CODE_CONVENTION,
} from '../../src/proposals/frameCode.js';

const root = join(__dirname, '..', '..', 'public');
const src = readFileSync(join(root, 'proposal-document.js'), 'utf8');

let SSGProposalDocument: { useRules: (r: unknown) => void; html: (doc: unknown) => string };

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
    proposalModelCode: () => 'R-2MBL1Z-10x8',
    discountLabel: () => 'Discount',
    discountExpiration: () => '',
    rt: (s: string) => s,
    freightTbdNote: 'Freight TBD.',
    documentUser: () => ({
      name: 'Bryan Shepherd',
      title: 'President',
      phone: '720-440-7850',
      email: 'bryan@summitsensory.com',
    }),
    fmtDate: (v: string) => String(v),
    todayISO: () => '2026-10-22',
  });
});

afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

const LINES: ClarityLine[] = [
  { lineType: 'GROUP', name: 'R-2MBL1Z — Itemized' },
  { lineType: 'PRODUCT', sku: 'A-2216', quantity: 1 },
  { lineType: 'PRODUCT', sku: '150045', quantity: 1 },
  { lineType: 'PRODUCT', sku: 'A-2349', quantity: 1 },
  { lineType: 'PRODUCT', sku: 'SSG-SA-CWM', quantity: 1 },
  { lineType: 'PRODUCT', sku: 'R-SSG-1008CLM', quantity: 1 },
  { lineType: 'PRODUCT', sku: 'SSUSP67', quantity: 4 },
  { lineType: 'PRODUCT', sku: 'SSUSP72', quantity: 1 },
];

const SNAPSHOT: ClaritySnapshot = computeClarityPages(
  { code: 'R-2MBL1Z-10x8', lines: LINES, answers: { length: 10, width: 8 } },
  [
    { version: 0, convention: LEGACY_FRAME_CODE_CONVENTION },
    { version: 1, convention: DEFAULT_FRAME_CODE_CONVENTION },
  ],
)!;

/** $19,563.28 — the Baby Fold's total, deposit half of it. */
function doc(meta: Record<string, unknown>) {
  return {
    number: 'P-2026-000144',
    version: 2,
    orgName: 'The Baby Fold',
    meta,
    crossBorder: null,
    lines: [
      { lineType: 'GROUP', name: 'R-2MBL1Z — Itemized', description: "Frame Dimensions: 10' × 8'" },
      {
        lineType: 'PRODUCT',
        name: 'Vertical Post',
        sku: 'A-2245',
        quantity: 1,
        rateMinor: 1956328,
      },
    ],
    totals: {
      subtotal: 1956328,
      discountPct: 0,
      discount: 0,
      tpFreight: 0,
      tax: 0,
      structureFreight: 0,
      matsFreight: 0,
      stdFreight: 0,
      total: 1956328,
      deposit: 978164,
      weight: 0,
    },
  };
}

const on = (extra: Record<string, unknown> = {}) => ({
  clarityPages: {
    whatsIncluded: true,
    beforeYouSign: true,
    hidden: [],
    snapshot: SNAPSHOT,
    ...extra,
  },
});

describe('clarity pages in the proposal document', () => {
  it('prints neither page on a proposal without the setting (legacy proposals)', () => {
    const html = SSGProposalDocument.html(doc({}));
    expect(html).not.toContain('data-page-break="whats-included"');
    expect(html).not.toContain('data-page-break="before-you-sign"');
  });

  it('What’s Included sits before the pricing header; Before You Sign before Acceptance', () => {
    const html = SSGProposalDocument.html(doc(on()));
    const inc = html.indexOf('data-page-break="whats-included"');
    const header = html.indexOf('Proposal Prepared By');
    const sign = html.indexOf('data-page-break="before-you-sign"');
    const acc = html.indexOf('data-page-break="acceptance"');
    expect(inc).toBeGreaterThan(-1);
    expect(inc).toBeLessThan(header);
    expect(sign).toBeGreaterThan(header);
    expect(sign).toBeLessThan(acc);
    expect(html).toContain('data-page-name="What&#39;s Included"');
    expect(html).toContain('data-page-name="Before You Sign"');
  });

  it('draws the decoded code, its panel and both sections', () => {
    const html = SSGProposalDocument.html(doc(on()));
    expect(html).toContain('R-2MBL1Z-10<span class="x">x</span>8');
    expect(html).toContain('grid-template-columns:repeat(6,1fr)');
    expect(html).toContain('Rectangle Frame');
    expect(html).toContain('Climbing Wall: Wall Mounted');
    expect(html).toContain('4 column wraps · 1 ladder wrap');
  });

  it('total and deposit are the document’s own figures, with the deposit terms', () => {
    const html = SSGProposalDocument.html(doc(on()));
    const page = html.slice(html.indexOf('data-page-break="before-you-sign"'));
    expect(page).toContain('$19,563.28');
    expect(page).toContain('$9,781.64');
    expect(page).toContain('50% at signing · balance due prior to shipment');
    expect(page).toContain('Bryan Shepherd, President');
    expect(page).toContain('720-440-7850 · bryan@summitsensory.com');
  });

  it('no deposit panel when the deposit is not shown on the proposal', () => {
    const html = SSGProposalDocument.html(doc({ ...on(), showDeposit: false }));
    const page = html.slice(html.indexOf('data-page-break="before-you-sign"'));
    expect(page).not.toContain('Deposit to begin production');
    expect(page).toContain('$19,563.28');
  });

  it('each page toggles on its own, and a hidden scope item is left off', () => {
    const onlySign = SSGProposalDocument.html(
      doc(on({ whatsIncluded: false, hidden: ['installation'] })),
    );
    expect(onlySign).not.toContain('data-page-break="whats-included"');
    expect(onlySign).toContain('data-page-break="before-you-sign"');
    expect(onlySign).not.toContain('Professional installation can be quoted separately');
    expect(onlySign).toContain('Receiving &amp; interior moving');

    const onlyInc = SSGProposalDocument.html(doc(on({ beforeYouSign: false })));
    expect(onlyInc).toContain('data-page-break="whats-included"');
    expect(onlyInc).not.toContain('data-page-break="before-you-sign"');
  });

  it('prints nothing while the snapshot is missing (code could not be read)', () => {
    const html = SSGProposalDocument.html(doc(on({ snapshot: null })));
    expect(html).not.toContain('data-page-break="whats-included"');
  });
});
