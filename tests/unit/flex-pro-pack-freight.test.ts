import { describe, it, expect } from 'vitest';
import { adventureFacts } from '../../src/routes/freight.js';

describe('adventureFacts — Summit Flex Pro Pack detection', () => {
  it('flags flexProPack when the bundle-discount line is present', () => {
    const facts = adventureFacts([
      { lineType: 'GROUP', name: 'SUMMIT FLEX SERIES' },
      { sku: 'A-2200', quantity: 1 },
      { sku: 'FLEX-PRO-DISCOUNT', quantity: -1 },
    ]);
    expect(facts.flexProPack).toBe(true);
    expect(facts.legs).toBe(0);
    expect(facts.trolley).toBe(false);
    expect(facts.found).toBe(true);
  });

  it('does not flag an ordinary Adventure Series proposal', () => {
    const facts = adventureFacts([
      { sku: 'A-2245', quantity: 4 },
      { sku: 'A-2246', quantity: 2 },
    ]);
    expect(facts.flexProPack).toBe(false);
    expect(facts.legs).toBe(6);
  });

  it('ignores the discount line when it is optional', () => {
    const facts = adventureFacts([{ sku: 'FLEX-PRO-DISCOUNT', quantity: -1, optional: true }]);
    expect(facts.flexProPack).toBe(false);
    expect(facts.found).toBe(false);
  });
});
