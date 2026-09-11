import { describe, it, expect } from 'vitest';
import { financeFilename } from '../../src/handoff/financeDocument.js';

describe('financeFilename', () => {
  it('builds Customer_Name-Proposal_Number-Version#-Date', () => {
    // Local-time constructor (matches how the app builds "today" everywhere else)
    // rather than an ISO UTC string, so this doesn't shift a day depending on the
    // machine's time zone.
    const name = financeFilename(
      'Wellesley Pediatric OT',
      'P-2026-000133',
      2,
      new Date(2026, 8, 11),
    );
    expect(name).toBe('Wellesley_Pediatric_OT-P-2026-000133-v2-09112026');
  });

  it('strips filesystem-unsafe characters and collapses whitespace', () => {
    const name = financeFilename(
      'Box Butte General Hospital / OT',
      'P-2026-000086',
      1,
      new Date(2026, 0, 5),
    );
    expect(name).toBe('Box_Butte_General_Hospital_OT-P-2026-000086-v1-01052026');
  });
});
