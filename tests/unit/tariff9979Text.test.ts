import { describe, it, expect } from 'vitest';
import { resolveTariff9979Text } from '../../src/crossborder/snapshot.js';

/**
 * The Section C tariff item 9979.00.00 row prints admin- or per-proposal wording
 * instead of fixed strings. The proposal's own override wins; otherwise the admin
 * wording for its answer; otherwise null, so the document prints its built-in wording.
 */

const settings = {
  tariff9979ClaimedText: 'Claimed under 9979.00.00',
  tariff9979NotClaimedText: 'Standard duty treatment',
  tariff9979UndeterminedText: 'To be confirmed with our broker',
};

describe('resolveTariff9979Text', () => {
  it('picks the admin wording for each answer', () => {
    expect(resolveTariff9979Text(null, true, settings)).toBe('Claimed under 9979.00.00');
    expect(resolveTariff9979Text(null, false, settings)).toBe('Standard duty treatment');
    expect(resolveTariff9979Text(null, null, settings)).toBe('To be confirmed with our broker');
  });

  it('lets a proposal’s own wording replace the admin wording, whatever the answer', () => {
    expect(resolveTariff9979Text('  Relief claimed  ', false, settings)).toBe('Relief claimed');
  });

  it('treats blank as unset at every level', () => {
    expect(resolveTariff9979Text('   ', true, settings)).toBe('Claimed under 9979.00.00');
    expect(resolveTariff9979Text('', true, { tariff9979ClaimedText: ' ' })).toBeNull();
    expect(resolveTariff9979Text(null, null, null)).toBeNull();
  });
});
