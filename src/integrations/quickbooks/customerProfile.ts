import { prisma } from '../../lib/prisma.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { qboEnvironment } from '../../config/env.js';
import { query } from './client.js';
import { findLink } from './links.js';
import { loadCustomerSource } from './customers.js';
import type { QboEnvironment } from '@prisma/client';

/**
 * Side-by-side comparison of a customer as CPQ holds it and as QuickBooks holds
 * it.
 *
 * The push is one-directional and silent: `findOrCreateCustomer` sends the CRM
 * profile and moves on, so a misspelled name or a stale bill-to address is only
 * discovered when an invoice arrives at the wrong desk. This reads the live
 * QuickBooks customer and lines the two records up field by field so the
 * difference is visible before anything is billed.
 *
 * Read-only. Correcting a difference means fixing the CRM record and running
 * the existing customer sync — CPQ owns every field compared here
 * (`source-of-truth.ts`), so there is deliberately no "pull from QuickBooks"
 * direction to accidentally overwrite the CRM with an accountant's typo.
 */

export interface ProfileField {
  key: string;
  label: string;
  crm: string;
  qbo: string;
  /** Differs, and the difference is worth acting on. */
  differs: boolean;
  /** In CPQ, absent in QuickBooks — will be filled by the next sync. */
  missingInQbo: boolean;
  /** In neither. Surfaced because an empty bill-to is itself the problem. */
  empty: boolean;
}

interface QboAddress {
  Line1?: string;
  Line2?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
}

interface QboCustomerFull {
  Id: string;
  SyncToken: string;
  DisplayName?: string;
  CompanyName?: string;
  GivenName?: string;
  FamilyName?: string;
  Title?: string;
  Active?: boolean;
  Taxable?: boolean;
  ResaleNum?: string;
  Notes?: string;
  Balance?: number;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  BillAddr?: QboAddress;
  ShipAddr?: QboAddress;
  SalesTermRef?: { value?: string; name?: string };
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

const norm = (v: unknown): string =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** Case- and punctuation-insensitive equality: "Dr." vs "Dr" is not a finding. */
function sameish(a: string, b: string): boolean {
  const k = (s: string) => s.toLowerCase().replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim();
  return k(a) === k(b);
}

function oneLine(
  a:
    | {
        line1?: string | null;
        line2?: string | null;
        city?: string | null;
        region?: string | null;
        postalCode?: string | null;
        country?: string | null;
      }
    | null
    | undefined,
): string {
  if (!a) return '';
  return [
    [a.line1, a.line2].filter(Boolean).join(' '),
    a.city,
    [a.region, a.postalCode].filter(Boolean).join(' '),
    a.country && a.country !== 'US' ? a.country : '',
  ]
    .map(norm)
    .filter(Boolean)
    .join(', ');
}

function qboLine(a: QboAddress | undefined): string {
  if (!a) return '';
  return oneLine({
    line1: a.Line1,
    line2: a.Line2,
    city: a.City,
    region: a.CountrySubDivisionCode,
    postalCode: a.PostalCode,
    country: a.Country,
  });
}

function field(key: string, label: string, crm: string, qbo: string): ProfileField {
  const c = norm(crm);
  const q = norm(qbo);
  return {
    key,
    label,
    crm: c,
    qbo: q,
    differs: Boolean(c && q && !sameish(c, q)),
    missingInQbo: Boolean(c && !q),
    empty: !c && !q,
  };
}

export interface CustomerProfileComparison {
  organizationId: string;
  organizationName: string;
  environment: QboEnvironment;
  linked: boolean;
  qboCustomerId: string | null;
  qboActive: boolean | null;
  /** QuickBooks' running balance for the customer across all their invoices. */
  qboBalanceMinor: string | null;
  qboLastUpdatedAt: string | null;
  fields: ProfileField[];
  /** Count of fields where the two disagree — the number worth showing as a badge. */
  differenceCount: number;
  missingCount: number;
  /** Set when the CRM record itself is incomplete, regardless of QuickBooks. */
  warnings: string[];
}

export async function compareCustomerProfile(
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CustomerProfileComparison> {
  const environment = qboEnvironment() as QboEnvironment;
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true },
  });
  if (!org) throw new NotFoundError('Customer not found');

  const { src } = await loadCustomerSource(organizationId);
  const link = await findLink({ entity: 'Customer', entityId: organizationId });

  const warnings: string[] = [];
  if (!src.email)
    warnings.push(
      'No contact on this customer has an email address — QuickBooks cannot send them an invoice.',
    );
  if (!src.billing)
    warnings.push('No billing address on file. QuickBooks will show the invoice with no bill-to.');
  if (!src.shipping) warnings.push('No shipping address on file.');

  let qbo: QboCustomerFull | null = null;
  if (link) {
    const conn = await prisma.qboConnection.findFirst({ where: { environment, isActive: true } });
    if (!conn) throw new ConflictError(`No active QuickBooks connection for ${environment}`);
    const res = await query<{ Customer?: QboCustomerFull[] }>(
      conn.realmId,
      `select * from Customer where Id = '${link.qboId.replace(/'/g, "\\'")}'`,
      fetchImpl,
    );
    qbo = res.Customer?.[0] ?? null;
    if (!qbo) {
      warnings.push(
        `This customer is linked to QuickBooks id ${link.qboId}, but no customer with that id exists there any more.`,
      );
    }
  }

  const contactName = [src.contactFirstName, src.contactLastName].filter(Boolean).join(' ');
  const qboContactName = [qbo?.GivenName, qbo?.FamilyName].filter(Boolean).join(' ');

  const fields: ProfileField[] = [
    field('displayName', 'Customer name', src.displayName, qbo?.DisplayName ?? ''),
    field('companyName', 'Company name', src.companyName ?? '', qbo?.CompanyName ?? ''),
    field('email', 'Invoice email', src.email ?? '', qbo?.PrimaryEmailAddr?.Address ?? ''),
    field('phone', 'Phone', src.phone ?? '', qbo?.PrimaryPhone?.FreeFormNumber ?? ''),
    field('contact', 'Primary contact', contactName, qboContactName),
    field('contactTitle', 'Contact title', src.contactTitle ?? '', qbo?.Title ?? ''),
    field('billing', 'Bill to', oneLine(src.billing), qboLine(qbo?.BillAddr)),
    field('shipping', 'Ship to', oneLine(src.shipping), qboLine(qbo?.ShipAddr)),
    field(
      'taxExempt',
      'Tax status',
      src.taxExempt ? 'Exempt' : 'Taxable',
      qbo ? (qbo.Taxable === false ? 'Exempt' : 'Taxable') : '',
    ),
    field('taxExemptId', 'Exemption / resale no.', src.taxExemptId ?? '', qbo?.ResaleNum ?? ''),
  ];

  return {
    organizationId: org.id,
    organizationName: org.name,
    environment,
    linked: Boolean(link && qbo),
    qboCustomerId: link?.qboId ?? null,
    qboActive: qbo ? (qbo.Active ?? null) : null,
    qboBalanceMinor:
      qbo && qbo.Balance != null ? BigInt(Math.round(Number(qbo.Balance) * 100)).toString() : null,
    qboLastUpdatedAt: qbo?.MetaData?.LastUpdatedTime ?? null,
    fields,
    differenceCount: fields.filter((f) => f.differs).length,
    missingCount: fields.filter((f) => f.missingInQbo).length,
    warnings,
  };
}
