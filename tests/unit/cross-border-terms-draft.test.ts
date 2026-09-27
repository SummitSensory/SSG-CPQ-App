import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  CROSS_BORDER_TERM_CONDITIONS,
  normalizeCrossBorderTerms,
} from '../../src/crossborder/crossBorderTerms';

/**
 * Migration 0104 seeds a reconciled DRAFT of the Cross-Border Terms
 * (CrossBorderSetting.crossBorderTermsDraft) for Summit and its counsel to review.
 * Nothing prints it until it is published. These tests lock what the draft is for:
 * one statement of the tariff classification (never a hard-typed number), exactly
 * one importer-of-record clause per proposal, and no duplicate GST/HST clause — and
 * that the import-charges block tells the truth about who is paid when Summit
 * imports.
 */

interface Doc {
  lines: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  meta: Record<string, unknown>;
  crossBorder: Record<string, unknown> | null;
}

const repo = join(__dirname, '..', '..');
let D: { useRules: (r: unknown) => void; html: (doc: Doc) => string };

beforeAll(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {};
  vm.runInThisContext(readFileSync(join(repo, 'public', 'proposal-document.js'), 'utf8'));
  D = (globalThis as unknown as { window: { SSGProposalDocument: typeof D } }).window
    .SSGProposalDocument;
  D.useRules({
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

function draft(): Array<Record<string, unknown>> {
  const sql = readFileSync(
    join(repo, 'prisma', 'migrations', '0104_cross_border_terms_draft', 'migration.sql'),
    'utf8',
  );
  const body = sql.split('$draft$')[1];
  if (!body) throw new Error('draft seed not found in migration 0104');
  return JSON.parse(body) as Array<Record<string, unknown>>;
}

function doc(cb: Record<string, unknown>): Doc {
  return {
    meta: {},
    lines: [{ lineType: 'GROUP', name: 'Summit Soar Series' }],
    totals: { subtotal: 696076, total: 886037, deposit: 0 },
    crossBorder: {
      applicable: true,
      fx: { rate: '1.4145', observationDate: '2026-09-25' },
      crossBorderTerms: draft(),
      tariffClassificationCode: '9019.10.00',
      tariff9979Claimed: true,
      gstHstTreatment: 'STANDARD_RATE',
      ...cb,
    },
  };
}

const terms = (html: string): string => html.slice(html.indexOf('>Cross-Border Terms</div>'));

describe('migration 0104 draft seed', () => {
  it('is well-formed and survives normalization intact', () => {
    const d = draft();
    expect(d.length).toBe(19);
    for (const t of d) expect(CROSS_BORDER_TERM_CONDITIONS).toContain(t.condition);
    expect(normalizeCrossBorderTerms(d)).toHaveLength(19);
  });

  it('never hard-types a tariff number for the classification — it is a fill-in field', () => {
    const cls = draft().find((t) => t.id === 'draft-classification');
    expect(String(cls?.text)).toContain('{{tariffClassification}}');
    expect(String(cls?.text)).not.toContain('9019.10.00');
  });

  it('drops the standard-rate GST/HST clause that repeats the Section C fact', () => {
    expect(draft().some((t) => t.condition === 'GST_STANDARD')).toBe(false);
  });
});

describe('the draft, printed', () => {
  it('prints the classification from the proposal and 9979.00.00 as an additional claim', () => {
    const t = terms(D.html(doc({})));
    expect(t).toContain('classified under tariff item 9019.10.00 of the Customs Tariff');
    expect(t).toContain(
      'In addition to the classification above, the goods are claimed under tariff item 9979.00.00',
    );
    expect(t).not.toContain('GST/HST Treatment.');
  });

  it('prints exactly one importer-of-record model', () => {
    const summit = terms(D.html(doc({ importerOfRecord: 'SUMMIT' })));
    expect(summit).toContain('<b>Importer of Record and Import Charges.</b>');
    expect(summit).toContain('<b>Reassessment of Canadian Import Charges.</b>');
    expect(summit).not.toContain('Importer of Record and Border Charges');

    const cust = terms(D.html(doc({ importerOfRecord: 'CUSTOMER' })));
    expect(cust).toContain('<b>Importer of Record and Border Charges.</b>');
    expect(cust).toContain('(importer of record: The customer)');
    expect(cust).not.toContain('Reassessment of Canadian Import Charges');
    expect(cust).not.toContain('Importer of Record and Import Charges');
  });

  it('prints host-system identification only for replacement/expansion parts', () => {
    expect(terms(D.html(doc({})))).not.toContain('Host System Identification');
    expect(terms(D.html(doc({ hostSystemModel: 'Soar S2' })))).toContain(
      'existing Summit Sensory Gym system, Soar S2, and are identified',
    );
  });
});

describe('import-charges block wording follows the importer of record', () => {
  const border = {
    result: {
      lines: [
        {
          category: 'BROKERAGE',
          label: 'Customs Brokerage',
          usdMinor: 40000,
          status: 'ESTIMATED',
          includedInSellerTotal: false,
        },
      ],
      separatelyPayable: { usdMinor: 40000 },
    },
  };

  it('says Summit pays and bills at actual when Summit imports', () => {
    const html = D.html(doc({ ...border, importerOfRecord: 'SUMMIT' }));
    expect(html).toContain('Estimated import charges, billed at actual');
    expect(html).toContain('As importer of record, Summit Sensory Gym pays these at importation');
    expect(html).not.toContain('Not payable to Summit Sensory Gym');
  });

  it('says not payable to Summit otherwise', () => {
    const html = D.html(doc({ ...border, importerOfRecord: 'THIRD_PARTY' }));
    expect(html).toContain('Estimated charges payable at import');
    expect(html).toContain('Not payable to Summit Sensory Gym');
  });
});
