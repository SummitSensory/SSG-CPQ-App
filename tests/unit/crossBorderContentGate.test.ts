import { describe, it, expect } from 'vitest';
import { computeContentBlockers } from '../../src/crossborder/snapshot.js';
import type { SectionCItem } from '../../src/crossborder/sectionC.js';

/**
 * requireSectionCCompleteBeforeFinal (default true) gates a Canadian proposal on
 * these `content:*` blockers before it can be released — see the filter in
 * src/routes/proposals.ts. Subtext is deliberately never checked: it's optional
 * clarifying text, not a fact the document claims to state.
 */

function base(): Parameters<typeof computeContentBlockers>[0] {
  return {
    sectionADescription: 'A therapeutic apparatus for occupational and physical therapy.',
    sectionCItems: [],
    customsBrokerName: null,
    countryOfOrigin: null,
    tariffClassificationCode: null,
    tariff9979Claimed: null,
    gstHstTreatment: null,
  };
}

function bound(boundField: SectionCItem['boundField'], label = boundField as string): SectionCItem {
  return { id: boundField as string, kind: 'BOUND', boundField, label, order: 0 };
}

describe('computeContentBlockers', () => {
  it('is empty when Section A has a description and Section C has no rows', () => {
    expect(computeContentBlockers(base())).toEqual([]);
  });

  it('blocks when Section A has no functional-description sentence', () => {
    const out = computeContentBlockers({ ...base(), sectionADescription: null });
    expect(out).toContain('content:section_a_description_missing');
  });

  it('blocks on a blank TEXT row, never on one with text', () => {
    const blank = computeContentBlockers({
      ...base(),
      sectionCItems: [{ id: '1', kind: 'TEXT', label: 'CUSMA', text: '  ', order: 0 }],
    });
    expect(blank).toContain('content:section_c_text_missing');

    const filled = computeContentBlockers({
      ...base(),
      sectionCItems: [{ id: '1', kind: 'TEXT', label: 'CUSMA', text: 'Certified.', order: 0 }],
    });
    expect(filled).toEqual([]);
  });

  it('blocks a customsBroker row only when the name is missing', () => {
    const missing = computeContentBlockers({
      ...base(),
      sectionCItems: [bound('customsBroker')],
      customsBrokerName: null,
    });
    expect(missing).toContain('content:section_c_customsBroker_missing');

    const present = computeContentBlockers({
      ...base(),
      sectionCItems: [bound('customsBroker')],
      customsBrokerName: 'BorderBuddy',
    });
    expect(present).toEqual([]);
  });

  it('blocks a countryOfOrigin row only when it is missing', () => {
    expect(
      computeContentBlockers({ ...base(), sectionCItems: [bound('countryOfOrigin')] }),
    ).toContain('content:section_c_countryOfOrigin_missing');
    expect(
      computeContentBlockers({
        ...base(),
        sectionCItems: [bound('countryOfOrigin')],
        countryOfOrigin: 'United States of America',
      }),
    ).toEqual([]);
  });

  it('blocks a tariffClassificationCode row only when it is missing', () => {
    expect(
      computeContentBlockers({ ...base(), sectionCItems: [bound('tariffClassificationCode')] }),
    ).toContain('content:section_c_tariffClassificationCode_missing');
    expect(
      computeContentBlockers({
        ...base(),
        sectionCItems: [bound('tariffClassificationCode')],
        tariffClassificationCode: '9019.10.00',
      }),
    ).toEqual([]);
  });

  it('blocks a tariff9979Claimed row only when it is null — false is a complete answer', () => {
    expect(
      computeContentBlockers({ ...base(), sectionCItems: [bound('tariff9979Claimed')] }),
    ).toContain('content:section_c_tariff9979Claimed_missing');
    expect(
      computeContentBlockers({
        ...base(),
        sectionCItems: [bound('tariff9979Claimed')],
        tariff9979Claimed: false,
      }),
    ).toEqual([]);
    expect(
      computeContentBlockers({
        ...base(),
        sectionCItems: [bound('tariff9979Claimed')],
        tariff9979Claimed: true,
      }),
    ).toEqual([]);
  });

  it('blocks a gstHstTreatment row only when it is null', () => {
    expect(
      computeContentBlockers({ ...base(), sectionCItems: [bound('gstHstTreatment')] }),
    ).toContain('content:section_c_gstHstTreatment_missing');
    expect(
      computeContentBlockers({
        ...base(),
        sectionCItems: [bound('gstHstTreatment')],
        gstHstTreatment: 'STANDARD_RATE',
      }),
    ).toEqual([]);
  });

  it('never blocks on importerOfRecord, hostSystemModel or dutiesEstimate rows', () => {
    const out = computeContentBlockers({
      ...base(),
      sectionCItems: [bound('importerOfRecord'), bound('hostSystemModel'), bound('dutiesEstimate')],
    });
    expect(out).toEqual([]);
  });

  it('reports every incomplete row at once, not just the first', () => {
    const out = computeContentBlockers({
      sectionADescription: null,
      sectionCItems: [
        bound('countryOfOrigin'),
        bound('tariff9979Claimed'),
        { id: '1', kind: 'TEXT', label: 'Note', text: '', order: 0 },
      ],
      customsBrokerName: null,
      countryOfOrigin: null,
      tariffClassificationCode: null,
      tariff9979Claimed: null,
      gstHstTreatment: null,
    });
    expect(out).toEqual([
      'content:section_a_description_missing',
      'content:section_c_countryOfOrigin_missing',
      'content:section_c_tariff9979Claimed_missing',
      'content:section_c_text_missing',
    ]);
  });
});
