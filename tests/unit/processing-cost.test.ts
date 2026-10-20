import { describe, it, expect, vi } from 'vitest';
import type { AdvAnswers, SkuRec } from '../../src/proposals/adventureSeries.js';

vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }));

const { costMultiplier, lineExtendedCostMinor } = await import('../../src/handoff/lineCost.js');
const { processingFeeOf, landedUnitCostMinor } = await import('../../src/catalog/landedCost.js');
const { lineCostMinor, versionTotals } = await import('../../src/proposals/analytics.js');
const { lineVariances, summarize } = await import('../../src/handoff/vendorInvoice.js');
const { rollUpProcurementLines, rollUpBomLines } = await import('../../src/handoff/bomRollup.js');
const { hardwareRollup } = await import('../../src/proposals/adventureSeries.js');
const { DEFAULT_HARDWARE_RULES } = await import('../../src/proposals/hardwareRules.js');

/**
 * The money side of the Processing Service Supplier (Catalog → BOM setup): a
 * Repackaging Service Fee charged per unit or once per order, on the Bill of Materials
 * (lineCost.ts and everything that totals a line through it) and on the proposal
 * (landedCost.ts, analytics.ts).
 */

describe('lineCost — a BOM line’s extended cost', () => {
  it('multiplies a per-unit line by its quantity', () => {
    expect(costMultiplier({ quantity: 4 })).toBe(4);
    expect(lineExtendedCostMinor({ unitCostMinor: 750, quantity: 4 })).toBe(3000);
    expect(lineExtendedCostMinor({ unitCostMinor: 750, quantity: 4, costPerOrder: false })).toBe(
      3000,
    );
  });

  it('charges a per-order line its unit cost ONCE, whatever the quantity', () => {
    expect(costMultiplier({ quantity: 40, costPerOrder: true })).toBe(1);
    expect(lineExtendedCostMinor({ unitCostMinor: 2500, quantity: 40, costPerOrder: true })).toBe(
      2500,
    );
  });

  it('charges nothing at quantity 0, per unit or per order', () => {
    expect(lineExtendedCostMinor({ unitCostMinor: 2500, quantity: 0, costPerOrder: true })).toBe(0);
    expect(lineExtendedCostMinor({ unitCostMinor: 2500, quantity: 0 })).toBe(0);
  });

  it('treats missing figures as zero', () => {
    expect(lineExtendedCostMinor({ unitCostMinor: null, quantity: 3 })).toBe(0);
    expect(lineExtendedCostMinor({ unitCostMinor: 100, quantity: null })).toBe(0);
    expect(lineExtendedCostMinor({})).toBe(0);
  });
});

describe('landedCost — what a part costs on a proposal', () => {
  const on = {
    processingEnabled: true,
    secondaryVendor: 'Goldberg Brothers',
    secondaryVendorCostMinor: 150,
    processingFeeBasis: 'PER_UNIT',
  };

  it('no fee when processing is off, even with a supplier and fee on file', () => {
    expect(processingFeeOf({ ...on, processingEnabled: false })).toEqual({
      perUnitMinor: 0,
      perOrderMinor: 0,
    });
    expect(landedUnitCostMinor(1000, { ...on, processingEnabled: false })).toBe(1000);
  });

  it('no fee with no processing supplier (blank counts as none)', () => {
    expect(processingFeeOf({ ...on, secondaryVendor: null })).toEqual({
      perUnitMinor: 0,
      perOrderMinor: 0,
    });
    expect(processingFeeOf({ ...on, secondaryVendor: '   ' }).perUnitMinor).toBe(0);
  });

  it('no fee for a zero, missing or negative fee', () => {
    for (const fee of [0, null, -50])
      expect(processingFeeOf({ ...on, secondaryVendorCostMinor: fee })).toEqual({
        perUnitMinor: 0,
        perOrderMinor: 0,
      });
  });

  it('no fee for a part with no catalog record at all', () => {
    expect(processingFeeOf(null)).toEqual({ perUnitMinor: 0, perOrderMinor: 0 });
    expect(landedUnitCostMinor(1000, undefined)).toBe(1000);
  });

  it('a per-unit fee is folded into the unit cost', () => {
    expect(processingFeeOf(on)).toEqual({ perUnitMinor: 150, perOrderMinor: 0 });
    expect(landedUnitCostMinor(1000, on)).toBe(1150);
  });

  it('a per-order fee travels separately and leaves the unit cost alone', () => {
    const perOrder = { ...on, processingFeeBasis: 'PER_ORDER', secondaryVendorCostMinor: 2500 };
    expect(processingFeeOf(perOrder)).toEqual({ perUnitMinor: 0, perOrderMinor: 2500 });
    expect(landedUnitCostMinor(1000, perOrder)).toBe(1000);
  });
});

describe('analytics — a proposal line’s cost of goods', () => {
  it('lineCostMinor adds a per-order processing fee once, not per unit', () => {
    expect(lineCostMinor({ quantity: 10, costEach: 1000, processingFeeMinor: 2500 })).toBe(12_500);
    expect(lineCostMinor({ quantity: 1, costEach: 1000, processingFeeMinor: 2500 })).toBe(3_500);
  });

  it('lineCostMinor does not charge the fee on a zero-quantity line', () => {
    expect(lineCostMinor({ quantity: 0, costEach: 1000, processingFeeMinor: 2500 })).toBe(0);
  });

  it('lineCostMinor without a fee is qty × cost each, as before', () => {
    expect(lineCostMinor({ quantity: 3, costEach: 333 })).toBe(999);
  });

  it('versionTotals counts the fee in cogs and margin, never in price', () => {
    const items = [
      {
        lineType: 'PRODUCT',
        quantity: 10,
        rateMinor: 2000,
        costEach: 1000,
        processingFeeMinor: 2500,
      },
      {
        lineType: 'PRODUCT',
        quantity: 0,
        rateMinor: 2000,
        costEach: 1000,
        processingFeeMinor: 9999,
      },
      { lineType: 'PRODUCT', quantity: 2, rateMinor: 500, costEach: 100 },
    ];
    const t = versionTotals(items, [{ id: 'meta', data: {} }]);
    expect(t.subtotal).toBe(21_000);
    expect(t.cogs).toBe(10_000 + 2_500 + 200);
    expect(t.margin).toBe(21_000 - 12_700);
  });
});

describe('vendorInvoice — a per-order processing line', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    sku: 'ABC',
    name: 'Product A',
    quantity: 40,
    unitCostMinor: 2500,
    invoicedUnitCostMinor: 3000,
    costPerOrder: true,
    ...over,
  });

  it('lineVariances: the extended delta is the unit delta once, not × quantity', () => {
    const [v] = lineVariances([line()]);
    expect(v).toMatchObject({ quantity: 40, unitDeltaMinor: 500, extendedDeltaMinor: 500 });
    const [u] = lineVariances([line({ costPerOrder: false })]);
    expect(u?.extendedDeltaMinor).toBe(20_000);
  });

  it('summarize: agreed and invoiced figures count the line once', () => {
    const s = summarize([
      line(),
      line({
        id: 'l2',
        quantity: 2,
        unitCostMinor: 1000,
        invoicedUnitCostMinor: 1000,
        costPerOrder: false,
      }),
    ]);
    expect(s.agreedMinor).toBe(2500 + 2000);
    expect(s.invoicedMinor).toBe(3000 + 2000);
    expect(s.varianceMinor).toBe(500);
    expect(s.checkedLines).toBe(2);
  });

  it('summarize: an unbilled per-order line is missing its fee once', () => {
    const s = summarize([line({ invoiceNotBilled: true, invoicedUnitCostMinor: null })]);
    expect(s).toMatchObject({ notBilledLines: 1, notBilledMinor: 2500, agreedMinor: 2500 });
  });
});

describe('bomRollup — a per-order line never merges', () => {
  it('rollUpProcurementLines leaves a costPerOrder line of a rolled-up part on its own', () => {
    const lines = [
      { sku: '6820H-LP', vendor: 'Goldberg Brothers', quantity: 4, unitCostMinor: 100 },
      {
        sku: '6820H-LP-ZP',
        vendor: 'Goldberg Brothers',
        quantity: 6,
        unitCostMinor: 2500,
        costPerOrder: true,
      },
    ];
    const out = rollUpProcurementLines(lines);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual(lines[1]);
    expect(out[0]).toMatchObject({ sku: '6820H-LP', quantity: 4, unitCostMinor: 100 });
  });

  it('rollUpProcurementLines still merges the per-unit lines (regression guard)', () => {
    const out = rollUpProcurementLines([
      { sku: '6820H-LP', vendor: 'Goldberg Brothers', quantity: 4, unitCostMinor: 100 },
      { sku: '6820H-LP-ZP', vendor: 'Goldberg Brothers', quantity: 6, unitCostMinor: 100 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sku: '6820H-LP', quantity: 10 });
  });

  it('rollUpBomLines leaves a costPerOrder BOM line on its own', () => {
    const bomLine = (sku: string, quantity: number, costPerOrder: boolean) => ({
      sku,
      lineNo: sku,
      vendorSku: '',
      name: sku,
      quantity,
      unitCostMinor: 2500,
      extendedCostMinor: costPerOrder ? 2500 : 2500 * quantity,
      unitWeightLbs: 0,
      extendedWeightLbs: 0,
      vendor: 'Goldberg Brothers',
      vendorNotes: '',
      isHardware: true,
      costPerOrder,
    });
    const out = rollUpBomLines([bomLine('6820H-LP', 4, false), bomLine('6820H-LP-ZP', 6, true)]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ sku: '6820H-LP-ZP', extendedCostMinor: 2500 });
  });
});

describe('bomRollup — a processing line never merges, per unit or per order', () => {
  it('rollUpProcurementLines leaves a per-unit processing line (secondaryOfSku) on its own', () => {
    const lines = [
      { sku: '6820H-LP', vendor: 'Goldberg Brothers', quantity: 4, unitCostMinor: 100 },
      {
        sku: '6820H-LP-ZP',
        vendor: 'Goldberg Brothers',
        quantity: 6,
        unitCostMinor: 15,
        secondaryOfSku: '6820H-LP-ZP',
      },
    ];
    const out = rollUpProcurementLines(lines);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual(lines[1]);
  });

  it('rollUpBomLines leaves a per-unit processing BOM line on its own', () => {
    const bomLine = (sku: string, processing: boolean) => ({
      sku,
      lineNo: sku,
      vendorSku: '',
      name: sku,
      quantity: 2,
      unitCostMinor: 15,
      extendedCostMinor: 30,
      unitWeightLbs: 0,
      extendedWeightLbs: 0,
      vendor: 'Goldberg Brothers',
      vendorNotes: '',
      isHardware: true,
      processing,
    });
    expect(rollUpBomLines([bomLine('6820H-LP', false), bomLine('6820H-LP-ZP', true)])).toHaveLength(
      2,
    );
    expect(
      rollUpBomLines([bomLine('6820H-LP', false), bomLine('6820H-LP-ZP', false)]),
    ).toHaveLength(1);
  });
});

describe('adventureSeries.hardwareRollup — per-order fees of the kit’s fasteners', () => {
  const answers: AdvAnswers = {
    length: 10,
    width: 10,
    config: 'Square',
    legs: 4,
    ladders: 1,
    brackets: true,
    bracketsQty: 4,
    swivel360: 2,
    forged: 0,
    swingHanger: 0,
    vRings: 1,
  };
  const rec = (part: string, over: Partial<SkuRec> = {}): SkuRec => ({
    part,
    description: part,
    unitPriceMinor: 100,
    unitCostMinor: 50,
    weightLbs: 0,
    category: 'ACCESSORY',
    ...over,
  });

  it('adds each fastener part’s per-order fee once, not per piece, and skips qty-0 parts', () => {
    const base = hardwareRollup(answers, {}, DEFAULT_HARDWARE_RULES);
    const used = base.components.filter((c) => c.qty > 0);
    const unused = base.components.filter((c) => c.qty === 0);
    expect(used.length).toBeGreaterThan(1);
    const [a, b] = used;
    if (!a || !b) throw new Error('expected two fasteners');
    expect(a.qty).toBeGreaterThan(1);

    const look: Record<string, SkuRec> = {
      [a.part]: rec(a.part, { processingFeeMinor: 2500 }),
      [b.part]: rec(b.part, { processingFeeMinor: 1000 }),
    };
    for (const c of unused) look[c.part] = rec(c.part, { processingFeeMinor: 99_999 });
    const roll = hardwareRollup(answers, look, DEFAULT_HARDWARE_RULES);
    expect(roll.processingFeeMinor).toBe(3500);
    // The fee is never folded into the per-piece cost.
    expect(roll.costMinor).toBe(50 * a.qty + 50 * b.qty);
  });

  it('is zero when no fastener carries a per-order fee', () => {
    expect(hardwareRollup(answers, {}, DEFAULT_HARDWARE_RULES).processingFeeMinor).toBe(0);
  });
});
