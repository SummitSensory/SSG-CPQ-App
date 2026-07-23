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

export interface CustomerSource {
  displayName: string;
  email?: string | null;
  billing?: { line1: string; line2?: string | null; city: string; region: string; postalCode: string; country: string } | null;
  shipping?: { line1: string; line2?: string | null; city: string; region: string; postalCode: string; country: string } | null;
}

/** Build a QuickBooks Customer create body from CPQ organization data. */
export function toQboCustomer(src: CustomerSource): Record<string, unknown> {
  const body: Record<string, unknown> = { DisplayName: src.displayName };
  if (src.email) body.PrimaryEmailAddr = { Address: src.email };
  if (src.billing) {
    body.BillAddr = {
      Line1: src.billing.line1, Line2: src.billing.line2 ?? undefined,
      City: src.billing.city, CountrySubDivisionCode: src.billing.region,
      PostalCode: src.billing.postalCode, Country: src.billing.country,
    };
  }
  if (src.shipping) {
    body.ShipAddr = {
      Line1: src.shipping.line1, Line2: src.shipping.line2 ?? undefined,
      City: src.shipping.city, CountrySubDivisionCode: src.shipping.region,
      PostalCode: src.shipping.postalCode, Country: src.shipping.country,
    };
  }
  return body;
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

/** A single frozen line from the accepted proposal, in minor units. */
export interface AcceptedLine {
  description: string;
  qboItemId?: string | null;
  quantity: number;
  amountMinor: bigint;
}

/** Build QuickBooks estimate/invoice SalesItemLineDetail lines. */
export function toSalesLines(lines: AcceptedLine[]): Array<Record<string, unknown>> {
  return lines.map((l) => ({
    DetailType: 'SalesItemLineDetail',
    Amount: minorToQboAmount(l.amountMinor),
    Description: l.description,
    SalesItemLineDetail: {
      Qty: l.quantity,
      ...(l.qboItemId ? { ItemRef: { value: l.qboItemId } } : {}),
    },
  }));
}

export const TXN_LABEL: Record<QboTxnType, string> = {
  ESTIMATE: 'Estimate',
  DEPOSIT_INVOICE: 'Deposit invoice',
  PROGRESS_INVOICE: 'Progress invoice',
  FINAL_INVOICE: 'Final invoice',
};
