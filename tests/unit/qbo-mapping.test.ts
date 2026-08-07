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

describe('proposal sections on a sales document', () => {
  const grouped = [
    { kind: 'GROUP' as const, description: 'Climbing Wall', quantity: 1, amountMinor: 0n },
    { description: 'Wall', quantity: 1, amountMinor: 189750n },
    { description: 'Shield', quantity: 2, amountMinor: 23920n },
  ];

  it('gives every product its own priced line', () => {
    const lines = toSalesLines(grouped);
    const priced = lines.filter((l) => typeof l.Amount === 'number');
    expect(priced).toHaveLength(2);
    expect(priced.every((l) => l.DetailType === 'SalesItemLineDetail')).toBe(true);
    expect(sumLineAmounts(lines)).toBe(213670n);
  });

  it('splits qty × rate only when the amount divides evenly', () => {
    const lines = toSalesLines([
      { description: 'Shield', quantity: 2, amountMinor: 23920n },
      // 3 does not divide 1001 — a rate of 3.34 would multiply back to 10.02.
      { description: 'Odd', quantity: 3, amountMinor: 1001n },
    ]);
    const even = lines[0]?.SalesItemLineDetail as { Qty: number; UnitPrice: number };
    expect(even.Qty).toBe(2);
    expect(even.UnitPrice).toBe(119.6);
    const odd = lines[1]?.SalesItemLineDetail as { Qty: number; UnitPrice: number };
    expect(odd.Qty).toBe(1);
    expect(odd.UnitPrice).toBe(10.01);
  });

  it('closes a section with a native subtotal that is not counted twice', () => {
    const lines = toSalesLines(grouped);
    const subtotals = lines.filter((l) => l.DetailType === 'SubTotalLineDetail');
    expect(subtotals).toHaveLength(1);
    expect(subtotals[0]?.Amount).toBeUndefined();
    expect(sumLineAmounts(lines)).toBe(213670n);
  });

  it('gives an empty section no subtotal', () => {
    const lines = toSalesLines([
      { kind: 'GROUP' as const, description: 'Nothing Here', quantity: 1, amountMinor: 0n },
    ]);
    expect(lines.filter((l) => l.DetailType === 'SubTotalLineDetail')).toHaveLength(0);
  });

  it('sends a kit as its own priced lines, never as a QuickBooks bundle', () => {
    // A Bundle would expand from its QuickBooks-side definition and ignore what the
    // proposal actually accepted, so kits go out as ordinary priced lines like
    // everything else.
    const lines = toSalesLines([
      { description: 'Hardware Kit', quantity: 1, amountMinor: 48655n, qboItemId: '907' },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.DetailType).toBe('SalesItemLineDetail');
    expect(lines[0]?.Amount).toBe(486.55);
    expect(lines.some((l) => l.DetailType === 'GroupLineDetail')).toBe(false);
  });

  it('still totals a GroupLineDetail read back from QuickBooks', () => {
    // Nothing we send produces one, but an invoice edited in QuickBooks can come
    // back with one and sumLineAmounts must not silently drop it.
    const withComponents = [
      {
        DetailType: 'GroupLineDetail',
        GroupLineDetail: { Line: [{ Amount: 300.0 }, { Amount: 186.55 }] },
      },
    ];
    expect(sumLineAmounts(withComponents)).toBe(48655n);
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
