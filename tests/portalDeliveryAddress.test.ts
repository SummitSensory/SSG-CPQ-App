import { describe, expect, it } from 'vitest';
import { parseFormattedAddress } from '../src/integrations/monday/portalDelivery.js';

describe('parseFormattedAddress', () => {
  it('reads a unit number as line 2', () => {
    expect(
      parseFormattedAddress('901 N Washington St, 320, Alexandria, Virginia 22314, United States'),
    ).toEqual({
      line1: '901 N Washington St',
      line2: '320',
      city: 'Alexandria',
      region: 'Virginia',
      postalCode: '22314',
      country: 'United States',
    });
  });

  it('reads a plain street / city / state ZIP / country line', () => {
    expect(parseFormattedAddress('3906 state hwy A, Albany, MO 64402, United States')).toEqual({
      line1: '3906 state hwy A',
      line2: null,
      city: 'Albany',
      region: 'MO',
      postalCode: '64402',
      country: 'United States',
    });
  });

  it('does not mind lower case, and copes with a missing country', () => {
    expect(parseFormattedAddress('1315 W 4th St , Skiatook, ok 74070')).toEqual({
      line1: '1315 W 4th St',
      line2: null,
      city: 'Skiatook',
      region: 'ok',
      postalCode: '74070',
      country: null,
    });
  });

  it('keeps a two-part suite as line 2', () => {
    expect(
      parseFormattedAddress('6198 Butler Pike, Ste 212, Blue Bell, PA 19422, United States'),
    ).toEqual({
      line1: '6198 Butler Pike',
      line2: 'Ste 212',
      city: 'Blue Bell',
      region: 'PA',
      postalCode: '19422',
      country: 'United States',
    });
  });

  it('reads a Canadian postal code', () => {
    expect(parseFormattedAddress('120 Adelaide St W, Toronto, Ontario M5H 1T1, Canada')).toEqual({
      line1: '120 Adelaide St W',
      line2: null,
      city: 'Toronto',
      region: 'Ontario',
      postalCode: 'M5H 1T1',
      country: 'Canada',
    });
  });

  it('gives back nothing it cannot read, rather than guessing', () => {
    for (const bad of ['', '   ', 'Alexandria', 'VA 22314']) {
      const p = parseFormattedAddress(bad);
      expect(p.line1 && p.city).toBeFalsy();
    }
  });
});
