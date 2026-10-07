import { describe, it, expect } from 'vitest';
import { adventureFacts, weldedLegsLabel } from '../../src/routes/freight.js';

describe('# of Welded Legs — A-2245 + A-2246', () => {
  it('adds the two vertical posts together', () => {
    const facts = adventureFacts([
      { lineType: 'GROUP', name: 'AS-1020 — Itemized' },
      { sku: 'A-2245', quantity: 4 },
      { sku: 'A-2246', quantity: 2 },
      { sku: 'A-2241', quantity: 6 },
    ]);
    expect(facts.legs).toBe(6);
    expect(weldedLegsLabel(facts)).toBe('6');
  });

  it('counts posts carried as kit components, per parent unit', () => {
    const facts = adventureFacts([
      {
        sku: 'FRAME-KIT',
        quantity: 2,
        components: [
          { part: 'A-2245', qty: 3 },
          { part: 'A-2246', qty: 1 },
        ],
      },
    ]);
    expect(weldedLegsLabel(facts)).toBe('8');
  });

  it('matches part numbers regardless of case and stray whitespace', () => {
    const facts = adventureFacts([
      { sku: ' a-2245 ', quantity: 3 },
      { sku: 'a-2246', quantity: 1 },
    ]);
    expect(facts.legs).toBe(4);
  });

  it('leaves out optional lines', () => {
    const facts = adventureFacts([
      { sku: 'A-2245', quantity: 4 },
      { sku: 'A-2246', quantity: 2, optional: true },
    ]);
    expect(weldedLegsLabel(facts)).toBe('4');
  });

  it('sends a real count even when the Flex Pro Pack discount is also on the proposal', () => {
    const facts = adventureFacts([
      { sku: 'A-2245', quantity: 3 },
      { sku: 'A-2246', quantity: 1 },
      { sku: 'A-2200', quantity: 1 },
      { sku: 'FLEX-PRO-DISCOUNT', quantity: -1 },
    ]);
    expect(weldedLegsLabel(facts)).toBe('4');
  });

  it('keeps the Flex labels for orders with no legs', () => {
    expect(
      weldedLegsLabel(
        adventureFacts([
          { sku: 'A-2200', quantity: 1 },
          { sku: 'FLEX-PRO-DISCOUNT', quantity: -1 },
        ]),
      ),
    ).toBe('Summit Flex: Pro Pack');
    expect(weldedLegsLabel(adventureFacts([{ sku: 'A-2200', quantity: 1 }]))).toBe('Summit Flex');
  });

  it('writes 0 when there is no frame at all', () => {
    expect(weldedLegsLabel(adventureFacts([{ sku: 'P-9999', quantity: 2 }]))).toBe('0');
  });
});
