/**
 * Source-of-truth registry for the QuickBooks Online integration. CPQ is the
 * system of record for everything that determines WHAT is owed (proposal,
 * pricing, totals, customer identity). QuickBooks is the system of record for
 * the accounting lifecycle AFTER a document exists (its id/doc number, payment
 * status, and outstanding balance). The engine consults this before writing in
 * either direction so an authoritative value is never silently overwritten.
 */
export type SourceOfTruth = 'CPQ' | 'QBO';

export interface FieldSot {
  field: string;
  owner: SourceOfTruth;
  /** Direction data flows for this field. */
  sync: 'CPQ_TO_QBO' | 'QBO_TO_CPQ' | 'NONE';
  note: string;
}

export const QBO_SOURCE_OF_TRUTH: FieldSot[] = [
  // --- CPQ-authoritative (pushed to QuickBooks, never read back) ---
  { field: 'customer.displayName', owner: 'CPQ', sync: 'CPQ_TO_QBO', note: 'Organization name; QBO customer created/matched from it.' },
  { field: 'customer.billingAddress', owner: 'CPQ', sync: 'CPQ_TO_QBO', note: 'From CRM billing address.' },
  { field: 'customer.shippingAddress', owner: 'CPQ', sync: 'CPQ_TO_QBO', note: 'From CRM shipping address.' },
  { field: 'customer.email', owner: 'CPQ', sync: 'CPQ_TO_QBO', note: 'Primary contact email.' },
  { field: 'item.name', owner: 'CPQ', sync: 'CPQ_TO_QBO', note: 'Product/service name (approved catalog sync only).' },
  { field: 'item.sku', owner: 'CPQ', sync: 'CPQ_TO_QBO', note: 'Product SKU maps to QBO Item Sku.' },
  { field: 'estimate.lines', owner: 'CPQ', sync: 'CPQ_TO_QBO', note: 'Line items come from the accepted proposal — frozen.' },
  { field: 'estimate.total', owner: 'CPQ', sync: 'CPQ_TO_QBO', note: 'Accepted proposal grand total — never altered.' },
  { field: 'invoice.amount', owner: 'CPQ', sync: 'CPQ_TO_QBO', note: 'Deposit/progress/final portion from the frozen payment schedule.' },
  { field: 'invoice.currency', owner: 'CPQ', sync: 'CPQ_TO_QBO', note: 'Proposal currency.' },

  // --- QuickBooks-authoritative (read back for reconciliation, never overwritten in CPQ money fields) ---
  { field: 'transaction.qboId', owner: 'QBO', sync: 'QBO_TO_CPQ', note: 'QuickBooks-assigned object id; stored on QboTransaction.' },
  { field: 'transaction.docNumber', owner: 'QBO', sync: 'QBO_TO_CPQ', note: 'QuickBooks document number.' },
  { field: 'invoice.paymentStatus', owner: 'QBO', sync: 'QBO_TO_CPQ', note: 'Paid / partially paid / open — reconciliation display only.' },
  { field: 'invoice.balance', owner: 'QBO', sync: 'QBO_TO_CPQ', note: 'Outstanding balance — reconciliation display only.' },
  { field: 'customer.qboId', owner: 'QBO', sync: 'QBO_TO_CPQ', note: 'QuickBooks customer id; stored on QboEntityLink.' },
];

const BY_FIELD = new Map(QBO_SOURCE_OF_TRUTH.map((f) => [f.field, f]));

export function sourceOfTruth(field: string): SourceOfTruth | undefined {
  return BY_FIELD.get(field)?.owner;
}

/**
 * Guard: may an inbound value from QuickBooks be written into this CPQ field?
 * Only fields explicitly QBO-authoritative and marked QBO_TO_CPQ are writable.
 * Any financial/proposal field (CPQ-authoritative) is refused — this is what
 * guarantees accepted totals are never silently altered from QuickBooks.
 */
export function canWriteFromQbo(field: string): boolean {
  const f = BY_FIELD.get(field);
  return Boolean(f && f.owner === 'QBO' && f.sync === 'QBO_TO_CPQ');
}
