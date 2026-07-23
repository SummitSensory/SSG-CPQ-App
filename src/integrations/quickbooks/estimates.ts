import { minorToQboAmount, toSalesLines, type AcceptedLine } from './mapping.js';

/**
 * Pure QuickBooks Estimate body builder. The estimate mirrors the accepted
 * proposal exactly: one line per product (net), explicit fee lines, an order
 * discount line, and a tax line. It asserts the assembled total equals the
 * frozen accepted grand total and throws otherwise — the document is never sent
 * with a total that differs from the accepted proposal.
 */
export interface EstimateInput {
  customerQboId: string;
  currency: string;
  docNumber?: string;
  memo: string;
  lines: AcceptedLine[];
  fees: Array<{ label: string; amountMinor: bigint }>;
  orderDiscountMinor: bigint;
  taxMinor: bigint;
  expectedTotalMinor: bigint;
}

export function buildEstimateBody(input: EstimateInput): Record<string, unknown> {
  const lines: Array<Record<string, unknown>> = [...toSalesLines(input.lines)];

  for (const fee of input.fees) {
    if (fee.amountMinor === 0n) continue;
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: minorToQboAmount(fee.amountMinor),
      Description: fee.label,
      SalesItemLineDetail: { Qty: 1 },
    });
  }
  if (input.orderDiscountMinor > 0n) {
    // Represented as a negative line so the document total stays exact without
    // requiring a configured QuickBooks discount account (scaffold). Production
    // mapping may switch to DiscountLineDetail.
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: minorToQboAmount(-input.orderDiscountMinor),
      Description: 'Order discount (per accepted proposal)',
      SalesItemLineDetail: { Qty: 1 },
    });
  }
  if (input.taxMinor > 0n) {
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: minorToQboAmount(input.taxMinor),
      Description: 'Sales tax (per accepted proposal)',
      SalesItemLineDetail: { Qty: 1 },
    });
  }

  const assembled = sumLineAmounts(lines);
  if (assembled !== input.expectedTotalMinor) {
    throw new Error(
      `Estimate total ${assembled} does not match accepted proposal total ${input.expectedTotalMinor} — refusing to send (accepted totals must never be altered).`,
    );
  }

  return {
    CustomerRef: { value: input.customerQboId },
    CurrencyRef: { value: input.currency },
    ...(input.docNumber ? { DocNumber: input.docNumber } : {}),
    CustomerMemo: { value: input.memo },
    Line: lines,
  };
}

/** Sum QuickBooks line Amounts back into minor units (bigint) for exact checks. */
export function sumLineAmounts(lines: Array<Record<string, unknown>>): bigint {
  return lines.reduce((acc, l) => {
    const amount = l.Amount as number;
    return acc + BigInt(Math.round(amount * 100));
  }, 0n);
}
