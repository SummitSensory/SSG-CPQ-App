import { describe, it, expect } from 'vitest';
import { belongsOnQueue } from '../../src/proposals/freightTrueUpService.js';

function base(overrides: Partial<Parameters<typeof belongsOnQueue>[0]> = {}) {
  return {
    openBucketCount: 0,
    stagedCount: 0,
    appliedNotPushedCount: 0,
    hasInvoice: false,
    includeSettled: false,
    ...overrides,
  };
}

describe('belongsOnQueue', () => {
  it('keeps a job with an open (unanswered) freight bucket', () => {
    expect(belongsOnQueue(base({ openBucketCount: 1 }))).toBe(true);
  });

  it('keeps a job with a staged amount waiting to be applied', () => {
    expect(belongsOnQueue(base({ stagedCount: 1 }))).toBe(true);
  });

  it('drops a job whose freight is applied but has no invoice to bill it onto', () => {
    // The bug Bryan reported: applied freight with no invoice offered "add to the
    // invoice" for a document that doesn't exist. Once there's nothing left to do
    // until an invoice is raised, the job must clear from the queue.
    expect(belongsOnQueue(base({ appliedNotPushedCount: 1, hasInvoice: false }))).toBe(false);
  });

  it('keeps a job whose freight is applied and there IS an invoice to push it onto', () => {
    expect(belongsOnQueue(base({ appliedNotPushedCount: 1, hasInvoice: true }))).toBe(true);
  });

  it('drops a fully quiet job (nothing open, staged, or applied)', () => {
    expect(belongsOnQueue(base())).toBe(false);
  });

  it('includeSettled always keeps the job, regardless of state', () => {
    expect(belongsOnQueue(base({ includeSettled: true }))).toBe(true);
  });
});
