import { describe, it, expect } from 'vitest';
import {
  VersionContentPatchSchema,
  BuilderLineSchema,
  assertMetaSectionsValid,
} from '../../src/proposals/validation.js';

/**
 * PROPOSAL-001 — `PATCH /proposals/versions/:versionId` accepted arbitrary JSON as
 * proposal content. These are the values that must never reach a price snapshot.
 */
describe('builder content validation', () => {
  const line = { lineType: 'PRODUCT', name: 'Trolley', quantity: 2, rateMinor: 125_00 };

  it('accepts a normal line and keeps fields it does not name', () => {
    const parsed = BuilderLineSchema.parse({ ...line, components: [{ part: 'H-1000' }] });
    expect(parsed.quantity).toBe(2);
    expect((parsed as Record<string, unknown>).components).toBeTruthy();
  });

  it('rejects fractional money', () => {
    expect(BuilderLineSchema.safeParse({ ...line, rateMinor: 12.5 }).success).toBe(false);
    expect(BuilderLineSchema.safeParse({ ...line, costEach: 0.001 }).success).toBe(false);
  });

  it('rejects a negative or fractional quantity', () => {
    expect(BuilderLineSchema.safeParse({ ...line, quantity: -1 }).success).toBe(false);
    expect(BuilderLineSchema.safeParse({ ...line, quantity: 1.5 }).success).toBe(false);
  });

  it('rejects money beyond the integer-safe range', () => {
    expect(BuilderLineSchema.safeParse({ ...line, rateMinor: 1e15 }).success).toBe(false);
    expect(BuilderLineSchema.safeParse({ ...line, rateMinor: Infinity }).success).toBe(false);
  });

  it('accepts a null rate — unpriced is not the same as zero', () => {
    const parsed = BuilderLineSchema.parse({ ...line, rateMinor: null });
    expect(parsed.rateMinor).toBeNull();
  });

  it('caps line count and description length', () => {
    const many = { items: Array.from({ length: 2_001 }, () => line) };
    expect(VersionContentPatchSchema.safeParse(many).success).toBe(false);
    const long = { items: [{ ...line, description: 'x'.repeat(20_001) }] };
    expect(VersionContentPatchSchema.safeParse(long).success).toBe(false);
  });

  it('rejects a discount percentage outside 0–100', () => {
    expect(() => assertMetaSectionsValid([{ id: 'meta', data: { discountPct: 250 } }])).toThrow(
      /discount/i,
    );
    expect(() =>
      assertMetaSectionsValid([{ id: 'meta', data: { discountPct: 15 } }]),
    ).not.toThrow();
  });

  it('rejects fractional cents in the header amounts', () => {
    expect(() => assertMetaSectionsValid([{ id: 'meta', data: { taxAmountMinor: 10.5 } }])).toThrow(
      /whole minor units/i,
    );
  });

  it('passes an ordinary save through untouched', () => {
    const body = {
      title: 'Therapy Spot gym',
      items: [line],
      sections: [
        { id: 'meta', type: 'CUSTOMER_INFO', order: 0, data: { projectId: '12414494509' } },
      ],
      expectedUpdatedAt: '2026-08-17T10:00:00.000Z',
    };
    const parsed = VersionContentPatchSchema.parse(body);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.expectedUpdatedAt).toBe('2026-08-17T10:00:00.000Z');
    expect(() => assertMetaSectionsValid(body.sections)).not.toThrow();
  });
});
