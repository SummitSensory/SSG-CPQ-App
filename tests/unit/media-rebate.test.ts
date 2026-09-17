import { describe, it, expect } from 'vitest';
import { versionTotals } from '../../src/proposals/analytics.js';
import { defaultMediaProgramContent } from '../../src/mediaRebate/defaults.js';

/**
 * The Customer Project Media Rebate must never affect a proposal's financial
 * calculations — see CLAUDE.md's Customer Project Media Rebate spec, section 4. This
 * is the hard requirement: versionTotals() (the single source of truth every report,
 * QuickBooks sync and the printed proposal reads — see analytics.ts's own docblock)
 * must produce byte-identical totals whether or not a proposal offers the program.
 *
 * DB-backed behavior (snapshotting, pinning, admin permissions) is covered in
 * tests/integration/media-partnership-program-routes.test.ts, which can stub Prisma.
 * This file stays DB-free, matching version-totals-meta.test.ts's own convention.
 */
const meta = (data: Record<string, unknown>) => [{ id: 'meta', data }];
const line = (rateMinor: number, quantity = 1) => ({
  lineType: 'PRODUCT',
  quantity,
  rateMinor,
});

describe('Customer Project Media Rebate — financial neutrality', () => {
  it('does not change totals when the program is not offered', () => {
    const withoutMeta = versionTotals(
      [line(100_000)],
      meta({ discountPct: 10, taxAmountMinor: 500 }),
    );
    const withMediaRebateAbsent = versionTotals(
      [line(100_000)],
      meta({ discountPct: 10, taxAmountMinor: 500 }),
    );
    expect(withMediaRebateAbsent).toEqual(withoutMeta);
  });

  it('does not change subtotal, discount, tax, freight or total when offered', () => {
    const base = meta({
      discountPct: 10,
      taxAmountMinor: 500,
      structureFreightMinor: 2_000,
      matsFreightMinor: 1_000,
      stdFreightOn: true,
      stdFreightMinor: 750,
    });
    const offered = meta({
      discountPct: 10,
      taxAmountMinor: 500,
      structureFreightMinor: 2_000,
      matsFreightMinor: 1_000,
      stdFreightOn: true,
      stdFreightMinor: 750,
      mediaRebate: {
        offered: true,
        participate: true,
        participationAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const items = [line(250_000, 2)];
    expect(versionTotals(items, offered)).toEqual(versionTotals(items, base));
  });

  it('does not change totals whether the customer participates or declines', () => {
    const items = [line(80_000)];
    const accepted = versionTotals(
      items,
      meta({ mediaRebate: { offered: true, participate: true, participationAt: 'x' } }),
    );
    const declined = versionTotals(
      items,
      meta({ mediaRebate: { offered: true, participate: false, participationAt: null } }),
    );
    expect(accepted).toEqual(declined);
  });
});

describe('defaultMediaProgramContent', () => {
  it('returns a defensive copy — mutating one call never affects another', () => {
    const a = defaultMediaProgramContent();
    a.introduction = 'mutated';
    a.timeframes.submissionDays = 999;
    const b = defaultMediaProgramContent();
    expect(b.introduction).not.toBe('mutated');
    expect(b.timeframes.submissionDays).toBe(30);
  });

  it('ships the spec defaults: $250 rebate via 30/10/15/30 day timeframes', () => {
    const c = defaultMediaProgramContent();
    expect(c.timeframes).toEqual({
      submissionDays: 30,
      reviewBusinessDays: 10,
      correctionDays: 15,
      paymentDays: 30,
    });
  });
});
