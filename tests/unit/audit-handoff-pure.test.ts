import { describe, it, expect } from 'vitest';
import { procurementFromItems } from '../../src/handoff/lock.js';
import {
  rollUpBomLines,
  rollUpProcurementLines,
  rollupPart,
  isRollupHardwarePart,
} from '../../src/handoff/bomRollup.js';
import { sortForBom, headingOf, groupByHeading } from '../../src/handoff/bomLayout.js';
import { poReference } from '../../src/handoff/purchaseOrder.js';
import { vendorAbbrev } from '../../src/handoff/freightRfq.js';
import { adventureFacts, weldedLegsLabel } from '../../src/routes/freight.js';
import {
  convertUsdMinorToCad,
  convertCadMinorToUsd,
  parseRate,
  isStale,
} from '../../src/crossborder/fx.js';
import { applyPercent } from '../../src/crossborder/tax.js';
import { tierFor, percentOfMinor } from '../../src/crossborder/brokerFees.js';
import { resolveJurisdiction } from '../../src/crossborder/jurisdiction.js';

/**
 * Audit (handoff domain): pure functions on the accepted-order -> BOM -> PO -> freight
 * path. Everything here runs without a database. Tests named "BUG:" are `it.fails` —
 * they assert the CORRECT behaviour and are expected to fail until the defect is fixed.
 */

describe('audit: procurementFromItems (accepted proposal -> procurement seeds)', () => {
  it('keeps each INCLUDED product as its own seed, numbered by position among INCLUDED items', () => {
    const seeds = procurementFromItems([
      { sku: 'A', name: 'Part A', quantity: 2 },
      { sku: 'OPT', name: 'Optional', quantity: 1, kind: 'OPTIONAL' },
      { sku: 'B', name: 'Part B', quantity: 3, kind: 'INCLUDED' },
      { sku: 'ALT', name: 'Alternate', quantity: 1, kind: 'ALTERNATE' },
      { sku: 'A', name: 'Part A again (second section)', quantity: 5 },
    ]);
    expect(seeds.map((s) => [s.sku, s.quantity, s.proposalLineOrder])).toEqual([
      ['A', 2, 0],
      ['B', 3, 1],
      // Same part in a second section is NOT merged at seed time — two seeds.
      ['A', 5, 2],
    ]);
  });

  it('replaces a kit with its components, multiplying by the kit quantity', () => {
    const seeds = procurementFromItems([
      {
        sku: 'H-1000',
        name: 'Hardware Kit',
        quantity: 3,
        components: [
          { part: '6820H-LA', name: 'Hex Bolt', qty: 4, unitCostMinor: 50, weightLbs: 0.1 },
          { part: '6820H-LB', name: 'Washer', qty: 8 },
          { part: '', qty: 2 }, // no part number: dropped
          { part: 'ZERO', qty: 0 }, // no quantity: dropped
        ],
      },
    ]);
    expect(seeds).toHaveLength(2);
    expect(seeds[0]).toMatchObject({
      sku: '6820H-LA',
      quantity: 12,
      isHardwareComponent: true,
      kitSku: 'H-1000',
      unitCostMinor: 50,
      unitWeightLbs: 0.1,
      proposalLineOrder: 0,
    });
    expect(seeds[1]).toMatchObject({ sku: '6820H-LB', quantity: 24, kitSku: 'H-1000' });
    // The kit parent itself never becomes a line (its price is the sum of the parts).
    expect(seeds.some((s) => s.sku === 'H-1000')).toBe(false);
  });

  it('never lets the random line ref leak into the part number', () => {
    const [seed] = procurementFromItems([{ ref: 'r_9f8e7d', name: 'Custom item', quantity: 1 }]);
    expect(seed?.sku).toBeNull();
  });

  it.fails('BUG: a kit line at quantity 0 still orders one kit worth of components', () => {
    // A non-kit line at quantity 0 seeds quantity 0; a kit at quantity 0 seeds the
    // full per-kit count, because `(qty || 1)` treats 0 as 1 (src/handoff/lock.ts:262).
    const seeds = procurementFromItems([
      { sku: 'H-1000', quantity: 0, components: [{ part: 'BOLT', qty: 4 }] },
    ]);
    expect(seeds.reduce((a, s) => a + s.quantity, 0)).toBe(0);
  });

  it.fails('BUG: a NOTE / GROUP row whose kind defaulted to INCLUDED becomes a BOM line', () => {
    // The builder normalises legacy rows with `kind: it.kind || 'INCLUDED'` even when
    // lineType is NOTE (public/app.js:4127). procurementFromItems filters on `kind`
    // alone (src/handoff/lock.ts:232), so such a row reaches the purchasing list as an
    // "Item" with the note's title, at Unassigned vendor. versionTotals filters on
    // lineType, so the two disagree about what is a product.
    const seeds = procurementFromItems([
      { lineType: 'NOTE', kind: 'INCLUDED', name: 'Installation note', quantity: 0 },
      { lineType: 'GROUP', kind: 'INCLUDED', name: 'ADVENTURE SERIES', quantity: 0 },
      { lineType: 'PRODUCT', kind: 'INCLUDED', sku: 'A-2245', name: 'Vertical Post', quantity: 4 },
    ]);
    expect(seeds.map((s) => s.sku)).toEqual(['A-2245']);
  });
});

describe('audit: hardware roll-up (same part, two proposal names -> one purchase line)', () => {
  const bom = (over: Partial<Parameters<typeof rollUpBomLines>[0][number]>) => ({
    sku: 'X',
    lineNo: 'X',
    vendorSku: '',
    name: 'X',
    quantity: 1,
    unitCostMinor: 100,
    extendedCostMinor: 100,
    unitWeightLbs: 1,
    extendedWeightLbs: 1,
    vendor: 'Acme',
    vendorNotes: '',
    isHardware: false,
    ...over,
  });

  it('merges the variant into the base part for the same vendor and sums cost and weight', () => {
    const out = rollUpBomLines([
      bom({ sku: '6820H-LP', name: 'Eye bolt', quantity: 2, extendedCostMinor: 200 }),
      bom({ sku: 'OTHER', name: 'Other' }),
      bom({
        sku: '6820H-LP-ZP',
        name: 'Zip line eye bolt',
        quantity: 3,
        unitCostMinor: 150,
        extendedCostMinor: 450,
        extendedWeightLbs: 3,
      }),
    ]);
    expect(out).toHaveLength(2);
    const eye = out.find((l) => l.sku === '6820H-LP')!;
    expect(eye.quantity).toBe(5);
    expect(eye.extendedCostMinor).toBe(650);
    expect(eye.unitCostMinor).toBe(130);
    expect(eye.extendedWeightLbs).toBe(4);
    expect(eye.isHardware).toBe(true);
    expect(eye.name).toBe('Eye bolt');
    expect(eye.vendorNotes).toBe('Includes 6820H-LP-ZP x3');
  });

  it('keeps one part bought from two vendors as two lines (two purchase orders)', () => {
    const out = rollUpBomLines([
      bom({ sku: '6820H-LP', vendor: 'Acme', quantity: 2, extendedCostMinor: 200 }),
      bom({ sku: '6820H-LP-ZP', vendor: 'Beta', quantity: 3, extendedCostMinor: 300 }),
    ]);
    expect(out.map((l) => [l.sku, l.vendor, l.quantity])).toEqual([
      ['6820H-LP', 'Acme', 2],
      ['6820H-LP', 'Beta', 3],
    ]);
  });

  it('is idempotent on vendor notes (re-running does not stack "Includes" notes)', () => {
    const lines = [
      { sku: '6820H-LP', vendor: 'A', quantity: 1, unitCostMinor: 10, vendorNotes: 'Keep dry' },
      { sku: '6820H-LP-ZP', vendor: 'A', quantity: 2, unitCostMinor: 10, vendorNotes: null },
    ];
    const once = rollUpProcurementLines(lines);
    const twice = rollUpProcurementLines([
      ...once,
      { sku: '6820H-LP-ZP', vendor: 'A', quantity: 1, unitCostMinor: 10, vendorNotes: null },
    ]);
    expect(once[0]!.vendorNotes).toBe('Keep dry · Includes 6820H-LP-ZP x2');
    expect(String(twice[0]!.vendorNotes).match(/Includes/g)).toHaveLength(1);
  });

  it('rollupPart / isRollupHardwarePart are case- and whitespace-tolerant', () => {
    expect(rollupPart(' 6820h-lp-zp ')).toBe('6820H-LP');
    expect(rollupPart('A-2245')).toBe('A-2245');
    expect(isRollupHardwarePart('6820h-lp')).toBe(true);
  });
});

describe('audit: BOM line order presets and headings (bomLayout)', () => {
  const tables = {
    parts: new Map([
      ['PRESET-1', { bomSortOrder: 1, bomGroup: null }],
      ['PRESET-5', { bomSortOrder: 5, bomGroup: 'Crating' }],
      ['BLANK-HEADING', { bomSortOrder: null, bomGroup: '' }],
    ]),
    hardwareRuleParts: new Set(['H-1000', 'RULE-BOLT']),
  };

  it('orders: explicit position, then catalog preset, then proposal order, then arrival', () => {
    const lines = [
      { sku: 'P2', proposalLineOrder: 2 },
      { sku: 'PRESET-5', proposalLineOrder: 0 },
      { sku: 'NOPOS', proposalLineOrder: null },
      { sku: 'P0', proposalLineOrder: 0 },
      { sku: 'MANUAL', proposalLineOrder: 9, bomPosition: 0 },
      { sku: 'preset-1', proposalLineOrder: 7 },
      { sku: 'P0-dup', proposalLineOrder: 0 },
    ];
    expect(sortForBom(lines, tables).map((l) => l.sku)).toEqual([
      'MANUAL',
      'preset-1',
      'PRESET-5',
      'P0',
      'P0-dup',
      'P2',
      'NOPOS',
    ]);
    // Input untouched.
    expect(lines[0]!.sku).toBe('P2');
  });

  it('headings: order override > catalog preset > kit > hardware rule > forced roll-up part', () => {
    expect(headingOf({ sku: 'X', bomGroup: 'Mine' }, tables)).toEqual({
      heading: 'Mine',
      reason: 'order',
    });
    expect(headingOf({ sku: 'PRESET-5' }, tables).heading).toBe('Crating');
    expect(headingOf({ sku: 'K', isHardwareComponent: true }, tables).reason).toBe('kit');
    expect(headingOf({ sku: 'rule-bolt' }, tables).reason).toBe('rule');
    expect(headingOf({ sku: '6820H-LP-ZP' }, tables).reason).toBe('forced');
    expect(headingOf({ sku: 'PLAIN' }, tables)).toEqual({ heading: '', reason: 'none' });
  });

  it('groups case-insensitively with the main list first', () => {
    const groups = groupByHeading(
      [
        { h: 'Hardware', id: 1 },
        { h: '', id: 2 },
        { h: 'hardware', id: 3 },
      ],
      (l) => l.h,
    );
    expect(groups.map((g) => [g.title, g.lines.map((l) => l.id)])).toEqual([
      ['', [2]],
      ['Hardware', [1, 3]],
    ]);
  });
});

describe('audit: purchase-order numbering', () => {
  it('PO-<project>-<code>, then -2, -3 for later POs to the same vendor', () => {
    expect(poReference('12414494509', 'TFH')).toBe('PO-12414494509-TFH');
    expect(poReference('12414494509', 'TFH', 1)).toBe('PO-12414494509-TFH');
    expect(poReference('12414494509', 'TFH', 2)).toBe('PO-12414494509-TFH-2');
    expect(poReference('12414494509', '', 3)).toBe('PO-12414494509-3');
  });

  it('two different vendors can derive the SAME code (the reference is only unique per vendor sequence)', () => {
    // Fact used by the integration audit: the PO sequence is counted per (order, vendor)
    // but `reference` is globally unique, so these two vendors collide on one order.
    expect(vendorAbbrev('Southpaw Enterprises')).toBe('SE');
    expect(vendorAbbrev('Summit Electric')).toBe('SE');
    expect(vendorAbbrev('Anything', ' t-f h!')).toBe('T-FH');
  });
});

describe('audit: freight — # of Welded Legs (A-2245 + A-2246)', () => {
  it('sums standalone posts and kit-component posts multiplied by kit quantity', () => {
    const facts = adventureFacts([
      { sku: 'A-2245', quantity: 6 },
      { sku: 'FRAME', quantity: 2, components: [{ part: 'a-2246', qty: 2 }] },
      { sku: 'TR2000-A08', quantity: 1 },
    ]);
    expect(facts.legs).toBe(10);
    expect(facts.trolley).toBe(true);
    expect(weldedLegsLabel(facts)).toBe('10');
  });

  it('labels a Flex-only shipment and writes "0" for no frame', () => {
    expect(weldedLegsLabel(adventureFacts([{ sku: 'A-2200', quantity: 1 }]))).toBe('Summit Flex');
    expect(weldedLegsLabel(adventureFacts([{ sku: 'OTHER', quantity: 1 }]))).toBe('0');
    expect(weldedLegsLabel(adventureFacts(null))).toBe('0');
  });

  it.fails('BUG: a frame kit at quantity 0 still reports its component legs', () => {
    // Same `(qty || 1)` pattern as procurementFromItems (src/routes/freight.ts:161).
    const facts = adventureFacts([
      { sku: 'FRAME', quantity: 0, components: [{ part: 'A-2245', qty: 4 }] },
    ]);
    expect(facts.legs).toBe(0);
  });
});

describe('audit: cross-border money math (CAD/USD, tax, broker tiers)', () => {
  it('converts USD->CAD half-up in integer minor units, symmetric for negatives', () => {
    expect(convertUsdMinorToCad(10000n, '1.3655')).toBe(13655n);
    expect(convertUsdMinorToCad(1n, '1.3650')).toBe(1n); // 1.365 -> 1
    expect(convertUsdMinorToCad(1n, '1.5')).toBe(2n); // 1.5 -> 2 (half-up)
    expect(convertUsdMinorToCad(-1n, '1.5')).toBe(-2n); // away from zero
    expect(parseRate('1.3655')).toEqual({ digits: 13655n, scale: 4 });
    expect(() => parseRate('1,36')).toThrow();
  });

  it('CAD->USD is the inverse to within one cent', () => {
    for (const usd of [1n, 99n, 12345n, 9_999_999n]) {
      const cad = convertUsdMinorToCad(usd, '1.3721');
      const back = convertCadMinorToUsd(cad, '1.3721');
      expect(back - usd <= 1n && usd - back <= 1n).toBe(true);
    }
  });

  it('applyPercent rounds half-up away from zero', () => {
    expect(applyPercent(1000n, '13')).toBe(130n);
    expect(applyPercent(1n, '50')).toBe(1n); // 0.5 -> 1
    expect(applyPercent(-1n, '50')).toBe(-1n);
    expect(applyPercent(333n, '14.975')).toBe(50n); // 49.867
    expect(() => applyPercent(1n, '-5')).toThrow();
  });

  it('broker-fee tiers use inclusive ceilings and an open last tier', () => {
    const tiers = [
      { upToMinor: 100_000, amountMinor: 5000 },
      { upToMinor: 500_000, amountMinor: 9000 },
      { upToMinor: null, amountMinor: 15000 },
    ] as unknown as Parameters<typeof tierFor>[0];
    expect(tierFor(tiers, 100_000)).toBe(tiers[0]);
    expect(tierFor(tiers, 100_001)).toBe(tiers[1]);
    expect(tierFor(tiers, 10_000_000)).toBe(tiers[2]);
    expect(percentOfMinor(10_000, '2.5')).toBe(250);
    expect(percentOfMinor(10_000, '2.5000')).toBe(250);
    expect(percentOfMinor(10_000, 'abc')).toBeNull();
  });

  it('isStale counts whole days between observation and as-of', () => {
    const obs = {
      pair: 'USD/CAD',
      rate: '1.37',
      observationDate: '2026-10-01',
      source: 'MANUAL' as const,
      retrievedAt: new Date(),
    };
    expect(isStale(obs, '2026-10-04', 3)).toBe(false);
    expect(isStale(obs, '2026-10-05', 3)).toBe(true);
  });

  it('jurisdiction: only Canada turns on the pipeline; province/postal mismatch is flagged', () => {
    expect(
      resolveJurisdiction({ line1: '1 Main', country: 'USA', region: 'CO', postalCode: '80111' })
        .regime,
    ).toBe('DOMESTIC');
    const on = resolveJurisdiction({
      line1: '1 Main',
      country: 'Canada',
      region: 'ON',
      postalCode: 'M5V 2T6',
    });
    expect(on).toMatchObject({ regime: 'CANADA', province: 'ON', complete: true });
    const bad = resolveJurisdiction({
      line1: '1 Main',
      country: 'CA',
      region: 'BC',
      postalCode: 'M5V 2T6',
    });
    expect(bad.regime).toBe('CANADA_INCOMPLETE');
    expect(bad.issues).toContain('province_postal_mismatch');
    expect(resolveJurisdiction(null).issues).toEqual(['no_billing_address']);
  });
});
