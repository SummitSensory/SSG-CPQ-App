import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/**
 * A cross-border proposal's per-GROUP "Subtotal" row used to print "USD $X,XXX.XX" —
 * the same cross-border-aware formatter used by the bottom totals block. That extra
 * "USD " made the subtotal's text wider than the fixed 78px Amount column, and
 * because the column is `table-layout:fixed` (it does not grow to fit), the text
 * overflowed the cell by a different amount for every group depending on how many
 * digits followed — so the subtotals never lined up with each other or with the
 * Amount column above them, unlike every ordinary line-item amount, which is always
 * plain "$X,XXX.XX" and fits comfortably.
 *
 * Fixed by printing the group subtotal the same plain way as the line items above
 * it. "USD" stays on the bottom totals block, where it belongs — a CAD estimate
 * prints right beneath it there, which is the only place the currency is actually
 * ambiguous.
 */

interface Doc {
  lines: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  meta: Record<string, unknown>;
  crossBorder: { applicable: boolean; fx: { rate: string } } | null;
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

function crossBorderDoc(): Doc {
  return {
    meta: {},
    crossBorder: { applicable: true, fx: { rate: '1.3896' } },
    lines: [
      { lineType: 'GROUP', name: 'Summit Flex Series' },
      {
        lineType: 'PRODUCT',
        name: 'Spider Cage W/ Hardware',
        sku: 'A-2200',
        quantity: 1,
        rateMinor: 541440,
      },
    ],
    totals: {
      subtotal: 541440,
      discountPct: 0,
      discount: 0,
      tpFreight: 0,
      tax: 0,
      structureFreight: 0,
      matsFreight: 0,
      stdFreight: 0,
      total: 541440,
      deposit: 270720,
      weight: 0,
    },
  };
}

/** The value cell of the one and only "Subtotal" row in the line-item table. */
function subtotalCellText(html: string): string {
  const m =
    /<td[^>]*>Subtotal<\/td><td[^>]*>([^<]*)<\/td>/.exec(html) ??
    /<td colspan="4"[^>]*>Subtotal<\/td>\s*<td[^>]*>([^<]*)<\/td>/.exec(html);
  expect(m, 'no group Subtotal row found in the rendered document').toBeTruthy();
  return m![1]!;
}

describe('proposal document — group subtotal formatting on a cross-border proposal', () => {
  it('prints the group subtotal as plain "$X,XXX.XX", not "USD $X,XXX.XX"', () => {
    const html = SSGProposalDocument.html(crossBorderDoc());
    expect(subtotalCellText(html)).toBe('$5,414.40');
  });

  it('still prints "USD $" on the bottom totals block, where a CAD estimate sits beneath it', () => {
    const html = SSGProposalDocument.html(crossBorderDoc());
    expect(html).toMatch(/Total payable to Summit[\s\S]*?USD \$/);
  });
});
