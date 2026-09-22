import { describe, it, expect } from 'vitest';
import {
  resolveSkuFreight,
  rfqStem,
  type SubitemFreightRow,
} from '../../src/integrations/monday/subitemFreight.js';

/**
 * The per-SKU answer read off the freight-request subitems. Row shapes are the ones
 * the Deal Tracking subitems board actually returns (September 2026).
 */
function row(p: Partial<SubitemFreightRow>): SubitemFreightRow {
  return {
    subitemId: '1',
    name: 'item',
    createdAt: '2026-09-01T00:00:00Z',
    sku: 'A-1',
    rfqRef: 'RFQ-100-SE',
    vendor: 'Southpaw Enterprises',
    quoteRef: '',
    vendorCostMinor: null,
    afterMarkupMinor: null,
    included: 'Included in Proposal',
    ...p,
  };
}

describe('rfqStem', () => {
  it('drops revision and resubmission suffixes', () => {
    expect(rfqStem('RFQ-12858711772-TFH R2')).toBe('RFQ-12858711772-TFH');
    expect(rfqStem('rfq-1-se r2 s3')).toBe('RFQ-1-SE');
    expect(rfqStem('RFQ-1-SE')).toBe('RFQ-1-SE');
  });
});

describe('resolveSkuFreight', () => {
  it('takes Freight After Markup for an answered line — never re-applies the markup', () => {
    const [q] = resolveSkuFreight([
      row({ sku: '150045', vendorCostMinor: 67_215, afterMarkupMinor: 77_297 }),
    ]);
    expect(q).toMatchObject({ sku: '150045', state: 'QUOTED', amountMinor: 77_297 });
  });

  it('treats a blank cost as pending, even though the formula reads 0', () => {
    const [q] = resolveSkuFreight([row({ vendorCostMinor: null, afterMarkupMinor: 0 })]);
    expect(q).toMatchObject({ state: 'PENDING', amountMinor: null });
  });

  it('treats a $0 cost as an answer with no freight to charge', () => {
    const [q] = resolveSkuFreight([row({ sku: 'BR158', vendorCostMinor: 0, afterMarkupMinor: 0 })]);
    expect(q).toMatchObject({ sku: 'BR158', state: 'ZERO', amountMinor: null });
  });

  it('skips an item marked No Longer Interested', () => {
    const [q] = resolveSkuFreight([
      row({ vendorCostMinor: 52_200, afterMarkupMinor: 0, included: 'No Longer Interested' }),
    ]);
    expect(q?.state).toBe('DROPPED');
  });

  it('lets the newest answered request win over an older one, and over a newer unanswered one', () => {
    const out = resolveSkuFreight([
      row({
        subitemId: '10',
        createdAt: '2026-09-01T00:00:00Z',
        vendorCostMinor: 100,
        afterMarkupMinor: 115,
      }),
      row({
        subitemId: '11',
        createdAt: '2026-09-05T00:00:00Z',
        rfqRef: 'RFQ-100-SE R2',
        vendorCostMinor: 200,
        afterMarkupMinor: 230,
      }),
      row({ subitemId: '12', createdAt: '2026-09-09T00:00:00Z', rfqRef: 'RFQ-100-SE S2' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ state: 'QUOTED', amountMinor: 230, subitemId: '11' });
  });

  it('keeps only this proposal’s requests when stems are given', () => {
    const out = resolveSkuFreight(
      [
        row({ sku: 'A-1', rfqRef: 'RFQ-100-SE', vendorCostMinor: 100, afterMarkupMinor: 115 }),
        row({ sku: 'B-2', rfqRef: 'RFQ-999-SE', vendorCostMinor: 100, afterMarkupMinor: 115 }),
      ],
      new Set(['RFQ-100-SE']),
    );
    expect(out.map((q) => q.sku)).toEqual(['A-1']);
  });

  it('matches SKUs case-insensitively and ignores rows with no SKU', () => {
    const out = resolveSkuFreight([
      row({ sku: ' grpmat158 ', vendorCostMinor: 126_369, afterMarkupMinor: 145_324 }),
      row({ sku: '' }),
    ]);
    expect(out).toEqual([expect.objectContaining({ sku: 'GRPMAT158', amountMinor: 145_324 })]);
  });
});
