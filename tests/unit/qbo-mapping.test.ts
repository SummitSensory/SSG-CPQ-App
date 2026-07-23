import { describe, it, expect } from 'vitest';
import { minorToQboAmount, toQboCustomer, toSalesLines, toQboItem } from '../../src/integrations/quickbooks/mapping.js';
import { buildEstimateBody, sumLineAmounts } from '../../src/integrations/quickbooks/estimates.js';
import { buildInvoiceBody } from '../../src/integrations/quickbooks/invoices.js';

describe('QuickBooks mapping (money is decimal-safe)', () => {
  it('converts integer minor units to 2dp amounts without float drift', () => {
    expect(minorToQboAmount(199n)).toBe(1.99);
    expect(minorToQboAmount(100000n)).toBe(1000);
    expect(minorToQboAmount(5n)).toBe(0.05);
    expect(minorToQboAmount(-2500n)).toBe(-25);
  });

  it('round-trips minor units through QuickBooks lines exactly', () => {
    const lines = toSalesLines([{ description: 'A', quantity: 1, amountMinor: 80000n }, { description: 'B', quantity: 2, amountMinor: 12345n }]);
    expect(sumLineAmounts(lines)).toBe(92345n);
  });

  it('builds a customer body from CRM data', () => {
    const body = toQboCustomer({ displayName: 'Mercy Clinic', email: 'ap@mercy.org', billing: { line1: '1 Main', city: 'Denver', region: 'CO', postalCode: '80014', country: 'US' } });
    expect(body.DisplayName).toBe('Mercy Clinic');
    expect((body.PrimaryEmailAddr as { Address: string }).Address).toBe('ap@mercy.org');
    expect((body.BillAddr as { City: string }).City).toBe('Denver');
  });

  it('maps SERVICE products to Service and physical products to NonInventory', () => {
    expect(toQboItem({ name: 'Install', sku: 'SVC-1', kind: 'SERVICE' }, '79').Type).toBe('Service');
    expect(toQboItem({ name: 'Swing', sku: 'PRD-1', kind: 'PRODUCT' }, '79').Type).toBe('NonInventory');
  });
});

describe('QuickBooks estimate builder preserves accepted totals', () => {
  const base = {
    customerQboId: 'C-1', currency: 'USD', memo: 'm',
    lines: [{ description: 'Swing', quantity: 1, amountMinor: 80000n }],
    fees: [{ label: 'freight', amountMinor: 10000n }],
    orderDiscountMinor: 0n, taxMinor: 10000n,
  };

  it('sends only when the assembled total equals the accepted total', () => {
    const body = buildEstimateBody({ ...base, expectedTotalMinor: 100000n });
    expect(sumLineAmounts(body.Line as Array<Record<string, unknown>>)).toBe(100000n);
  });

  it('refuses to build a document whose total differs from the accepted total', () => {
    expect(() => buildEstimateBody({ ...base, expectedTotalMinor: 999n })).toThrow(/never be altered/);
  });

  it('applies an order discount as a negative line, keeping the total exact', () => {
    const body = buildEstimateBody({ ...base, orderDiscountMinor: 5000n, expectedTotalMinor: 95000n });
    expect(sumLineAmounts(body.Line as Array<Record<string, unknown>>)).toBe(95000n);
  });
});

describe('QuickBooks invoice builder', () => {
  it('bills the exact schedule portion', () => {
    const body = buildInvoiceBody({ customerQboId: 'C-1', currency: 'USD', amountMinor: 30000n, description: 'Deposit', memo: 'm' });
    expect(sumLineAmounts(body.Line as Array<Record<string, unknown>>)).toBe(30000n);
  });

  it('never bills a zero or negative amount', () => {
    expect(() => buildInvoiceBody({ customerQboId: 'C-1', currency: 'USD', amountMinor: 0n, description: 'x', memo: 'm' })).toThrow();
  });
});
