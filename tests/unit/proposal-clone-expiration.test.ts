import { describe, it, expect } from 'vitest';
import { clonedVersionExpiration, DEFAULT_EXPIRATION_DAYS } from '../../src/proposals/service.js';

/**
 * Cloning a version (createNewVersion) already stamps the new version's proposal
 * date with today (withProposalDate) — the expiration date must move with it,
 * offered as N days from the new proposal date, not carried over as a fixed
 * calendar date from the version it was cloned from. Before this fix, a proposal
 * cloned today could still expire on whatever date the original was created,
 * sometimes already in the past.
 */
describe('clonedVersionExpiration', () => {
  it('recomputes N days from the new proposal date when the old version had an expiration', () => {
    const oldExpiration = new Date('2026-08-20T00:00:00.000Z'); // stale, from the old version
    const result = clonedVersionExpiration(oldExpiration, '2026-09-10');
    expect(result?.toISOString().slice(0, 10)).toBe('2026-09-17');
  });

  it('stays null when the old version had no expiration policy at all', () => {
    expect(clonedVersionExpiration(null, '2026-09-10')).toBeNull();
  });

  it('uses the same default window the builder itself offers a brand-new proposal', () => {
    expect(DEFAULT_EXPIRATION_DAYS).toBe(7);
  });

  it('honors an explicit day count when given one', () => {
    const oldExpiration = new Date('2026-01-01T00:00:00.000Z');
    const result = clonedVersionExpiration(oldExpiration, '2026-09-10', 14);
    expect(result?.toISOString().slice(0, 10)).toBe('2026-09-24');
  });

  it("is not sensitive to the old expiration's own time-of-day, only that one existed", () => {
    const oldExpiration = new Date('2026-01-01T23:59:59.999Z');
    const result = clonedVersionExpiration(oldExpiration, '2026-09-10');
    expect(result?.toISOString().slice(0, 10)).toBe('2026-09-17');
  });
});
