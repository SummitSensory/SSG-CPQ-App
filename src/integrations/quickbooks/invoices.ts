import { minorToQboAmount } from './mapping.js';

/**
 * Pure QuickBooks Invoice body builder for a payment-schedule portion
 * (deposit / progress / final). The portion amount comes straight from the
 * frozen accepted payment schedule, so the invoice can never bill an amount the
 * customer did not accept. A single summary line carries the exact portion and
 * a description that traces back to the accepted proposal version.
 */
export interface InvoiceInput {
  customerQboId: string;
  currency: string;
  amountMinor: bigint;
  description: string;
  memo: string;
  docNumber?: string;
  dueDate?: string; // yyyy-mm-dd
}

export function buildInvoiceBody(input: InvoiceInput): Record<string, unknown> {
  if (input.amountMinor <= 0n) {
    throw new Error(`Invoice amount must be positive, got ${input.amountMinor}`);
  }
  return {
    CustomerRef: { value: input.customerQboId },
    CurrencyRef: { value: input.currency },
    ...(input.docNumber ? { DocNumber: input.docNumber } : {}),
    ...(input.dueDate ? { DueDate: input.dueDate } : {}),
    CustomerMemo: { value: input.memo },
    Line: [
      {
        DetailType: 'SalesItemLineDetail',
        Amount: minorToQboAmount(input.amountMinor),
        Description: input.description,
        SalesItemLineDetail: { Qty: 1 },
      },
    ],
  };
}
