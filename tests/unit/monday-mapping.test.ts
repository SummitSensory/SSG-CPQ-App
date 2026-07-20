import { describe, it, expect } from 'vitest';
import { toColumnValues, STAGE_TO_STATUS, STATUS_TO_STAGE, COLUMN } from '../../src/integrations/monday/mapping.js';
import { syncHash } from '../../src/integrations/monday/sync.js';

describe('monday mapping', () => {
  it('round-trips stage <-> status label', () => {
    for (const stage of Object.keys(STAGE_TO_STATUS) as Array<keyof typeof STAGE_TO_STATUS>) {
      expect(STATUS_TO_STAGE[STAGE_TO_STATUS[stage]]).toBe(stage);
    }
  });
  it('formats budget from integer minor units without float math', () => {
    const cols = toColumnValues({ name: 'X', stage: 'PROPOSAL', fundingStatus: 'BUDGETED', budgetAmountMinor: 5000000n, budgetCurrency: 'USD' });
    expect(cols[COLUMN.budget]).toBe('50000.00');
  });
});

describe('two-way sync loop guard', () => {
  const base = { name: 'X', stage: 'PROSPECT' as const, fundingStatus: 'UNFUNDED', budgetAmountMinor: null, budgetCurrency: null };
  it('same state produces same hash (suppresses echo)', () => {
    expect(syncHash(base)).toBe(syncHash({ ...base }));
  });
  it('changed state produces a different hash', () => {
    expect(syncHash(base)).not.toBe(syncHash({ ...base, stage: 'PROPOSAL' }));
  });
});
