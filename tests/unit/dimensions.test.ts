import { describe, it, expect } from 'vitest';
import { formatDimensions, formatAxis, formatMeasure, hasDimensions } from '../../src/catalog/dimensions.js';

describe('dimension formatting', () => {
  it('orders axes L x W x H x T', () => {
    expect(formatDimensions({ lengthIn: 72, widthIn: 36, heightIn: 4, thicknessIn: 2 })).toBe('72"L x 36"W x 4"H x 2"T');
  });
  it('skips null axes without leaving separators', () => {
    expect(formatDimensions({ lengthIn: 72, heightIn: 8 })).toBe('72"L x 8"H');
    expect(formatDimensions({ widthIn: 36 })).toBe('36"W');
  });
  it('trims trailing zeros', () => {
    expect(formatMeasure(72.0)).toBe('72');
    expect(formatMeasure(1.5)).toBe('1.5');
    expect(formatMeasure(0.125)).toBe('0.125');
  });
  it('puts the inch mark before the axis letter', () => {
    expect(formatAxis(48, 'L')).toBe('48"L');
  });
  it('returns null when there is nothing to show', () => {
    expect(formatDimensions({})).toBeNull();
    expect(formatDimensions({ lengthIn: 0, widthIn: null })).toBeNull();
  });
  it('override wins over axis values', () => {
    expect(
      formatDimensions({ lengthIn: 72, widthIn: 36, dimensionsOverride: '72"L x 24"W x 12"H x 24"W x 2"T' }),
    ).toBe('72"L x 24"W x 12"H x 24"W x 2"T');
  });
  it('showDimensions false suppresses the line even with an override', () => {
    expect(formatDimensions({ dimensionsOverride: '10"L', showDimensions: false })).toBeNull();
  });
  it('hasDimensions reflects any usable data', () => {
    expect(hasDimensions({})).toBe(false);
    expect(hasDimensions({ thicknessIn: 2 })).toBe(true);
    expect(hasDimensions({ dimensionsOverride: 'custom' })).toBe(true);
  });
});
