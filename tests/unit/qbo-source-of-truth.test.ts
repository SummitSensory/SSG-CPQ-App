import { describe, it, expect } from 'vitest';
import { sourceOfTruth, canWriteFromQbo, QBO_SOURCE_OF_TRUTH } from '../../src/integrations/quickbooks/source-of-truth.js';

describe('QuickBooks source-of-truth matrix', () => {
  it('treats all proposal/financial fields as CPQ-authoritative', () => {
    for (const field of ['estimate.total', 'estimate.lines', 'invoice.amount', 'customer.displayName']) {
      expect(sourceOfTruth(field), field).toBe('CPQ');
    }
  });

  it('never allows a CPQ-authoritative field to be written from QuickBooks', () => {
    for (const field of ['estimate.total', 'invoice.amount', 'estimate.lines', 'customer.billingAddress']) {
      expect(canWriteFromQbo(field), field).toBe(false);
    }
  });

  it('allows QuickBooks-owned lifecycle fields to flow back for reconciliation', () => {
    for (const field of ['transaction.qboId', 'transaction.docNumber', 'invoice.paymentStatus', 'invoice.balance']) {
      expect(sourceOfTruth(field), field).toBe('QBO');
      expect(canWriteFromQbo(field), field).toBe(true);
    }
  });

  it('refuses unknown fields', () => {
    expect(sourceOfTruth('nope')).toBeUndefined();
    expect(canWriteFromQbo('nope')).toBe(false);
  });

  it('every mapping row declares an owner and a direction', () => {
    for (const row of QBO_SOURCE_OF_TRUTH) {
      expect(['CPQ', 'QBO']).toContain(row.owner);
      expect(['CPQ_TO_QBO', 'QBO_TO_CPQ', 'NONE']).toContain(row.sync);
    }
  });
});
