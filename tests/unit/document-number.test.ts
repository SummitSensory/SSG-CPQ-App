import { describe, it, expect } from 'vitest';
import {
  allocateNumbered,
  isUniqueViolation,
  sequenceOf,
  formatNumber,
} from '../../src/lib/documentNumber.js';

/**
 * PROPOSAL-002 — two concurrent creates allocated the same document number and the
 * loser threw P2002 (a 500, with no proposal created).
 */
describe('document number allocation', () => {
  it('parses a sequence and ignores a foreign prefix', () => {
    expect(sequenceOf('P-2026-000079', 'P-2026-')).toBe(79);
    expect(sequenceOf('P-2025-000079', 'P-2026-')).toBe(0);
    expect(sequenceOf(null, 'P-2026-')).toBe(0);
    expect(sequenceOf('P-2026-oops', 'P-2026-')).toBe(0);
    expect(formatNumber('P-2026-', 80)).toBe('P-2026-000080');
  });

  it('recognises only a unique violation on the named column', () => {
    expect(isUniqueViolation({ code: 'P2002', meta: { target: ['number'] } }, 'number')).toBe(true);
    expect(
      isUniqueViolation({ code: 'P2002', meta: { target: ['proposalVersionId'] } }, 'number'),
    ).toBe(false);
    expect(isUniqueViolation({ code: 'P2025' }, 'number')).toBe(false);
    expect(isUniqueViolation(new Error('nope'), 'number')).toBe(false);
  });

  it('retries past a collision and lands on the next free number', async () => {
    const taken = new Set(['P-2026-000079', 'P-2026-000080']);
    let highest = 'P-2026-000078';
    const attempted: string[] = [];
    const result = await allocateNumbered<{ id: string }>({
      prefix: 'P-2026-',
      field: 'number',
      highest: async () => highest,
      create: async (number) => {
        attempted.push(number);
        if (taken.has(number)) {
          // Simulate the concurrent writer having advanced the high-water mark.
          highest = number;
          throw { code: 'P2002', meta: { target: ['number'] } };
        }
        return { id: 'created' };
      },
    });
    expect(attempted).toEqual(['P-2026-000079', 'P-2026-000080', 'P-2026-000081']);
    expect(result.number).toBe('P-2026-000081');
    expect(result.row.id).toBe('created');
  });

  it('rethrows a unique violation on any other column instead of retrying', async () => {
    let calls = 0;
    await expect(
      allocateNumbered({
        prefix: 'SO-2026-',
        field: 'number',
        highest: async () => null,
        create: async () => {
          calls += 1;
          throw { code: 'P2002', meta: { target: ['proposalVersionId'] } };
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(calls).toBe(1);
  });

  it('gives up after the attempt budget rather than looping forever', async () => {
    let calls = 0;
    await expect(
      allocateNumbered({
        prefix: 'P-2026-',
        field: 'number',
        attempts: 3,
        highest: async () => 'P-2026-000001',
        create: async () => {
          calls += 1;
          throw { code: 'P2002', meta: { target: ['number'] } };
        },
      }),
    ).rejects.toBeTruthy();
    expect(calls).toBe(3);
  });
});
