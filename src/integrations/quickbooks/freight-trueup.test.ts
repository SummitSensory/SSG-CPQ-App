import { describe, it, expect } from 'vitest';
import {
  applyFreightAmounts,
  assertFreightOnlyChange,
  freightGaps,
  thirdPartyTotal,
  ageInDays,
  urgencyFor,
  describeChanges,
} from '../../src/proposals/freightTrueUp.js';
import { versionTotals, metaOf } from '../../src/proposals/analytics.js';
import {
  buildFreightLines,
  buildFreightInvoiceBody,
  buildInvoiceFreightAmendment,
  freightTotal,
} from '../../src/integrations/quickbooks/freightInvoice.js';
import { sumLineAmounts } from '../../src/integrations/quickbooks/estimates.js';

/**
 * A proposal that went out with no freight anywhere — the case this feature is for.
 *
 * `meta` is returned alongside the sections so a test can reach the header data by
 * name. Indexing `sections[0]` would be the obvious way and it does not type: this
 * project compiles with noUncheckedIndexedAccess, which is exactly the setting that
 * stops a stray index from becoming a runtime undefined.
 */
function proposal() {
  const meta = {
    id: 'meta',
    data: {
      discountPct: 0,
      taxAmountMinor: 0,
      tbdStructureFreight: 'TBD',
      stdFreightOn: true,
      stdFreightMinor: 0,
    } as Record<string, unknown>,
  };
  return {
    meta,
    sections: [meta],
    items: [
      {
        ref: 'l1',
        lineType: 'PRODUCT',
        name: 'Swing frame',
        sku: 'F-1000',
        quantity: 1,
        rateMinor: 500000,
        costEach: 250000,
      },
      {
        ref: 'l2',
        lineType: 'PRODUCT',
        name: 'Platform swing',
        sku: 'SP-200',
        quantity: 2,
        rateMinor: 60000,
        costEach: 30000,
      },
      { ref: 'h1', lineType: 'GROUP', name: 'Hardware' },
    ],
  };
}

describe('freight gaps', () => {
  it('reports every bucket that went out blank', () => {
    const p = proposal();
    const gaps = freightGaps(p.items, p.sections);
    expect(gaps.thirdParty.map((l) => l.ref)).toEqual(['l1', 'l2']);
    expect(gaps.structureMissing).toBe(true);
    expect(gaps.standardMissing).toBe(true);
    expect(gaps.structureTbdText).toBe('TBD');
    expect(gaps.buckets).toEqual(['THIRD_PARTY', 'STRUCTURE', 'STANDARD']);
    expect(gaps.any).toBe(true);
  });

  it('only counts lines from vendors who quote freight separately', () => {
    const p = proposal();
    const gaps = freightGaps(p.items, p.sections, { freightTbdSkus: new Set(['SP-200']) });
    expect(gaps.thirdParty.map((l) => l.sku)).toEqual(['SP-200']);
  });

  it('does not flag a line that already carries freight', () => {
    const p = proposal();
    Object.assign(p.items[0] as object, { tpFreightMinor: 45000 });
    const gaps = freightGaps(p.items, p.sections);
    expect(gaps.thirdParty.map((l) => l.ref)).toEqual(['l2']);
  });

  it('leaves standard freight alone when its box is unticked', () => {
    const p = proposal();
    p.meta.data.stdFreightOn = false;
    expect(freightGaps(p.items, p.sections).standardMissing).toBe(false);
  });
});

describe('applying freight to a frozen version', () => {
  it('adds the money to the total and nothing else', () => {
    const p = proposal();
    const before = versionTotals(p.items, p.sections);
    const out = applyFreightAmounts(p.sections, p.items, {
      structureFreightMinor: 120000,
      stdFreightMinor: 35000,
      thirdPartyLines: [
        { ref: 'l1', amountMinor: 45000 },
        { ref: 'l2', amountMinor: 15000 },
      ],
    });
    expect(out.deltaMinor).toBe(120000 + 35000 + 45000 + 15000);
    expect(out.after.total).toBe(before.total + out.deltaMinor);
    expect(out.after.subtotal).toBe(before.subtotal);
    expect(out.after.discount).toBe(before.discount);
    expect(out.after.tax).toBe(before.tax);
    expect(() => assertFreightOnlyChange(out.before, out.after)).not.toThrow();
    expect(out.changes.map((c) => c.bucket)).toEqual(['THIRD_PARTY', 'STRUCTURE', 'STANDARD']);
  });

  it('does not mutate the stored version', () => {
    const p = proposal();
    applyFreightAmounts(p.sections, p.items, { structureFreightMinor: 99900 });
    expect(p.meta.data.structureFreightMinor).toBeUndefined();
    expect(versionTotals(p.items, p.sections).structureFreight).toBe(0);
  });

  it('clears the TBD wording so the customer document stops printing it', () => {
    const p = proposal();
    const out = applyFreightAmounts(p.sections, p.items, { structureFreightMinor: 120000 });
    const meta = metaOf(out.sections) as Record<string, unknown>;
    expect(meta.tbdStructureFreight).toBe('');
    expect(meta.structureFreightMinor).toBe(120000);
  });

  it('ticks the standard-freight box, or the amount would not count', () => {
    const p = proposal();
    p.meta.data.stdFreightOn = false;
    const out = applyFreightAmounts(p.sections, p.items, { stdFreightMinor: 35000 });
    expect(out.after.stdFreight).toBe(35000);
  });

  it('refuses a line that has left the proposal', () => {
    const p = proposal();
    expect(() =>
      applyFreightAmounts(p.sections, p.items, {
        thirdPartyLines: [{ ref: 'gone', amountMinor: 100 }],
      }),
    ).toThrow(/no longer on this proposal/);
  });

  it('refuses freight on a heading row', () => {
    const p = proposal();
    expect(() =>
      applyFreightAmounts(p.sections, p.items, {
        thirdPartyLines: [{ ref: 'h1', amountMinor: 100 }],
      }),
    ).toThrow(/not a product line/);
  });

  it('refuses fractional cents and negatives', () => {
    const p = proposal();
    expect(() => applyFreightAmounts(p.sections, p.items, { structureFreightMinor: 12.5 })).toThrow(
      /whole number of cents/,
    );
    expect(() => applyFreightAmounts(p.sections, p.items, { structureFreightMinor: -100 })).toThrow(
      /below zero/,
    );
  });

  it('aborts when anything other than freight moved', () => {
    const p = proposal();
    const before = versionTotals(p.items, p.sections);
    // A quantity edited underneath the amendment — the case the guard exists for.
    Object.assign(p.items[1] as object, { quantity: 3 });
    const after = versionTotals(p.items, p.sections);
    expect(() => assertFreightOnlyChange(before, after)).toThrow(/may only change freight/);
  });
});

describe('queue helpers', () => {
  it('sums staged third-party lines', () => {
    expect(thirdPartyTotal([{ amountMinor: 100 }, { amountMinor: 250 }, {}])).toBe(350);
    expect(thirdPartyTotal(null)).toBe(0);
  });

  it('ages in whole days and never negatively', () => {
    const now = new Date('2026-08-14T12:00:00Z');
    expect(ageInDays('2026-08-14T00:00:00Z', now)).toBe(0);
    expect(ageInDays('2026-08-04T00:00:00Z', now)).toBe(10);
    expect(ageInDays('2026-09-04T00:00:00Z', now)).toBe(0);
  });

  it('escalates at the threshold', () => {
    expect(urgencyFor(0, 5)).toBe('NEW');
    expect(urgencyFor(2, 5)).toBe('AGEING');
    expect(urgencyFor(5, 5)).toBe('ESCALATED');
    expect(urgencyFor(19, 5)).toBe('ESCALATED');
  });

  it('describes the movement in money, for the audit line', () => {
    const text = describeChanges(
      [{ bucket: 'STRUCTURE', label: 'Structure freight', fromMinor: 0, toMinor: 120000 }],
      120000,
    );
    expect(text).toContain('Structure freight $0.00 → $1,200.00');
    expect(text).toContain('+$1,200.00');
  });
});

describe('QuickBooks freight bodies', () => {
  const amounts = { thirdPartyMinor: 60000n, structureMinor: 120000n, standardMinor: 0n };

  it('raises one row per freight class, and none for a zero class', () => {
    const lines = buildFreightLines(amounts, 'SP-99123');
    expect(lines).toHaveLength(2);
    expect(sumLineAmounts(lines)).toBe(180000n);
    expect(String((lines[0] as { Description: string }).Description)).toContain('SP-99123');
    expect(freightTotal(amounts)).toBe(180000n);
  });

  it('appends freight to an existing invoice, keeping every original line', () => {
    const invoice = {
      Id: '145',
      SyncToken: '3',
      CustomerMemo: { value: 'Per accepted proposal P-2026-0117 v2' },
      Line: [
        {
          Id: '1',
          DetailType: 'SalesItemLineDetail',
          Amount: 5000,
          SalesItemLineDetail: { ItemRef: { value: '7' } },
        },
        { Id: '2', DetailType: 'DescriptionOnly', Description: 'Hardware' },
      ],
    };
    const body = buildInvoiceFreightAmendment({
      invoice,
      amounts,
      reference: 'SP-99123',
      expectedTotalMinor: 500000n + 180000n,
      currency: 'USD',
      memoNote: 'Freight added 2026-08-14',
    });
    expect(body.Id).toBe('145');
    expect(body.SyncToken).toBe('3');
    expect(body.sparse).toBe(true);
    const lines = body.Line as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(4);
    expect(lines[0]?.Id).toBe('1');
    expect(String(body.CustomerMemo && (body.CustomerMemo as { value: string }).value)).toContain(
      'Freight added',
    );
  });

  it('refuses to update an invoice QuickBooks returned with no lines', () => {
    expect(() =>
      buildInvoiceFreightAmendment({
        invoice: { Id: '1', SyncToken: '0', Line: [] },
        amounts,
        expectedTotalMinor: 180000n,
        currency: 'USD',
      }),
    ).toThrow(/no lines/);
  });

  it('aborts when the amended lines do not come to the expected total', () => {
    const invoice = {
      Id: '145',
      SyncToken: '3',
      Line: [
        {
          Id: '1',
          DetailType: 'SalesItemLineDetail',
          Amount: 5000,
          SalesItemLineDetail: { ItemRef: { value: '7' } },
        },
      ],
    };
    expect(() =>
      buildInvoiceFreightAmendment({
        invoice,
        amounts,
        expectedTotalMinor: 999999n,
        currency: 'USD',
      }),
    ).toThrow();
  });

  it('builds a freight-only invoice that totals exactly the freight', () => {
    const body = buildFreightInvoiceBody({
      customerQboId: '58',
      currency: 'USD',
      docNumber: 'P-2026-0117-FRT',
      amounts,
      reference: 'SP-99123',
      memo: 'Freight for accepted proposal P-2026-0117 v2, invoice 1042',
    });
    expect(body.DocNumber).toBe('P-2026-0117-FRT');
    expect(sumLineAmounts(body.Line as Array<Record<string, unknown>>)).toBe(180000n);
    expect(String((body.CustomerMemo as { value: string }).value)).toContain('$1,800.00');
  });
});
