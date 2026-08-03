import { minorToQboAmount, formatMinor, toSalesLines, type AcceptedLine } from './mapping.js';
import { sumLineAmounts } from './estimates.js';

/**
 * Pure QuickBooks Invoice body builder.
 *
 * The invoice is the FULL accepted order, itemized — the same structure as the
 * estimate — with the payment split expressed as terms rather than as separate
 * portion invoices. That mirrors how SSG actually bills: one document for the
 * whole project, "50% Upfront / 50% PIA" in the TERMS field.
 *
 * As with the estimate, the assembled line total is asserted against the frozen
 * accepted grand total and throws on mismatch, so an invoice can never bill an
 * amount the customer did not accept.
 */
export interface InvoiceInput {
  customerQboId: string;
  currency: string;
  docNumber?: string;
  /** Customer-facing email; QuickBooks stores it on the document. */
  billEmail?: string | null;
  /** yyyy-mm-dd. */
  dueDate?: string | null;
  txnDate?: string | null;
  memo: string;
  lines: AcceptedLine[];
  fees: Array<{ label: string; amountMinor: bigint }>;
  orderDiscountMinor: bigint;
  taxMinor: bigint;
  expectedTotalMinor: bigint;
  /**
   * QuickBooks Term id (Settings → All lists → Terms). Optional: without it the
   * customer's default term applies, and the split is still stated on the
   * document as a closing description row.
   */
  salesTermId?: string | null;
  /** Frozen payment schedule, used to state the split in words. */
  schedule?: { depositMinor: bigint; progressMinor: bigint; finalMinor: bigint } | null;
  /** Render each proposal group as a bundle. Default true. */
  bundleGroups?: boolean;
  groupSubtotals?: boolean;
}

/** Percent of the grand total to 2dp, or null when not meaningful. */
function pct(part: bigint, whole: bigint): number | null {
  if (whole <= 0n || part <= 0n) return null;
  const bp = (part * 10000n) / whole;
  const asPercent = Number(bp) / 100;
  return Number.isFinite(asPercent) ? Math.round(asPercent * 100) / 100 : null;
}

/**
 * State the accepted payment split in words. Derived from the frozen schedule,
 * never a hand-typed string, so the document cannot disagree with what the
 * customer accepted.
 */
function scheduleNote(
  schedule: NonNullable<InvoiceInput['schedule']>,
  total: bigint,
  currency: string,
): string | null {
  const parts: string[] = [];
  const add = (label: string, amount: bigint) => {
    if (amount <= 0n) return;
    const p = pct(amount, total);
    parts.push(`${label}: ${formatMinor(amount, currency)}${p !== null ? ` (${p}%)` : ''}`);
  };
  add('Due upfront', schedule.depositMinor);
  add('Progress payment', schedule.progressMinor);
  add('Due prior to shipment', schedule.finalMinor);
  return parts.length ? `PAYMENT SCHEDULE — ${parts.join('  |  ')}` : null;
}

export function buildInvoiceBody(input: InvoiceInput): Record<string, unknown> {
  const lines: Array<Record<string, unknown>> = [
    ...toSalesLines(input.lines, {
      currency: input.currency,
      bundleGroups: input.bundleGroups ?? true,
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
      `Invoice lines total ${assembled} but the accepted grand total is ${input.expectedTotalMinor}`,
    );
  }

  // Closing description row, added after the assertion so it can never move money.
  if (input.schedule) {
    const note = scheduleNote(input.schedule, input.expectedTotalMinor, input.currency);
    if (note) lines.push({ DetailType: 'DescriptionOnly', Description: note });
  }

  return {
    CustomerRef: { value: input.customerQboId },
    CurrencyRef: { value: input.currency },
    ...(input.docNumber ? { DocNumber: input.docNumber } : {}),
    ...(input.billEmail ? { BillEmail: { Address: input.billEmail } } : {}),
    ...(input.txnDate ? { TxnDate: input.txnDate } : {}),
    ...(input.dueDate ? { DueDate: input.dueDate } : {}),
    ...(input.salesTermId ? { SalesTermRef: { value: input.salesTermId } } : {}),
    CustomerMemo: { value: input.memo },
    Line: lines,
  };
}

/**
 * Portion-invoice body: a single summary line billing one slice of the accepted
 * payment schedule (deposit / progress / final). Retained for staged billing;
 * SSG's default flow uses buildInvoiceBody for the full itemized order instead.
 */
export interface PortionInvoiceInput {
  customerQboId: string;
  currency: string;
  amountMinor: bigint;
  description: string;
  memo: string;
  docNumber?: string;
  billEmail?: string | null;
  dueDate?: string | null;
}

export function buildPortionInvoiceBody(input: PortionInvoiceInput): Record<string, unknown> {
  if (input.amountMinor <= 0n) {
    throw new Error(`Invoice amount must be positive, got ${input.amountMinor}`);
  }
  return {
    CustomerRef: { value: input.customerQboId },
    CurrencyRef: { value: input.currency },
    ...(input.docNumber ? { DocNumber: input.docNumber } : {}),
    ...(input.billEmail ? { BillEmail: { Address: input.billEmail } } : {}),
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
