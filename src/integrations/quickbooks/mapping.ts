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
 * Per-unit rate implied by an extended amount. Used only to render a component
 * row's "4 × $221.13" text — never for arithmetic that has to balance, since an
 * amount that does not divide evenly by its quantity would not round-trip. The
 * extended amount is always shown verbatim beside it.
 */
function unitRateText(amountMinor: bigint, quantity: number, currency: string): string {
  const qty = Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1;
  if (qty === 1) return formatMinor(amountMinor, currency);
  const per = amountMinor / BigInt(qty);
  return `${qty} × ${formatMinor(per, currency)} = ${formatMinor(amountMinor, currency)}`;
}

/**
 * A component row inside a bundled group: the product text plus its quantity and
 * rate, carrying no Amount. Mirrors how QuickBooks prints bundle components
 * (QTY and RATE shown, AMOUNT blank) without requiring a QuickBooks Bundle to
 * exist and be maintained by hand for every configuration.
 */
function componentLine(l: AcceptedLine, currency: string): Record<string, unknown> {
  return descriptionLine(
    `    ${l.description.trim()}  —  ${unitRateText(l.amountMinor, l.quantity, currency)}`,
  );
}

/**
 * Build QuickBooks estimate/invoice lines, preserving the proposal's structure:
 * group headings, sub-headings, notes and per-group subtotals become
 * description-only rows so the document reads like the proposal the customer
 * accepted rather than one flat list. Only PRODUCT rows carry money.
 */
export function toSalesLines(
  lines: AcceptedLine[],
  opts: { currency?: string; groupSubtotals?: boolean; bundleGroups?: boolean } = {},
): Array<Record<string, unknown>> {
  const currency = opts.currency ?? 'USD';
  const bundled = opts.bundleGroups ?? false;
  // A bundled group states its total on the parent line, so a trailing subtotal
  // row would print the same number twice.
  const withSubtotals = bundled ? false : (opts.groupSubtotals ?? true);
  const out: Array<Record<string, unknown>> = [];

  let openGroup: string | null = null;
  let openGroupOptional = false;
  let openGroupItemId: string | null = null;
  let groupSum = 0n;
  /*
   * Bundled mode buffers a group's rows: the parent priced line cannot be
   * written until every component is known, because its Amount IS their sum.
   */
  let buffer: Array<Record<string, unknown>> = [];

  const headingText = (name: string, optional: boolean) => {
    const h = name.trim().toUpperCase();
    return optional ? `${h} (OPTIONAL)` : h;
  };

  const closeGroup = () => {
    if (openGroup === null) {
      buffer = [];
      return;
    }
    if (bundled) {
      // Parent carries the money; components print beneath it as text. The sum
      // is exact by construction — components carry no Amount at all.
      out.push({
        DetailType: 'SalesItemLineDetail',
        Amount: minorToQboAmount(groupSum),
        Description: headingText(openGroup, openGroupOptional),
        SalesItemLineDetail: {
          Qty: 1,
          ...(openGroupItemId ? { ItemRef: { value: openGroupItemId } } : {}),
        },
      });
      out.push(...buffer);
    } else if (withSubtotals) {
      out.push(descriptionLine(`Subtotal — ${openGroup}: ${formatMinor(groupSum, currency)}`));
    }
    buffer = [];
    openGroup = null;
    openGroupOptional = false;
    openGroupItemId = null;
    groupSum = 0n;
  };

  for (const l of lines) {
    const kind = l.kind ?? 'PRODUCT';

    if (kind === 'GROUP') {
      closeGroup();
      openGroup = l.description.trim();
      openGroupOptional = Boolean(l.optional);
      openGroupItemId = l.qboItemId ?? null;
      groupSum = 0n;
      // Unbundled: the heading is its own description row, emitted now.
      // Bundled: the heading becomes the parent priced line, written on close.
      if (!bundled) out.push(descriptionLine(headingText(openGroup, openGroupOptional)));
      continue;
    }

    if (kind === 'SUBGROUP') {
      const row = descriptionLine(`  ${l.description.trim()}`);
      if (bundled && openGroup !== null) buffer.push(row);
      else out.push(row);
      continue;
    }

    if (kind === 'NOTE') {
      const row = descriptionLine(l.description.trim());
      if (bundled && openGroup !== null) buffer.push(row);
      else out.push(row);
      continue;
    }

    if (openGroup !== null) {
      groupSum += l.amountMinor;
      if (bundled) {
        buffer.push(componentLine(l, currency));
        continue;
      }
    }

    // Ungrouped product, or unbundled mode: an ordinary priced line.
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
  INVOICE: 'Invoice',
  DEPOSIT_INVOICE: 'Deposit invoice',
  PROGRESS_INVOICE: 'Progress invoice',
  FINAL_INVOICE: 'Final invoice',
};
