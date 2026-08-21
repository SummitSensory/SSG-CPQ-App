import {
  minorToQboAmount,
  formatMinor,
  assertAssembledTotal,
  projectCustomField,
} from './mapping.js';
import { sumLineAmounts } from './estimates.js';
import { chargeDetail, type ChargeKind } from './chargeItems.js';
import { FREIGHT_BUCKETS, type FreightBucket } from '../../proposals/freightTrueUp.js';

/**
 * QuickBooks bodies for freight that arrives after the invoice.
 *
 * Two shapes, because an invoice stops being freely editable the moment money is
 * applied to it:
 *
 *   AMEND      — the freight rows are appended to the existing invoice and its total
 *                goes up. Correct while nothing has been paid: the customer receives
 *                one document for the job, which is how SSG bills.
 *   SUPPLEMENT — a separate freight-only invoice. Used once a payment exists, because
 *                raising the total of an invoice a customer has partly paid rewrites
 *                history in the ledger and confuses the remittance.
 *
 * Both are used repeatedly on one job. Freight arrives in instalments — steel from
 * the fabricator, mats from Resilite a fortnight later, a therapeutic vendor whenever
 * they answer — and each instalment is billed when it lands rather than held until
 * the last one arrives. Holding them means the customer is invoiced weeks after the
 * equipment ships and Summit floats the freight in the meantime.
 *
 * Pure body builders, no HTTP — so the amended line set can be asserted against an
 * expected total before anything is sent, exactly as the estimate and invoice
 * builders already are.
 */

/** One freight row per bucket, so QuickBooks reporting keeps them apart. */
export type FreightAmounts = Record<FreightBucket, bigint>;

export function emptyFreightAmounts(): FreightAmounts {
  return { STEEL: 0n, MATS: 0n, THERAPEUTIC: 0n, OTHER: 0n };
}

/**
 * Bucket → QuickBooks item class.
 *
 * The item ids configured for the old three-bucket names are reused deliberately:
 * the money is the same money going to the same income account, and renaming a
 * bucket in this application is no reason to make an accountant reconfigure
 * QuickBooks. Only the row's description changed.
 */
const KIND: Record<FreightBucket, { kind: ChargeKind; label: string }> = {
  STEEL: { kind: 'FREIGHT_STRUCTURE', label: 'Steel freight' },
  MATS: { kind: 'FREIGHT_MATS', label: 'Mats & padding freight' },
  THERAPEUTIC: {
    kind: 'FREIGHT_THIRD_PARTY',
    label: 'Therapeutic equipment & accessories freight',
  },
  OTHER: { kind: 'FREIGHT_STANDARD', label: 'Other freight' },
};

export function freightTotal(a: FreightAmounts): bigint {
  return FREIGHT_BUCKETS.reduce((sum, b) => sum + (a[b] ?? 0n), 0n);
}

export interface FreightLineInput {
  amounts: FreightAmounts;
  /** Vendor quote reference, per bucket where one is known. */
  references?: Partial<Record<FreightBucket, string | null>>;
  /** What an OTHER charge is for. Prints on the row, because "other" explains nothing. */
  descriptions?: Partial<Record<FreightBucket, string | null>>;
}

/**
 * The freight rows themselves.
 *
 * Each row carries its own evidence in the description — the vendor's quote number,
 * and for other freight what it was for. An invoice line that appeared weeks after
 * the document was issued has to explain itself on the document, not only in this
 * application's audit log, because the person querying it is the customer's
 * bookkeeper and they cannot see the audit log.
 */
export function buildFreightLines(input: FreightLineInput): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  for (const bucket of FREIGHT_BUCKETS) {
    const amount = input.amounts[bucket] ?? 0n;
    if (amount === 0n) continue;
    const { kind, label } = KIND[bucket];
    const what = String(input.descriptions?.[bucket] ?? '').trim();
    const ref = String(input.references?.[bucket] ?? '').trim();
    const description = [label, what || null, ref ? `vendor quote ${ref}` : null]
      .filter(Boolean)
      .join(' — ');
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: minorToQboAmount(amount),
      Description: description,
      SalesItemLineDetail: chargeDetail(kind),
    });
  }
  return lines;
}

export interface AmendInput extends FreightLineInput {
  /** The invoice as QuickBooks currently holds it. */
  invoice: {
    Id: string;
    SyncToken: string;
    Line?: Array<Record<string, unknown>>;
    CustomerMemo?: { value?: string };
  };
  /** Total the amended document must come to; asserted before it is sent. */
  expectedTotalMinor: bigint;
  currency: string;
  /** Appended to the memo so the document says why it changed. */
  memoNote?: string | null;
}

/**
 * Sparse update that appends freight to an existing invoice.
 *
 * QuickBooks replaces the whole `Line` array on update — there is no "add a line"
 * call — so every existing line is passed back verbatim, with its own `Id`, and the
 * freight rows are appended. Dropping a line here would silently delete it from the
 * customer's invoice, so the existing set is never rebuilt or re-derived: it is the
 * array QuickBooks just handed us.
 *
 * This runs more than once per job. The second amendment appends to a line array that
 * already contains the first one's freight row, which is exactly right — two
 * shipments, two rows, two quote references on the customer's document.
 */
export function buildInvoiceFreightAmendment(input: AmendInput): Record<string, unknown> {
  const existing = Array.isArray(input.invoice.Line) ? input.invoice.Line : [];
  if (!existing.length) {
    throw new Error(
      'QuickBooks returned an invoice with no lines. Refusing to update it — that would empty the customer’s invoice.',
    );
  }
  const freight = buildFreightLines(input);
  if (!freight.length) throw new Error('No freight amount to add');

  const lines = [...existing, ...freight];
  assertAssembledTotal('Invoice', sumLineAmounts(lines), input.expectedTotalMinor, [
    [`${existing.length} existing lines`, sumLineAmounts(existing)],
    ['freight added', freightTotal(input.amounts)],
  ]);

  const note = String(input.memoNote ?? '').trim();
  const memo = [String(input.invoice.CustomerMemo?.value ?? '').trim(), note]
    .filter(Boolean)
    .join('  ·  ');

  return {
    Id: input.invoice.Id,
    SyncToken: input.invoice.SyncToken,
    // sparse:true keeps every field we are not sending — terms, dates, custom
    // fields, the billing email — exactly as QuickBooks has them.
    sparse: true,
    Line: lines,
    ...(memo ? { CustomerMemo: { value: memo } } : {}),
  };
}

export interface FreightInvoiceInput extends FreightLineInput {
  customerQboId: string;
  currency: string;
  docNumber?: string;
  billEmail?: string | null;
  txnDate?: string | null;
  dueDate?: string | null;
  salesTermId?: string | null;
  /** Proposal number + what this document is for. */
  memo: string;
  projectId?: string | null;
  projectFieldId?: string | null;
}

/**
 * A freight-only invoice, raised alongside an invoice that has already taken payment.
 * It states what it is and which document it follows, so nobody in accounting has to
 * work out why a second — or third — invoice exists for one job.
 */
export function buildFreightInvoiceBody(input: FreightInvoiceInput): Record<string, unknown> {
  const lines = buildFreightLines(input);
  if (!lines.length) throw new Error('No freight amount to invoice');
  const total = freightTotal(input.amounts);
  assertAssembledTotal('Invoice', sumLineAmounts(lines), total, [['freight', total]]);

  const customField = projectCustomField(input.projectId, input.projectFieldId);
  return {
    CustomerRef: { value: input.customerQboId },
    CurrencyRef: { value: input.currency },
    ...(customField.length ? { CustomField: customField } : {}),
    ...(input.docNumber ? { DocNumber: input.docNumber } : {}),
    ...(input.billEmail ? { BillEmail: { Address: input.billEmail } } : {}),
    ...(input.txnDate ? { TxnDate: input.txnDate } : {}),
    ...(input.dueDate ? { DueDate: input.dueDate } : {}),
    ...(input.salesTermId ? { SalesTermRef: { value: input.salesTermId } } : {}),
    CustomerMemo: {
      value: `${input.memo}  ·  Freight quoted after the original invoice was issued. Total ${formatMinor(
        total,
        input.currency,
      )}.`,
    },
    Line: lines,
  };
}

/**
 * The document number for the nth freight invoice on a job.
 *
 * The first is `P-2026-0117-FRT`, matching what SSG already has in QuickBooks from
 * before freight could arrive in instalments. Subsequent ones are numbered, because
 * QuickBooks rejects a duplicate DocNumber and a job can genuinely need three.
 */
export function supplementDocNumber(proposalNumber: string, sequence: number): string {
  return sequence <= 1 ? `${proposalNumber}-FRT` : `${proposalNumber}-FRT${sequence}`;
}
