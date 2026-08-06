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
  /**
   * Print a native QuickBooks subtotal at the end of each proposal section.
   * Default true — it is what makes the invoice read like the proposal.
   */
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
  const stages: Array<{ label: string; amount: bigint }> = [
    { label: 'Due upfront', amount: schedule.depositMinor },
    { label: 'Progress payment', amount: schedule.progressMinor },
    { label: 'Due prior to shipment', amount: schedule.finalMinor },
  ].filter((s) => s.amount > 0n);
  if (!stages.length) return null;

  // Percentages are rounded for display, and the LAST stage absorbs the residual
  // so they always sum to 100 — never "50% | 49.99%" on an even split.
  const percents = stages.map((s) => pct(s.amount, total) ?? 0);
  const rounded = percents.map((p) => Math.round(p));
  const drift = 100 - rounded.reduce((a, b) => a + b, 0);
  if (rounded.length) rounded[rounded.length - 1] = (rounded[rounded.length - 1] ?? 0) + drift;

  const parts = stages.map(
    (s, i) => `${s.label}: ${formatMinor(s.amount, currency)} (${rounded[i]}%)`,
  );
  return `PAYMENT SCHEDULE — ${parts.join('  |  ')}`;
}

export function buildInvoiceBody(input: InvoiceInput): Record<string, unknown> {
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
