import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  CROSS_BORDER_TERM_CONDITIONS,
  normalizeCrossBorderTerms,
} from '../../src/crossborder/crossBorderTerms';

/**
 * The Cross-Border Terms are an admin-edited list (CrossBorderSetting.crossBorderTerms,
 * seeded by migration 0103), not wording in public/proposal-document.js. These tests
 * lock the three things that make an editable list safe on a signed document:
 *
 *   - a clause prints only where its condition holds (exactly one 9979 variant, one
 *     GST/HST variant);
 *   - {{token}} fields print the proposal's own values, escaped, and an unanswered one
 *     says so rather than printing blank;
 *   - the clauses sit on the Canadian terms page with Section C, BEFORE the
 *     Acceptance page, not trailing after the signature.
 */

interface Doc {
  lines: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  meta: Record<string, unknown>;
  crossBorder: Record<string, unknown> | null;
}

const repo = join(__dirname, '..', '..');
const src = readFileSync(join(repo, 'public', 'proposal-document.js'), 'utf8');

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
    rt: (s: string) => s,
    freightTbdNote: 'Freight TBD.',
    documentUser: () => ({ name: 'Bryan Shepherd' }),
    fmtDate: (v: string) => String(v),
    todayISO: () => '2026-09-26',
  });
});

afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

/** The seed exactly as migration 0103 writes it. */
function seededTerms(): Array<Record<string, unknown>> {
  const sql = readFileSync(
    join(repo, 'prisma', 'migrations', '0103_cross_border_terms', 'migration.sql'),
    'utf8',
  );
  const m = /\$terms\$([\s\S]*)\$terms\$/.exec(sql);
  if (!m?.[1]) throw new Error('seed not found in migration 0103');
  return JSON.parse(m[1]) as Array<Record<string, unknown>>;
}

function doc(cb: Record<string, unknown>): Doc {
  return {
    meta: {},
    lines: [{ lineType: 'GROUP', name: 'Summit Soar Series' }],
    totals: { subtotal: 100000, total: 100000, deposit: 50000 },
    crossBorder: {
      applicable: true,
      fx: { rate: '1.4145', observationDate: '2026-09-25' },
      crossBorderTerms: seededTerms(),
      ...cb,
    },
  };
}

/** The Cross-Border Terms block alone. */
function termsBlock(html: string): string {
  const i = html.indexOf('>Cross-Border Terms</div>');
  expect(i, 'no Cross-Border Terms heading').toBeGreaterThan(-1);
  return html.slice(i);
}

describe('migration 0103 seed', () => {
  it('seeds every clause with a valid condition and survives normalization intact', () => {
    const seeded = seededTerms();
    expect(seeded.length).toBe(22);
    for (const t of seeded) {
      expect(CROSS_BORDER_TERM_CONDITIONS).toContain(t.condition);
      expect(String(t.text).trim().length).toBeGreaterThan(10);
    }
    expect(normalizeCrossBorderTerms(seeded)).toHaveLength(22);
  });
});

describe('normalizeCrossBorderTerms', () => {
  it('drops a clause with no text, degrades an unknown condition to ALWAYS, sorts by order', () => {
    const out = normalizeCrossBorderTerms([
      { id: 'b', title: 'Second', text: 'Two.', order: 2, condition: 'NOPE' },
      { id: 'x', title: 'Empty', text: '   ', order: 0 },
      { id: 'a', title: 'First', text: 'One.', order: 1, condition: 'IOR_SUMMIT' },
      'garbage',
    ]);
    expect(out.map((t) => [t.id, t.condition])).toEqual([
      ['a', 'IOR_SUMMIT'],
      ['b', 'ALWAYS'],
    ]);
  });

  it('returns an empty list for a null/malformed column', () => {
    expect(normalizeCrossBorderTerms(null)).toEqual([]);
    expect(normalizeCrossBorderTerms({})).toEqual([]);
  });
});

describe('Cross-Border Terms — conditions', () => {
  it('prints exactly one 9979.00.00 variant and one GST/HST variant for each answer', () => {
    const cases: Array<[unknown, string]> = [
      [true, 'has identified the goods on this proposal as eligible'],
      [false, 'are not being entered under tariff item 9979.00.00'],
      [null, 'has not yet been determined. This proposal does not assume relief'],
    ];
    for (const [claimed, phrase] of cases) {
      const block = termsBlock(SSGProposalDocument.html(doc({ tariff9979Claimed: claimed })));
      expect(
        block.split('Tariff Item 9979.00.00 (Goods for Persons with Disabilities).').length - 1,
      ).toBe(1);
      expect(block).toContain(phrase);
      expect(block.includes('Diversion of Goods Entered Under Tariff Item 9979.00.00.')).toBe(
        claimed === true,
      );
    }
    const std = termsBlock(SSGProposalDocument.html(doc({ gstHstTreatment: 'STANDARD_RATE' })));
    expect(std.split('<b>GST/HST Treatment.</b>').length - 1).toBe(1);
    expect(std).toContain('<b>GST/HST Treatment.</b> Standard rate applies.');
  });

  it('honours the importer-of-record and host-system conditions', () => {
    const terms = [
      {
        id: '1',
        title: 'Summit Imports',
        text: 'Summit clears.',
        order: 0,
        condition: 'IOR_SUMMIT',
      },
      {
        id: '2',
        title: 'Customer Imports',
        text: 'You clear.',
        order: 1,
        condition: 'IOR_NOT_SUMMIT',
      },
      {
        id: '3',
        title: 'Existing System',
        text: 'For {{hostSystem}}.',
        order: 2,
        condition: 'HOST_SYSTEM_PRESENT',
      },
    ];
    const summit = termsBlock(
      SSGProposalDocument.html(doc({ crossBorderTerms: terms, importerOfRecord: 'SUMMIT' })),
    );
    expect(summit).toContain('Summit clears.');
    expect(summit).not.toContain('You clear.');
    expect(summit).not.toContain('Existing System');
    const cust = termsBlock(
      SSGProposalDocument.html(
        doc({ crossBorderTerms: terms, importerOfRecord: 'CUSTOMER', hostSystemModel: 'Soar S2' }),
      ),
    );
    expect(cust).toContain('You clear.');
    expect(cust).toContain('For Soar S2.');
  });
});

describe('Cross-Border Terms — fill-in fields', () => {
  it('prints the proposal’s own values, escaped, and flags an unanswered one', () => {
    const html = SSGProposalDocument.html(
      doc({
        crossBorderTerms: [
          {
            id: '1',
            title: 'Classification',
            text: 'Declared under {{tariffClassification}} by {{importerOfRecord}}; origin {{countryOfOrigin}}; broker {{customsBroker}}; {{unknownField}}.',
            order: 0,
            condition: 'ALWAYS',
          },
        ],
        tariffClassificationCode: '9019.10.00 <b>',
        importerOfRecord: 'SUMMIT',
        customsBrokerName: 'BorderBuddy',
        customsBrokerAddress: 'Vancouver, BC',
      }),
    );
    const block = termsBlock(html);
    expect(block).toContain('Declared under 9019.10.00 &lt;b&gt; by Summit Sensory Gym');
    expect(block).toContain('origin <span style="color:#8a8f85;">[not yet determined]</span>');
    expect(block).toContain('broker BorderBuddy, Vancouver, BC');
    // A misspelt field is left visible, not silently dropped.
    expect(block).toContain('{{unknownField}}');
  });

  it('fills the seeded currency clause with the proposal’s rate and date', () => {
    const block = termsBlock(SSGProposalDocument.html(doc({})));
    expect(block).toContain('published for 2026-09-25, at a rate of 1 USD = 1.4145 CAD.');
    expect(block).not.toContain('{{fx');
  });

  it('fills the same fields in a Section C custom-text row', () => {
    const html = SSGProposalDocument.html(
      doc({
        sectionCItems: [
          {
            id: 's',
            kind: 'TEXT',
            label: 'Classification',
            text: 'Under {{tariffClassification}}.',
            order: 0,
          },
        ],
        tariffClassificationCode: '9019.10.00',
      }),
    );
    expect(html).toContain('white-space:pre-line;">Under 9019.10.00.');
  });

  it('escapes admin-entered clause text', () => {
    const block = termsBlock(
      SSGProposalDocument.html(
        doc({
          crossBorderTerms: [
            {
              id: '1',
              title: '<i>T</i>',
              text: '<script>x</script>',
              order: 0,
              condition: 'ALWAYS',
            },
          ],
        }),
      ),
    );
    expect(block).toContain('&lt;script&gt;');
    expect(block).not.toContain('<script>');
  });
});

describe('Cross-Border Terms — placement', () => {
  it('prints Section C and the terms on the Canadian terms page, before the Acceptance page', () => {
    const html = SSGProposalDocument.html(
      doc({
        sectionCItems: [{ id: 's', kind: 'TEXT', label: 'Row', text: 'Row text.', order: 0 }],
      }),
    );
    const page = html.indexOf('data-page-break="canadian-terms"');
    const secC = html.indexOf('Section C — Canadian Import Terms');
    const terms = html.indexOf('>Cross-Border Terms</div>');
    const acceptance = html.indexOf('data-page-break="acceptance"');
    expect(page).toBeGreaterThan(-1);
    expect(secC).toBeGreaterThan(page);
    expect(terms).toBeGreaterThan(secC);
    expect(acceptance).toBeGreaterThan(terms);
  });

  it('prints no terms page when there is neither a Section C row nor a clause', () => {
    const html = SSGProposalDocument.html(doc({ crossBorderTerms: [], sectionCItems: [] }));
    expect(html).not.toContain('data-page-break="canadian-terms"');
    expect(html).not.toContain('Cross-Border Terms');
  });

  it('never prints the terms on a domestic proposal', () => {
    const d = doc({});
    d.crossBorder = null;
    const html = SSGProposalDocument.html(d);
    expect(html).not.toContain('Cross-Border Terms');
    expect(html).not.toContain('canadian-terms');
  });
});
