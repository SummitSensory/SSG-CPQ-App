import { minorToQboAmount, toSalesLines, type AcceptedLine } from './mapping.js';

/**
 * Pure QuickBooks Estimate body builder. The estimate mirrors the accepted
 * proposal exactly: the proposal's own group headings and sub-headings as
 * description-only rows, one line per product (net), explicit fee lines, an
 * order discount line, and a tax line. It asserts the assembled total equals
 * the frozen accepted grand total and throws otherwise — the document is never
 * sent with a total that differs from the accepted proposal.
 */
export interface EstimateInput {
  customerQboId: string;
  currency: string;
  docNumber?: string;
  memo: string;
  /** Customer-facing email; QuickBooks stores it on the document. */
  billEmail?: string | null;
  /** yyyy-mm-dd — the accepted proposal's expiration. */
  expirationDate?: string | null;
  /** yyyy-mm-dd — document date; defaults to today in QuickBooks. */
  txnDate?: string | null;
  lines: AcceptedLine[];
  fees: Array<{ label: string; amountMinor: bigint }>;
  orderDiscountMinor: bigint;
  taxMinor: bigint;
  expectedTotalMinor: bigint;
  /** Print a subtotal row under each proposal group. Default true. */
  groupSubtotals?: boolean;
}

export function buildEstimateBody(input: EstimateInput): Record<string, unknown> {
  const lines: Array<Record<string, unknown>> = [
    ...toSalesLines(input.lines, {
      currency: input.currency,
      groupSubtotals: input.groupSubtotals ?? true,
    }),
  ];

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
    ...(input.billEmail ? { BillEmail: { Address: input.billEmail } } : {}),
    ...(input.txnDate ? { TxnDate: input.txnDate } : {}),
    ...(input.expirationDate ? { ExpirationDate: input.expirationDate } : {}),
    CustomerMemo: { value: input.memo },
    Line: lines,
  };
}

/**
 * Sum QuickBooks line Amounts back into minor units (bigint) for exact checks.
 * Description-only rows carry no Amount and are skipped — they are presentation,
 * not money.
 */
export function sumLineAmounts(lines: Array<Record<string, unknown>>): bigint {
  return lines.reduce((acc: bigint, l) => {
    // A subtotal restates money already counted; adding it would double the
    // section it summarises and fail the assertion against the frozen total.
    if (l.DetailType === 'SubTotalLineDetail') return acc;

    // A bundle's parent line carries no Amount — the money is on the component
    // rows QuickBooks expands beneath it, so those are what get summed.
    if (l.DetailType === 'GroupLineDetail') {
      const detail = l.GroupLineDetail as { Line?: Array<Record<string, unknown>> } | undefined;
      return acc + sumLineAmounts(detail?.Line ?? []);
    }

    const amount = l.Amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return acc;
    return acc + BigInt(Math.round(amount * 100));
  }, 0n);
}
