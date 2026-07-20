import { describe, it, expect } from 'vitest';
import { canTransition, becomesFrozen, isFrozenStatus, formatProposalNumber } from '../../src/proposals/status.js';

describe('proposal status lifecycle & immutability', () => {
  it('allows the intended forward transitions', () => {
    expect(canTransition('DRAFT', 'INTERNAL_REVIEW')).toBe(true);
    expect(canTransition('INTERNAL_REVIEW', 'RELEASED')).toBe(true);
    expect(canTransition('RELEASED', 'ACCEPTED')).toBe(true);
    expect(canTransition('RELEASED', 'REJECTED')).toBe(true);
    expect(canTransition('RELEASED', 'EXPIRED')).toBe(true);
  });

  it('forbids editing-style transitions out of terminal/released states', () => {
    expect(canTransition('RELEASED', 'DRAFT')).toBe(false);
    expect(canTransition('ACCEPTED', 'DRAFT')).toBe(false);
    expect(canTransition('REJECTED', 'RELEASED')).toBe(false);
    expect(canTransition('EXPIRED', 'RELEASED')).toBe(false);
  });

  it('marks a version frozen on release', () => {
    expect(becomesFrozen('RELEASED')).toBe(true);
    expect(becomesFrozen('INTERNAL_REVIEW')).toBe(false);
  });

  it('treats released and all terminal statuses as frozen', () => {
    for (const st of ['RELEASED', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const) {
      expect(isFrozenStatus(st)).toBe(true);
    }
    expect(isFrozenStatus('DRAFT')).toBe(false);
    expect(isFrozenStatus('INTERNAL_REVIEW')).toBe(false);
  });

  it('formats a zero-padded proposal number', () => {
    expect(formatProposalNumber(2026, 42)).toBe('P-2026-000042');
  });
});
