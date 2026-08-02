import type { QboTxnType } from '@prisma/client';

/**
 * Field mapping helpers CPQ ⇄ QuickBooks Online. Money crosses the boundary as
 * a 2-decimal number built from integer minor units — the only place a decimal
 * representation is produced, and never via float arithmetic on stored values.
 */

/** Convert integer minor units (bigint) to a QuickBooks decimal amount (2dp). */
export function minorToQboAmount(minor: bigint): number {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return Number(`${neg ? '-' : ''}${whole}.${frac}`);
}

/** Human money for header/subtotal text lines (not used for any arithmetic). */
export function formatMinor(minor: bigint, currency = 'USD'): string {
  const v = minorToQboAmount(minor);
  return v.toLocaleString('en-US', { style: 'currency', currency });
}

export interface AddressSource {
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface CustomerSource {
  displayName: string;
  /** Legal / trading name. Falls back to displayName. */
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  contactFirstName?: string | null;
  contactLastName?: string | null;
  contactTitle?: string | null;
  notes?: string | null;
  /** Tax-exempt organisations are marked not taxable in QuickBooks. */
  taxExempt?: boolean;
  taxExemptId?: string | null;
  billing?: AddressSource | null;
  shipping?: AddressSource | null;
}

/**
 * Street address as ONE line. QuickBooks renders Line1/Line2 on separate rows,
 * which puts a suite or unit on its own line ("1655 Shiloh Road" / "D"). SSG
 * wants the unit alongside the street, so line2 is appended to line1 instead of
 * being sent as Line2.
 */
function streetLine(a: AddressSource): string {
  const unit = (a.line2 ?? '').trim();
  return unit ? `${a.line1.trim()}, ${unit}` : a.line1.trim();
}

function toQboAddr(a: AddressSource): Record<string, unknown> {
  return {
    Line1: streetLine(a),
    City: a.city,
    CountrySubDivisionCode: a.region,
    PostalCode: a.postalCode,
    Country: a.country,
  };
}

/**
 * Build the shared QuickBooks Customer field set. Used for both create and
 * sparse update so a customer's profile converges on the CRM record rather than
 * staying as whatever it looked like the first time it was pushed.
 *
 * Billing and shipping fall back to each other: a single address on the CRM
 * record populates both, which is what SSG's data actually looks like.
 */
function customerFields(src: CustomerSource): Record<string, unknown> {
  const body: Record<string, unknown> = {
    DisplayName: src.displayName,
    CompanyName: src.companyName ?? src.displayName,
    PrintOnCheckName: src.companyName ?? src.displayName,
  };
  if (src.contactFirstName) body.GivenName = src.contactFirstName;
  if (src.contactLastName) body.FamilyName = src.contactLastName;
  if (src.contactTitle) body.Title = src.contactTitle;
  if (src.email) body.PrimaryEmailAddr = { Address: src.email };
  if (src.phone) body.PrimaryPhone = { FreeFormNumber: src.phone };

  const billing = src.billing ?? src.shipping ?? null;
  const shipping = src.shipping ?? src.billing ?? null;
  if (billing) body.BillAddr = toQboAddr(billing);
  if (shipping) body.ShipAddr = toQboAddr(shipping);

  // Tax-exempt customers must not be taxed by QuickBooks' own engine.
  if (src.taxExempt) body.Taxable = false;

  const notes = [
    src.notes?.trim() || null,
    src.taxExempt ? `Tax exempt${src.taxExemptId ? ` — ref ${src.taxExemptId}` : ''}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  if (notes) body.Notes = notes;

  return body;
}

/** Build a QuickBooks Customer create body from CPQ organization data. */
export function toQboCustomer(src: CustomerSource): Record<string, unknown> {
  return customerFields(src);
}

/**
 * Build a sparse QuickBooks Customer UPDATE body. Sparse means unlisted fields
 * are left alone, so this only ever fills in or corrects what CPQ knows about.
 */
export function toQboCustomerUpdate(
  src: CustomerSource,
  qboId: string,
  syncToken: string,
): Record<string, unknown> {
  return { ...customerFields(src), Id: qboId, SyncToken: syncToken, sparse: true };
}

export interface ItemSource {
  name: string;
  sku: string;
  kind: string; // ProductKind
  description?: string | null;
}

/**
 * Build a QuickBooks Item create body. SERVICE products map to Type 'Service';
 * everything physical maps to 'NonInventory' (SSG does not track QBO inventory
 * quantities — approved catalog-sync scope).
 */
export function toQboItem(src: ItemSource, incomeAccountRef: string): Record<string, unknown> {
  return {
    Name: src.name,
    Sku: src.sku,
    Type: src.kind === 'SERVICE' ? 'Service' : 'NonInventory',
    Description: src.description ?? undefined,
    IncomeAccountRef: { value: incomeAccountRef },
  };
}

/** Structural role of an accepted line, mirroring the proposal builder. */
export type AcceptedLineKind = 'PRODUCT' | 'GROUP' | 'SUBGROUP' | 'NOTE';

/** A single frozen line from the accepted proposal, in minor units. */
export interface AcceptedLine {
  description: string;
  qboItemId?: string | null;
  quantity: number;
  amountMinor: bigint;
  /** Defaults to PRODUCT. Non-product kinds become description-only rows. */
  kind?: AcceptedLineKind;
  /** GROUP only: shown as "(optional)" in the heading. */
  optional?: boolean;
}

/** A QuickBooks description-only row: text, no money, no effect on the total. */
function descriptionLine(text: string): Record<string, unknown> {
  return { DetailType: 'DescriptionOnly', Description: text };
}

/**
 * Build QuickBooks estimate/invoice lines, preserving the proposal's structure:
 * group headings, sub-headings, notes and per-group subtotals become
 * description-only rows so the document reads like the proposal the customer
 * accepted rather than one flat list. Only PRODUCT rows carry money.
 */
export function toSalesLines(
  lines: AcceptedLine[],
  opts: { currency?: string; groupSubtotals?: boolean } = {},
): Array<Record<string, unknown>> {
  const currency = opts.currency ?? 'USD';
  const withSubtotals = opts.groupSubtotals ?? true;
  const out: Array<Record<string, unknown>> = [];

  let openGroup: string | null = null;
  let groupSum = 0n;

  const closeGroup = () => {
    if (openGroup !== null && withSubtotals) {
      out.push(descriptionLine(`Subtotal — ${openGroup}: ${formatMinor(groupSum, currency)}`));
    }
    openGroup = null;
    groupSum = 0n;
  };

  for (const l of lines) {
    const kind = l.kind ?? 'PRODUCT';

    if (kind === 'GROUP') {
      closeGroup();
      const heading = l.description.trim().toUpperCase();
      out.push(descriptionLine(l.optional ? `${heading} (OPTIONAL)` : heading));
      openGroup = l.description.trim();
      groupSum = 0n;
      continue;
    }
    if (kind === 'SUBGROUP') {
      out.push(descriptionLine(`  ${l.description.trim()}`));
      continue;
    }
    if (kind === 'NOTE') {
      out.push(descriptionLine(l.description.trim()));
      continue;
    }

    if (openGroup !== null) groupSum += l.amountMinor;
    out.push({
      DetailType: 'SalesItemLineDetail',
      Amount: minorToQboAmount(l.amountMinor),
      Description: l.description,
      SalesItemLineDetail: {
        Qty: l.quantity,
        ...(l.qboItemId ? { ItemRef: { value: l.qboItemId } } : {}),
      },
    });
  }
  closeGroup();
  return out;
}

export const TXN_LABEL: Record<QboTxnType, string> = {
  ESTIMATE: 'Estimate',
  DEPOSIT_INVOICE: 'Deposit invoice',
  PROGRESS_INVOICE: 'Progress invoice',
  FINAL_INVOICE: 'Final invoice',
};
