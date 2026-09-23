import { describe, it, expect } from 'vitest';
import {
  stateFromLabel,
  contentHashOf,
  displayOf,
  parseAnswers,
} from '../../src/portal/orderPortal.js';
import { colorAreasOf } from '../../src/portal/colorAreas.js';
import { withSuiteFromFormatted } from '../../src/integrations/monday/portalDelivery.js';

/**
 * The pure rules behind the Orders page's portal columns. Label and address shapes
 * are the ones the live Manufacturing Process and Delivery Submissions boards return
 * (September 2026).
 */

describe('stateFromLabel — monday ✅ / 🚫 / N/A', () => {
  it('reads the three labels, and blank as not provided', () => {
    expect(stateFromLabel('✅')).toBe('PROVIDED');
    expect(stateFromLabel('🚫')).toBe('NOT_PROVIDED');
    expect(stateFromLabel('N/A')).toBe('NA');
    expect(stateFromLabel(' n/a ')).toBe('NA');
    expect(stateFromLabel('')).toBe('NOT_PROVIDED');
    expect(stateFromLabel(null)).toBe('NOT_PROVIDED');
  });
});

describe('reviewed is a hash comparison', () => {
  it('ignores key order, so an unchanged answer never un-reviews itself', () => {
    const a = contentHashOf('PROVIDED', { b: 1, a: { y: 2, x: [1, { q: 1, p: 2 }] } });
    const b = contentHashOf('PROVIDED', { a: { x: [1, { p: 2, q: 1 }], y: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('moves when an answer or the state changes', () => {
    const base = contentHashOf('PROVIDED', { city: 'Mesa' });
    expect(contentHashOf('PROVIDED', { city: 'Tempe' })).not.toBe(base);
    expect(contentHashOf('NA', { city: 'Mesa' })).not.toBe(base);
  });

  it('shows NEW until the current version is reviewed, then REVIEWED, then NEW again on a change', () => {
    const h1 = contentHashOf('PROVIDED', { v: 1 });
    const h2 = contentHashOf('PROVIDED', { v: 2 });
    expect(displayOf({ state: 'PROVIDED', contentHash: h1, reviewedHash: null })).toBe('NEW');
    expect(displayOf({ state: 'PROVIDED', contentHash: h1, reviewedHash: h1 })).toBe('REVIEWED');
    expect(displayOf({ state: 'PROVIDED', contentHash: h2, reviewedHash: h1 })).toBe('NEW');
  });

  it('shows N/A and "-" regardless of review', () => {
    expect(displayOf({ state: 'NA', contentHash: 'x', reviewedHash: 'x' })).toBe('NA');
    expect(displayOf({ state: 'NOT_PROVIDED', contentHash: null, reviewedHash: null })).toBe(
      'NONE',
    );
  });
});

describe('parseAnswers', () => {
  it('parses the JSON columns and keeps unreadable text rather than dropping it', () => {
    expect(parseAnswers('{"billingCity":"Ripon"}')).toEqual({ billingCity: 'Ripon' });
    expect(parseAnswers('not json')).toEqual({ text: 'not json' });
    expect(parseAnswers('')).toBeNull();
  });
});

describe('colorAreasOf', () => {
  it('flattens the portal colour answers to one pick per area', () => {
    const picks = colorAreasOf({
      selections: {
        structure_frame_paint: {
          legs: { brand: 'cardinal', code: 'T009-BL01' },
          horizontal_beams: { brand: 'cardinal', code: 'T009-BL01' },
        },
        slide: {
          slide_color: { brand: 'plastic', code: 'Green' },
          empty: { brand: 'x', code: '' },
        },
      },
      confirmedAt: null,
    });
    expect(picks.map((p) => p.areaKey)).toEqual([
      'slide.slide_color',
      'structure_frame_paint.horizontal_beams',
      'structure_frame_paint.legs',
    ]);
    expect(picks[2]).toMatchObject({ brand: 'cardinal', code: 'T009-BL01' });
  });

  it('tolerates a missing or odd shape', () => {
    expect(colorAreasOf(null)).toEqual([]);
    expect(colorAreasOf({ selections: 'x' })).toEqual([]);
  });
});

describe('withSuiteFromFormatted — the suite only the formatted line carries', () => {
  const f = (line1: string, formattedAddress: string, line2: string | null = null) =>
    withSuiteFromFormatted({ line1, line2, formattedAddress });

  it('fills a blank Line 2 when the formatted street is the same street', () => {
    expect(
      f('7205 E. Southern Ave.', '7205 E. Southern Ave., Suite 115, Mesa, AZ 85209, United States')
        .line2,
    ).toBe('Suite 115');
    expect(
      f('289 N Route 303', '289 N Route 303, Unit 1209, Congers, New York 10920, United States')
        .line2,
    ).toBe('Unit 1209');
  });

  it('leaves a street that already carries the suite alone, rather than doubling it', () => {
    expect(
      f(
        '6198 Butler Pike, Ste 212',
        '6198 Butler Pike, Ste 212, Ste 212, Blue Bell , PA 19422, United States',
      ).line2,
    ).toBeNull();
    expect(
      f(
        '7086 N. Maple Avenue Suite 105',
        '7086 N. Maple Avenue Suite 105, Fresno, CA 93720, United States',
      ).line2,
    ).toBeNull();
  });

  it('never overwrites a Line 2 the portal did write', () => {
    expect(
      f('1 Main St', '1 Main St, Suite 9, Town, CO 80000, United States', 'Bldg B').line2,
    ).toBe('Bldg B');
  });
});

describe('primaryShippingAddress — a portal delivery site never displaces the CRM address', () => {
  it('prefers an address typed or imported into the CRM', async () => {
    const { primaryShippingAddress } = await import('../../src/crm/addresses.js');
    const portal = { id: 'p', type: 'SHIPPING', source: 'PORTAL' };
    const own = { id: 'o', type: 'SHIPPING', source: null };
    const bill = { id: 'b', type: 'BILLING', source: null };
    expect(primaryShippingAddress([portal, own, bill])?.id).toBe('o');
    expect(primaryShippingAddress([portal, bill])?.id).toBe('p');
    // QuickBooks' bill-to fallback: never the portal site.
    expect(primaryShippingAddress([portal, bill], { allowPortal: false })).toBeNull();
  });
});
