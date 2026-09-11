import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/**
 * The "Delivery, Returns & Freight Notes" block used to print one run-on sentence
 * per item ("Item: Returnable: No · Additional freight: No · Freight calculated:
 * Yes"), with only the first word of a multi-word label capitalized ("Additional
 * freight", not "Additional Freight").
 *
 * Fixed to: Title Case every flag label, and lay the flags out as a borderless
 * grid (one column per flag that at least one item actually sets) instead of a
 * sentence.
 *
 * A line's free-text `description` is a different thing from these flags — it's
 * spec/context that reads as part of the product itself (frame dimensions,
 * "Floor padding 2" thick", "All mounting hardware — 634 pieces...") and has
 * always printed inline under that product's own row. An earlier version of this
 * grid redesign mistakenly relocated it down here too; it stays inline.
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

function baseDoc(lines: Array<Record<string, unknown>>): Doc {
  return {
    meta: {},
    crossBorder: null,
    lines,
    totals: {
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
    },
  };
}

/** The "Delivery, Returns & Freight Notes" section only, for scoped assertions. */
function bottomSection(html: string): string {
  const m =
    /Delivery, Returns &amp; Freight Notes<\/div>([\s\S]*?)<\/div>\s*<div data-page-break/.exec(
      html,
    );
  expect(m, 'bottom notes section not found').toBeTruthy();
  return m![1]!;
}

describe('proposal document — Delivery, Returns & Freight Notes', () => {
  it('title-cases multi-word flag labels without touching item names or Yes/No values', () => {
    const html = SSGProposalDocument.html(
      baseDoc([
        { lineType: 'GROUP', name: 'Cuddle Swings' },
        {
          lineType: 'PRODUCT',
          name: 'cuddle swing',
          sku: 'CS-1',
          quantity: 1,
          rateMinor: 100000,
          returnable: 'NO',
          addlFreight: 'NO',
          freightCalc: 'YES',
        },
      ]),
    );
    const section = bottomSection(html);
    expect(section).toContain('Returnable');
    expect(section).toContain('Additional Freight');
    expect(section).toContain('Freight Calculated');
    expect(section).not.toContain('Additional freight');
    expect(section).not.toContain('Freight calculated');
    expect(section).toContain('Yes');
    expect(section).toContain('No');
  });

  it('renders the flags as a table/grid, not a joined sentence, with only columns that are actually used', () => {
    const html = SSGProposalDocument.html(
      baseDoc([
        { lineType: 'GROUP', name: 'Swings' },
        {
          lineType: 'PRODUCT',
          name: 'Cuddle Swing',
          sku: 'CS-1',
          quantity: 1,
          rateMinor: 100000,
          returnable: 'NO',
          freightCalc: 'YES',
        },
      ]),
    );
    const section = bottomSection(html);
    expect(section).toContain('<table');
    expect(section).toContain('<th');
    expect(section).not.toContain(' · ');
    // addlFreight was never set on any line, so its column must not appear.
    expect(section).not.toContain('Additional Freight');
  });

  it('keeps an item description printing inline under its own row, not in the bottom grid', () => {
    const html = SSGProposalDocument.html(
      baseDoc([
        { lineType: 'GROUP', name: 'Swings' },
        {
          lineType: 'PRODUCT',
          name: 'Cuddle Swing',
          sku: 'CS-1',
          quantity: 1,
          rateMinor: 100000,
          returnable: 'NO',
          freightCalc: 'YES',
          description: 'Ships fully assembled in a single crate.',
        },
      ]),
    );
    // Printed inline, before the "Delivery, Returns & Freight Notes" section starts.
    const bottomStart = html.indexOf('Delivery, Returns &amp; Freight Notes');
    expect(bottomStart).toBeGreaterThan(-1);
    expect(html.slice(0, bottomStart)).toContain('Ships fully assembled in a single crate.');

    // Not duplicated into the bottom grid/notes section.
    const section = bottomSection(html);
    expect(section).not.toContain('Ships fully assembled in a single crate.');
  });

  it('has no border styling inside the grid', () => {
    const html = SSGProposalDocument.html(
      baseDoc([
        { lineType: 'GROUP', name: 'Swings' },
        {
          lineType: 'PRODUCT',
          name: 'Cuddle Swing',
          sku: 'CS-1',
          quantity: 1,
          rateMinor: 100000,
          returnable: 'NO',
          freightCalc: 'YES',
        },
      ]),
    );
    const section = bottomSection(html);
    // Strip the section's own outer wrapper (which legitimately carries the
    // divider separating this whole section from the pricing summary above)
    // before checking the grid content for stray borders.
    const innerStart = section.indexOf('<table');
    const inner = section.slice(innerStart);
    expect(inner).not.toMatch(/border(?!-collapse)/);
  });

  it('still omits the whole section when no line has a flag, even if it has a description', () => {
    const html = SSGProposalDocument.html(
      baseDoc([
        { lineType: 'GROUP', name: 'Swings' },
        {
          lineType: 'PRODUCT',
          name: 'Cuddle Swing',
          sku: 'CS-1',
          quantity: 1,
          rateMinor: 100000,
          description: 'Ships fully assembled in a single crate.',
        },
      ]),
    );
    expect(html).not.toContain('Delivery, Returns &amp; Freight Notes');
  });
});
