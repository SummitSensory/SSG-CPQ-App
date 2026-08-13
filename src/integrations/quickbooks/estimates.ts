import {
  minorToQboAmount,
  toSalesLines,
  projectCustomField,
  assertAssembledTotal,
  type AcceptedLine,
} from './mapping.js';
import { chargeDetail, feeChargeKind } from './chargeItems.js';

/**
 * Pure QuickBooks Estimate body builder. The estimate mirrors the accepted
 * proposal exactly: the proposal's own group headings and sub-headings as
 * description-only rows, one line per product (net), explicit fee lines, an
 * order discount line, and a tax line. It asserts the assembled total equals
 * the frozen accepted grand total and throws otherwise — the document is never
 * sent with a total that differs from the accepted proposal.
 *
 * Fee, discount and tax rows carry an ItemRef from chargeItems.ts. Without one
 * QuickBooks files them under the company's default sales item, which put every
 * freight, discount and tax dollar into the consulting-fee row of Sales by
 * Product/Service. The rows still post when no item is configured — an
 * unconfigured freight item must not block an accepted proposal — but the
 * integration status page reports the gap.
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
  /** monday.com Project ID, printed in the document's PROJECT ID custom field. */
  projectId?: string | null;
  /** DefinitionId of that custom field, resolved from company preferences. */
  projectFieldId?: string | null;
  /** Print a subtotal row under each proposal group. Default true. */
  groupSubtotals?: boolean;
}

export function buildEstimateBody(input: EstimateInput): Record<string, unknown> {
  const productLines = toSalesLines(input.lines, {
    currency: input.currency,
    groupSubtotals: input.groupSubtotals ?? true,
  });
  // Summed before the charge rows are appended, so a mismatch can say whether the
  // product lines or one of the charges is the component that disagrees.
  const productTotal = sumLineAmounts(productLines);
  const lines: Array<Record<string, unknown>> = [...productLines];

  for (const fee of input.fees) {
    if (fee.amountMinor === 0n) continue;
    // No Description: the charge item's own name prints on the line, and sending
    // our label as well printed the same thing twice.
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: minorToQboAmount(fee.amountMinor),
      SalesItemLineDetail: chargeDetail(feeChargeKind(fee.label)),
    });
  }
  if (input.orderDiscountMinor > 0n) {
    // A negative line rather than DiscountLineDetail: the discount is a frozen
    // amount off the accepted total, and DiscountLineDetail would have
    // QuickBooks recompute it against its own subtotal — which is exactly the
    // drift the total assertion exists to prevent.
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: minorToQboAmount(-input.orderDiscountMinor),
      SalesItemLineDetail: chargeDetail('DISCOUNT'),
    });
  }
  if (input.taxMinor > 0n) {
    // The proposal's Tax field is a freight tax pass-through, not sales tax on
    // the order — see chargeItems.ts. It posts as an ordinary charge line on the
    // pass-through item, deliberately outside QuickBooks' sales tax engine.
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: minorToQboAmount(input.taxMinor),
      SalesItemLineDetail: chargeDetail('FREIGHT_TAX'),
    });
  }

  const assembled = sumLineAmounts(lines);
  assertAssembledTotal('Estimate', assembled, input.expectedTotalMinor, [
    [
      `${input.lines.filter((l) => (l.kind ?? 'PRODUCT') === 'PRODUCT').length} product lines`,
      productTotal,
    ],
    ...input.fees.map((f) => [f.label, f.amountMinor] as [string, bigint]),
    ['discount', -input.orderDiscountMinor],
    ['tax', input.taxMinor],
  ]);

  const customField = projectCustomField(input.projectId, input.projectFieldId);
  return {
    CustomerRef: { value: input.customerQboId },
    CurrencyRef: { value: input.currency },
    ...(customField.length ? { CustomField: customField } : {}),
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
