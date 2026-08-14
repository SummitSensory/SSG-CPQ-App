import {
  minorToQboAmount,
  formatMinor,
  assertAssembledTotal,
  projectCustomField,
} from './mapping.js';
import { sumLineAmounts } from './estimates.js';
import { chargeDetail, type ChargeKind } from './chargeItems.js';

/**
 * QuickBooks bodies for freight that arrives after the invoice.
 *
 * Two shapes, because an invoice stops being freely editable the moment money is
 * applied to it:
 *
 *   AMEND      — the freight rows are appended to the existing invoice and its
 *                total goes up. Correct while nothing has been paid: the customer
 *                receives one document for the job, which is how SSG bills.
 *   SUPPLEMENT — a separate freight-only invoice. Used once a payment exists,
 *                because raising the total of an invoice a customer has partly
 *                paid rewrites history in the ledger and confuses the remittance.
 *
 * Pure body builders, no HTTP — so the amended line set can be asserted against an
 * expected total before anything is sent, exactly as the estimate and invoice
 * builders already are.
 */

/** One freight row per class, so QuickBooks reporting keeps them apart. */
export interface FreightAmounts {
  thirdPartyMinor: bigint;
  structureMinor: bigint;
  standardMinor: bigint;
}

const KIND: Array<[keyof FreightAmounts, ChargeKind, string]> = [
  ['thirdPartyMinor', 'FREIGHT_THIRD_PARTY', 'Third-party freight'],
  ['structureMinor', 'FREIGHT_STRUCTURE', 'Structure freight'],
  ['standardMinor', 'FREIGHT_STANDARD', 'Standard freight'],
];

export function freightTotal(a: FreightAmounts): bigint {
  return a.thirdPartyMinor + a.structureMinor + a.standardMinor;
}

/**
 * The freight rows themselves.
 *
 * `reference` prints on every row — the vendor's quote number. An invoice line that
 * appeared weeks after the document was issued has to explain itself on the
 * document, not only in this application's audit log.
 */
export function buildFreightLines(
  amounts: FreightAmounts,
  reference?: string | null,
): Array<Record<string, unknown>> {
  const ref = String(reference ?? '').trim();
  const lines: Array<Record<string, unknown>> = [];
  for (const [key, kind, label] of KIND) {
    const amount = amounts[key];
    if (amount === 0n) continue;
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: minorToQboAmount(amount),
      Description: ref ? `${label} — vendor quote ${ref}` : label,
      SalesItemLineDetail: chargeDetail(kind),
    });
  }
  return lines;
}

export interface AmendInput {
  /** The invoice as QuickBooks currently holds it. */
  invoice: {
    Id: string;
    SyncToken: string;
    Line?: Array<Record<string, unknown>>;
    CustomerMemo?: { value?: string };
  };
  amounts: FreightAmounts;
  reference?: string | null;
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
 */
export function buildInvoiceFreightAmendment(input: AmendInput): Record<string, unknown> {
  const existing = Array.isArray(input.invoice.Line) ? input.invoice.Line : [];
  if (!existing.length) {
    throw new Error(
      'QuickBooks returned an invoice with no lines. Refusing to update it — that would empty the customer’s invoice.',
    );
  }
  const freight = buildFreightLines(input.amounts, input.reference);
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

export interface FreightInvoiceInput {
  customerQboId: string;
  currency: string;
  docNumber?: string;
  billEmail?: string | null;
  txnDate?: string | null;
  dueDate?: string | null;
  salesTermId?: string | null;
  amounts: FreightAmounts;
  reference?: string | null;
  /** Proposal number + what this document is for. */
  memo: string;
  projectId?: string | null;
  projectFieldId?: string | null;
}

/**
 * A freight-only invoice, raised alongside an invoice that has already taken
 * payment. It states what it is and which document it follows, so nobody in
 * accounting has to work out why a second invoice exists for one job.
 */
export function buildFreightInvoiceBody(input: FreightInvoiceInput): Record<string, unknown> {
  const lines = buildFreightLines(input.amounts, input.reference);
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
      value: `${input.memo}  ·  Freight charges quoted after the original invoice was issued${
        input.reference ? ` (vendor quote ${input.reference})` : ''
      }. Total ${formatMinor(total, input.currency)}.`,
    },
    Line: lines,
  };
}
