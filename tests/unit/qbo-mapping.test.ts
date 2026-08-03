import { describe, it, expect } from 'vitest';
import {
  minorToQboAmount,
  toQboCustomer,
  toSalesLines,
  toQboItem,
} from '../../src/integrations/quickbooks/mapping.js';
import { buildEstimateBody, sumLineAmounts } from '../../src/integrations/quickbooks/estimates.js';
import {
  buildInvoiceBody,
  buildPortionInvoiceBody,
} from '../../src/integrations/quickbooks/invoices.js';

describe('QuickBooks mapping (money is decimal-safe)', () => {
  it('converts integer minor units to 2dp amounts without float drift', () => {
    expect(minorToQboAmount(199n)).toBe(1.99);
    expect(minorToQboAmount(100000n)).toBe(1000);
    expect(minorToQboAmount(5n)).toBe(0.05);
    expect(minorToQboAmount(-2500n)).toBe(-25);
  });

  it('round-trips minor units through QuickBooks lines exactly', () => {
    const lines = toSalesLines([
      { description: 'A', quantity: 1, amountMinor: 80000n },
      { description: 'B', quantity: 2, amountMinor: 12345n },
    ]);
    expect(sumLineAmounts(lines)).toBe(92345n);
  });

  it('builds a customer body from CRM data', () => {
    const body = toQboCustomer({
      displayName: 'Mercy Clinic',
      email: 'ap@mercy.org',
      billing: {
        line1: '1 Main',
        city: 'Denver',
        region: 'CO',
        postalCode: '80014',
        country: 'US',
      },
    });
    expect(body.DisplayName).toBe('Mercy Clinic');
    expect((body.PrimaryEmailAddr as { Address: string }).Address).toBe('ap@mercy.org');
    expect((body.BillAddr as { City: string }).City).toBe('Denver');
  });

  it('maps SERVICE products to Service and physical products to NonInventory', () => {
    expect(toQboItem({ name: 'Install', sku: 'SVC-1', kind: 'SERVICE' }, '79').Type).toBe(
      'Service',
    );
    expect(toQboItem({ name: 'Swing', sku: 'PRD-1', kind: 'PRODUCT' }, '79').Type).toBe(
      'NonInventory',
    );
  });
});

describe('bundled group lines', () => {
  const grouped = [
    { kind: 'GROUP' as const, description: 'Climbing Wall', quantity: 1, amountMinor: 0n },
    { description: 'Wall', quantity: 1, amountMinor: 189750n },
    { description: 'Shield', quantity: 2, amountMinor: 23920n },
  ];

  it('prices the parent line at the sum of its components', () => {
    const lines = toSalesLines(grouped, { bundleGroups: true });
    const priced = lines.filter((l) => typeof l.Amount === 'number');
    expect(priced).toHaveLength(1);
    expect(priced[0]?.Description).toBe('CLIMBING WALL');
    expect(sumLineAmounts(lines)).toBe(213670n);
  });

  it('renders components as description rows carrying no money', () => {
    const lines = toSalesLines(grouped, { bundleGroups: true });
    const components = lines.filter((l) => l.DetailType === 'DescriptionOnly');
    expect(components).toHaveLength(2);
    for (const c of components) expect(c.Amount).toBeUndefined();
    expect(String(components[1]?.Description)).toContain('2 ×');
  });

  it('unbundled mode keeps one priced line per product plus a subtotal row', () => {
    const lines = toSalesLines(grouped, { bundleGroups: false });
    expect(lines.filter((l) => typeof l.Amount === 'number')).toHaveLength(2);
    expect(sumLineAmounts(lines)).toBe(213670n);
  });
});

describe('QuickBooks estimate builder preserves accepted totals', () => {
  const base = {
    customerQboId: 'C-1',
    currency: 'USD',
    memo: 'm',
    lines: [{ description: 'Swing', quantity: 1, amountMinor: 80000n }],
    fees: [{ label: 'freight', amountMinor: 10000n }],
    orderDiscountMinor: 0n,
    taxMinor: 10000n,
  };

  it('sends only when the assembled total equals the accepted total', () => {
    const body = buildEstimateBody({ ...base, expectedTotalMinor: 100000n });
    expect(sumLineAmounts(body.Line as Array<Record<string, unknown>>)).toBe(100000n);
  });

  it('refuses to build a document whose total differs from the accepted total', () => {
    expect(() => buildEstimateBody({ ...base, expectedTotalMinor: 999n })).toThrow(
      /never be altered/,
    );
  });

  it('applies an order discount as a negative line, keeping the total exact', () => {
    const body = buildEstimateBody({
      ...base,
      orderDiscountMinor: 5000n,
      expectedTotalMinor: 95000n,
    });
    expect(sumLineAmounts(body.Line as Array<Record<string, unknown>>)).toBe(95000n);
  });
});

describe('QuickBooks full-value invoice builder', () => {
  const base = {
    customerQboId: 'C-1',
    currency: 'USD',
    memo: 'm',
    lines: [{ description: 'Swing', quantity: 1, amountMinor: 80000n }],
    fees: [{ label: 'freight', amountMinor: 10000n }],
    orderDiscountMinor: 0n,
    taxMinor: 10000n,
  };

  it('bills the whole accepted order, itemized', () => {
    const body = buildInvoiceBody({ ...base, expectedTotalMinor: 100000n });
    expect(sumLineAmounts(body.Line as Array<Record<string, unknown>>)).toBe(100000n);
  });

  it('refuses to build a document whose total differs from the accepted total', () => {
    expect(() => buildInvoiceBody({ ...base, expectedTotalMinor: 999n })).toThrow();
  });

  it('states the payment split without altering the total', () => {
    const body = buildInvoiceBody({
      ...base,
      expectedTotalMinor: 100000n,
      schedule: { depositMinor: 50000n, progressMinor: 0n, finalMinor: 50000n },
    });
    const lines = body.Line as Array<Record<string, unknown>>;
    expect(sumLineAmounts(lines)).toBe(100000n);
    const note = lines.find((l) => String(l.Description ?? '').startsWith('PAYMENT SCHEDULE'));
    expect(String(note?.Description)).toContain('50%');
  });

  it('sets the term reference only when one is supplied', () => {
    const withTerm = buildInvoiceBody({ ...base, expectedTotalMinor: 100000n, salesTermId: '7' });
    expect(withTerm.SalesTermRef).toEqual({ value: '7' });
    const without = buildInvoiceBody({ ...base, expectedTotalMinor: 100000n });
    expect(without.SalesTermRef).toBeUndefined();
  });
});

describe('QuickBooks portion invoice builder', () => {
  it('bills the exact schedule portion', () => {
    const body = buildPortionInvoiceBody({
      customerQboId: 'C-1',
      currency: 'USD',
      amountMinor: 30000n,
      description: 'Deposit',
      memo: 'm',
    });
    expect(sumLineAmounts(body.Line as Array<Record<string, unknown>>)).toBe(30000n);
  });

  it('never bills a zero or negative amount', () => {
    expect(() =>
      buildPortionInvoiceBody({
        customerQboId: 'C-1',
        currency: 'USD',
        amountMinor: 0n,
        description: 'x',
        memo: 'm',
      }),
    ).toThrow();
  });
});
