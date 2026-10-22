import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface Doc {
  lines: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  meta: Record<string, unknown>;
  crossBorder: null;
}

const root = join(__dirname, '..', '..', 'public');
const src = readFileSync(join(root, 'proposal-document.js'), 'utf8');

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
/**
 * The itemized heading cell is styled uppercase. The frame code inside it must print
 * exactly as named — its dimension separator is a lowercase x (SQ-H2MBL2T2-10x10),
 * never 10X10 — while "— Itemized" keeps the heading style.
 */
describe('itemized frame heading', () => {
  it('prints the frame code untransformed and the rest of the heading as before', () => {
    const html = SSGProposalDocument.html(
      doc([
        {
          lineType: 'GROUP',
          name: 'SQ-H2MBL2T2-10x10 — Itemized',
          description: "Frame Dimensions: 10' × 10'",
        },
        { lineType: 'PRODUCT', name: 'Vertical Post', sku: 'A-2245', quantity: 4, rateMinor: 1000 },
      ]),
    );
    expect(html).toContain('<span style="text-transform:none;">SQ-H2MBL2T2-10x10</span>');
    expect(html).toContain('— Itemized');
    expect(html).toContain('Frame Dimensions: 10');
  });

  it('a heading that is not an itemized frame is untouched', () => {
    const html = SSGProposalDocument.html(
      doc([{ lineType: 'GROUP', name: 'Adventure Components' }]),
    );
    expect(html).not.toContain('text-transform:none;">Adventure');
    expect(html).toContain('Adventure Components');
  });
});
