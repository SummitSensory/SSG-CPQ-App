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
  /**
   * The line's own detail text, without the product name. QuickBooks already
   * prints the linked item's name, so sending `name — detail` as the
   * description printed the name twice on every line.
   */
  detail?: string | null;
  qboItemId?: string | null;
  /** Part number as it appears on the proposal line. Carried so the QuickBooks
   *  create can be blocked by name when it does not map to an item. */
  sku?: string | null;
  /** CPQ Product id, where the line has one (generated lines do not). */
  productId?: string | null;
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
 * A native QuickBooks subtotal: totals every line since the previous subtotal.
 *
 * No Amount is sent. QuickBooks computes it, and supplying one would both risk
 * disagreeing with the lines above and be counted twice by sumLineAmounts().
 */
function subtotalLine(): Record<string, unknown> {
  return { DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} };
}

/**
 * Qty and unit price for a priced row.
 *
 * Proposal amounts are built as rate × quantity, so they divide evenly in almost
 * every case and the invoice can show the same three columns the proposal does.
 * Where they do not — a hand-typed extended amount, a rounded allocation — the row
 * collapses to a single unit at the full amount rather than printing a rate that
 * does not multiply up. A customer checking the arithmetic must never find a row
 * where qty × rate ≠ amount.
 *
 * NEGATIVE quantities are carried through as written. A discount line is entered
 * on the proposal as quantity -1 at a POSITIVE unit price, and an earlier
 * `quantity > 0` guard sent those to QuickBooks as quantity 1 at a negative unit
 * price. The extended amount came out the same, so the document total was never
 * wrong — but the row printed inverted from the proposal the customer accepted,
 * and a rep reading the two side by side could not reconcile them. The sign now
 * lives on the quantity, where the proposal put it. Divisibility is tested on the
 * magnitude, since BigInt remainders take the sign of the dividend.
 */
function pricedDetail(l: AcceptedLine): Record<string, unknown> {
  const qty = Number.isFinite(l.quantity) && l.quantity !== 0 ? Math.round(l.quantity) : 1;
  if (qty === 0) return { Qty: 1, UnitPrice: minorToQboAmount(l.amountMinor) };
  const q = BigInt(qty);
  const absQ = q < 0n ? -q : q;
  const absAmt = l.amountMinor < 0n ? -l.amountMinor : l.amountMinor;
  // An amount that does not divide evenly collapses to one unit at the full
  // amount, as before. |qty| = 1 divides trivially, so the -1 discount row keeps
  // its sign and prints at the positive rate the proposal shows.
  if (absAmt % absQ !== 0n) return { Qty: 1, UnitPrice: minorToQboAmount(l.amountMinor) };
  return { Qty: qty, UnitPrice: minorToQboAmount(l.amountMinor / q) };
}

/**
 * The description printed under a product line.
 *
 * QuickBooks prints the linked item's NAME on the line and its SKU in the SKU
 * column, both read off the ItemRef. Sending the proposal's own `name — detail`
 * string as the description therefore printed the name a second time, directly
 * below itself, on every line. So the description carries the line's detail text
 * and nothing else — the second line of the invoice's activity row.
 *
 * A line with no ItemRef has no item name to lean on, so it keeps its full
 * description — otherwise it would print as a bare amount.
 */
function productDescription(l: AcceptedLine): string | undefined {
  if (!l.qboItemId) return l.description;
  const detail = (l.detail ?? '').trim();
  return detail || undefined;
}

/**
 * Build QuickBooks estimate/invoice lines from the accepted proposal.
 *
 * EVERY product is a real priced line — its own ItemRef, Qty, Rate and Amount — so
 * it reaches Sales by Product/Service, can be credited on its own, and taxes
 * correctly. The proposal's structure is drawn with QuickBooks' own structural
 * line types rather than faked: section headings are DescriptionOnly rows and each
 * section closes with SubTotalLineDetail.
 *
 * This replaced an earlier "bundle" mode that emitted one priced parent per section
 * with its parts as indented DescriptionOnly text. That printed the same number of
 * rows while carrying none of the data: no ItemRef, no Amount, invisible to every
 * report, impossible to credit individually.
 *
 * QuickBooks Bundles (items of Type "Group") are deliberately NOT used, even where
 * one exists for a kit we sell. A Bundle's composition lives on the item, not on
 * the transaction: QuickBooks always expands it to every component at the
 * quantities in its definition, and silently ignores any attempt to send a
 * modified component list. A proposal that drops a part or changes a count would
 * therefore invoice for the unmodified kit — a real overcharge, with no API error
 * to catch it. Since every component already gets its own priced line here, the
 * only thing a Bundle would add is the indent, and it would cost correctness to
 * get it.
 */
export function toSalesLines(
  lines: AcceptedLine[],
  opts: { currency?: string; groupSubtotals?: boolean } = {},
): Array<Record<string, unknown>> {
  const withSubtotals = opts.groupSubtotals ?? true;
  const out: Array<Record<string, unknown>> = [];

  let openGroup: string | null = null;
  let sectionHasLines = false;

  const headingText = (name: string, optional: boolean) => {
    const h = name.trim().toUpperCase();
    return optional ? `${h} (OPTIONAL)` : h;
  };

  const closeSection = () => {
    // A heading with nothing under it gets no subtotal — an empty optional section
    // would otherwise print a bare "0.00".
    if (openGroup !== null && withSubtotals && sectionHasLines) out.push(subtotalLine());
    openGroup = null;
    sectionHasLines = false;
  };

  for (const l of lines) {
    const kind = l.kind ?? 'PRODUCT';

    if (kind === 'GROUP') {
      closeSection();
      openGroup = l.description.trim();
      out.push(descriptionLine(headingText(openGroup, Boolean(l.optional))));
      continue;
    }

    if (kind === 'SUBGROUP') {
      // Sub-headings are dropped. On the printed QuickBooks document they read as
      // unpriced rows interleaved with the priced ones, which made the invoice
      // hard to follow. The group heading and its subtotal carry the structure.
      continue;
    }

    if (kind === 'NOTE') {
      out.push(descriptionLine(l.description.trim()));
      continue;
    }

    if (openGroup !== null) sectionHasLines = true;

    const desc = productDescription(l);
    out.push({
      DetailType: 'SalesItemLineDetail',
      Amount: minorToQboAmount(l.amountMinor),
      ...(desc ? { Description: desc } : {}),
      SalesItemLineDetail: {
        ...pricedDetail(l),
        ...(l.qboItemId ? { ItemRef: { value: l.qboItemId } } : {}),
      },
    });
  }
  closeSection();
  return out;
}

/**
 * The document's Project ID custom field.
 *
 * QuickBooks prints custom fields in the header block — the PROJECT ID slot on
 * SSG's invoice style. They are POSITIONAL: QuickBooks matches on DefinitionId,
 * the slot number, not on the name, so the caller resolves the slot first (see
 * customFields.ts) and passes it in. With no slot or no project id, nothing is
 * sent and the field simply does not print.
 */
export function projectCustomField(
  projectId?: string | null,
  definitionId?: string | null,
): Array<Record<string, unknown>> {
  const value = String(projectId ?? '').trim();
  const slot = String(definitionId ?? '').trim();
  if (!value || !slot) return [];
  return [{ DefinitionId: slot, Name: 'Project ID', Type: 'StringType', StringValue: value }];
}

export const TXN_LABEL: Record<QboTxnType, string> = {
  ESTIMATE: 'Estimate',
  INVOICE: 'Invoice',
  DEPOSIT_INVOICE: 'Deposit invoice',
  PROGRESS_INVOICE: 'Progress invoice',
  FINAL_INVOICE: 'Final invoice',
};
