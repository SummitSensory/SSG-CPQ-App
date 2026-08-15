/**
 * Mapping from the monday CRM boards to CPQ entities.
 *
 * Column ids are per-board and opaque, so these were read off the live boards
 * via /integrations/monday/boards/:id rather than assumed. Renaming a column
 * in monday keeps its id; DELETING and re-adding one changes it and this file
 * must be updated.
 *
 *   Deal Tracking  board 6527740233  (~2,334 items)  <- the mapping sheet
 *   Organizations  board 6527740311  (~2,862 items)
 *   Contacts       board 6527740281  (~2,798 items)
 *
 * "Monday Column Mapping.xlsx" describes the DEAL TRACKING board: Industry,
 * Full Name / Email / Direct Phone, the split address columns, Country and
 * Project ID all live there, on the deal row. That board is therefore the
 * primary import source — each row carries its own customer, address and
 * primary contact, so nothing depends on the Contacts board's account links.
 */

import type { CustomerType, OpportunityStage } from '@prisma/client';

export const DEALS_BOARD_ID = '6527740233';
export const ORGANIZATIONS_BOARD_ID = '6527740311';
export const CONTACTS_BOARD_ID = '6527740281';

/** Deal Tracking columns — the ids listed in Monday Column Mapping.xlsx. */
export const DEAL_COL = {
  /**
   * Freight, quoted as two separate figures because they ship as two separate
   * loads: the steel structure on one truck, the mats on another. A vendor's Bill
   * of Materials takes whichever belongs to it — see Manufacturer.bomFreightSource.
   */
  structureFreight: 'lookup5__1',
  matsFreight: 'text_mkzdpjf2',
  /** text — estimated tax on the deal. One figure for the order, not per vendor. */
  estimatedTax: 'text_mkzd8x9t',
  /** mirror (from Organizations) — see INDUSTRY_TO_CUSTOMER_TYPE */
  industry: 'lookup3__1',
  /** status — Type of Customer, a cross-check on industry */
  customerTypeLabel: 'status5__1',
  /** text — primary contact full name */
  contactName: 'text9__1',
  /** text — primary contact job title */
  contactTitle: 'text_mkpnvbkn',
  /** email */
  contactEmail: 'email_1__1',
  /** phone — direct phone number */
  contactPhone: 'phone__1',
  /** location — full location address (Places blob); fallback only */
  location: 'location__1',
  /** formula — street address */
  street1: 'formula_mkpsy1b6',
  /** text — street address (typed, used when the formula is empty) */
  streetText: 'text_mkq249md',
  /** text — unit / suite */
  unit: 'text_mm1zssfw',
  /** formula — city; NOTE: often resolves to a COUNTY, so cityText and the
   *  location blob are preferred over it */
  city: 'formula_mkpsgx0y',
  /** text — city (typed) */
  cityText: 'text_mkq2tbvv',
  /** text — state */
  state: 'text_mkpzwfqz',
  /** text — zip code */
  zip: 'text__1',
  /** status — country */
  country: 'status47__1',
  /** item id column — Project ID */
  projectId: 'pulse_id_mm5kc9f8',
  /** status — Deal Phase */
  stage: 'deal_stage',
  /** numbers — Deal Value $ */
  value: 'deal_value',
  /** numbers — Grand Total */
  grandTotal: 'numbers1__1',
  /** text — website address */
  website: 'text_mkvy62bg',
  /** long_text — Customer - Project Summary */
  summary: 'long_text__1',
  /** board_relation -> Contacts */
  orgContacts: 'deal_contact',
} as const;

/** Organizations board columns (used by the legacy ?source=orgs path). */
export const ORG_COL = {
  /** link — company website */
  website: 'company_domain',
  /** status */
  industry: 'industry__1',
  /** long_text */
  description: 'company_description',
  /** location */
  location: 'location__1',
  /** text */
  zip: 'text__1',
  /** text — free-text address, usually empty */
  address: 'address_mkn89b4p',
  /** board_relation -> Contacts */
  contacts: 'account_contact',
} as const;

/** Contacts board columns. */
export const CONTACT_COL = {
  /** text — given name; the item name holds the full name */
  firstName: 'text_mkpnm9ns',
  /** email — text is the address */
  email: 'contact_email',
  /** phone */
  phone: 'contact_phone',
  /** dropdown — job title */
  title: 'title5',
  /** status — Primary / Support / Gatekeeper / Finance / Facilities / Therapy Provider / TBD */
  contactType: 'status__1',
  /** long_text */
  comments: 'long_text4',
  /** board_relation -> Organizations */
  account: 'contact_account',
} as const;

/**
 * The Industry column has accumulated 26 labels over time, including
 * duplicates and typos ("Hospital"/"Hosptial", "Non-Profit"/"Non Profit").
 * All of them are mapped; anything unrecognized falls back to OTHER rather
 * than failing the import, and is reported in the dry run's warnings.
 */
export const INDUSTRY_TO_CUSTOMER_TYPE: Record<string, CustomerType> = {
  'ABA Practice': 'PRIVATE_PRACTICE',
  'ABA Therapy Practice': 'PRIVATE_PRACTICE',
  'Therapy Clinic': 'PRIVATE_PRACTICE',
  'Multi-Disciplinary Therapy Practice': 'PRIVATE_PRACTICE',
  'Rehabilitation Facility': 'PRIVATE_PRACTICE',
  'Rehab Facility': 'PRIVATE_PRACTICE',
  'Orthotics / Prosthetics': 'PRIVATE_PRACTICE',
  'Orthotics/Prosthetics': 'PRIVATE_PRACTICE',
  Hospital: 'HOSPITAL',
  Hosptial: 'HOSPITAL',
  'Healthcare System': 'HEALTHCARE_SYSTEM',
  'K-12 School': 'SCHOOL',
  School: 'SCHOOL',
  Childcare: 'SCHOOL',
  'University/Colllege': 'UNIVERSITY',
  'University / College': 'UNIVERSITY',
  University: 'UNIVERSITY',
  'City / County': 'GOVERNMENT',
  Government: 'GOVERNMENT',
  'Non-Profit': 'NONPROFIT',
  'Non Profit': 'NONPROFIT',
  'Community Center': 'NONPROFIT',
  Church: 'NONPROFIT',
  Residential: 'OTHER',
  'Assisted Living/Memory Care': 'OTHER',
  'Indoor Gym': 'OTHER',
  'Indoor Sensory Gym': 'OTHER',
  Individual: 'OTHER',
  Consultant: 'OTHER',
  Other: 'OTHER',
  '-': 'OTHER',
};

/**
 * Mirror columns return every mirrored value comma-joined, so "ABA Practice"
 * can arrive as "ABA Practice, ABA Practice". Take the first distinct label.
 */
export function firstLabel(label: string | undefined | null): string | null {
  const parts = (label ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && p !== '-');
  return parts[0] ?? null;
}

export function toCustomerType(label: string | undefined | null): CustomerType {
  const first = firstLabel(label);
  if (!first) return 'OTHER';
  return INDUSTRY_TO_CUSTOMER_TYPE[first] ?? 'OTHER';
}

/** True when a label is present but not in the table — worth reporting. */
export function isUnmappedIndustry(label: string | undefined | null): boolean {
  const t = firstLabel(label);
  return !!t && !(t in INDUSTRY_TO_CUSTOMER_TYPE);
}

/**
 * Deal Phase is a free-form status column that changes as the sales process
 * changes, so it is matched on keywords rather than an exact label list.
 */
export function toStage(label: string | undefined | null): OpportunityStage {
  const t = (label ?? '').trim().toLowerCase();
  if (!t) return 'PROSPECT';
  if (t.includes('won') || t.includes('closed won') || t.includes('order')) return 'CLOSED_WON';
  if (t.includes('lost') || t.includes('dead') || t.includes('no ')) return 'CLOSED_LOST';
  if (t.includes('negotiat')) return 'NEGOTIATION';
  if (t.includes('proposal') || t.includes('quote') || t.includes('estimate')) return 'PROPOSAL';
  if (
    t.includes('discovery') ||
    t.includes('consult') ||
    t.includes('needs') ||
    t.includes('design')
  )
    return 'NEEDS_ANALYSIS';
  if (t.includes('qualif') || t.includes('contact') || t.includes('follow')) return 'QUALIFICATION';
  return 'PROSPECT';
}

/** Contact Type labels that mean "this person decides". */
const DECISION_MAKER_TYPES = new Set(['Primary', 'Finance']);

export function isDecisionMaker(contactTypeLabel: string | undefined | null): boolean {
  return DECISION_MAKER_TYPES.has((contactTypeLabel ?? '').trim());
}

export interface ParsedLocation {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string;
}

/**
 * monday's location column stores a Google Places blob. `region` (state) is
 * not a top-level field, so it is recovered from the formatted address, which
 * looks like "2400 Ellis Street unit 1, Venus, TX, USA".
 */
export function parseLocation(rawValue: string | null | undefined): ParsedLocation | null {
  if (!rawValue) return null;
  let v: {
    address?: string | null;
    street?: { long_name?: string } | null;
    streetNumber?: { long_name?: string } | null;
    city?: { long_name?: string } | null;
    country?: { short_name?: string; long_name?: string } | null;
  };
  try {
    v = JSON.parse(rawValue);
  } catch {
    return null;
  }
  if (!v || !v.address) return null;

  const street = v.street?.long_name ?? null;
  const number = v.streetNumber?.long_name ?? null;
  const line1 = street ? [number, street].filter(Boolean).join(' ') : null;
  const city = v.city?.long_name ?? null;

  const parts = v.address.split(',').map((p) => p.trim());
  const region = parts.length >= 3 ? (parts[parts.length - 2] ?? null) : null;

  return {
    line1,
    line2: null,
    city,
    region,
    postalCode: null,
    country: v.country?.short_name ?? 'US',
  };
}

export const clean = (v: string | undefined | null): string | null => {
  const t = (v ?? '').trim();
  return t && t !== '-' ? t : null;
};

/**
 * Address for a deal row. The mapping sheet gives street / unit / city /
 * state / zip / country as their own columns, so those win; the location blob
 * is only a fallback for rows where the discrete columns are empty.
 */
export function buildAddress(
  text: Record<string, string | undefined>,
  rawLocation: string | null | undefined,
): ParsedLocation | null {
  const loc = parseLocation(rawLocation);

  const line1 =
    clean(text[DEAL_COL.street1]) ?? clean(text[DEAL_COL.streetText]) ?? loc?.line1 ?? null;
  const line2 = clean(text[DEAL_COL.unit]);
  // The City formula frequently resolves to a county, so it is the last resort.
  const city = clean(text[DEAL_COL.cityText]) ?? loc?.city ?? clean(text[DEAL_COL.city]);
  const region = clean(text[DEAL_COL.state]) ?? loc?.region ?? null;
  const postalCode = clean(text[DEAL_COL.zip]) ?? loc?.postalCode ?? null;
  const country = clean(text[DEAL_COL.country]) ?? loc?.country ?? 'US';

  if (!(line1 || city || postalCode)) return null;
  return { line1, line2, city, region, postalCode, country };
}

/** The email column's raw value is JSON; its `text` is the display label. */
export function parseEmail(rawValue: string | null | undefined, text: string): string | null {
  const t = (text ?? '').trim();
  if (t.includes('@')) return t.toLowerCase();
  if (!rawValue) return null;
  try {
    const v = JSON.parse(rawValue) as { email?: string };
    return v.email?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** board_relation raw value -> the linked monday item ids. */
export function parseLinkedIds(rawValue: string | null | undefined): string[] {
  if (!rawValue) return [];
  try {
    const v = JSON.parse(rawValue) as {
      linkedPulseIds?: Array<{ linkedPulseId: number | string }>;
    };
    return (v.linkedPulseIds ?? []).map((l) => String(l.linkedPulseId));
  } catch {
    return [];
  }
}

/** "$12,345.67" / "12345" -> 1234567 minor units. Null when not a number. */
export function parseMoneyMinor(text: string | undefined | null): bigint | null {
  const t = (text ?? '').replace(/[$,\s]/g, '').trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n === 0) return null;
  return BigInt(Math.round(n * 100));
}

/**
 * Contacts store the full name as the item name and the given name in its own
 * column, so the surname is whatever the full name has beyond the first name.
 */
export function splitName(fullName: string, firstNameCol: string): { first: string; last: string } {
  const full = (fullName ?? '').trim();
  const first = (firstNameCol ?? '').trim();

  if (first && full.toLowerCase().startsWith(first.toLowerCase())) {
    const last = full.slice(first.length).trim();
    return { first, last: last || first };
  }
  if (!full) return { first: first || 'Unknown', last: first ? '' : 'Contact' };

  const parts = full.split(/\s+/);
  if (parts.length === 1) return { first: parts[0]!, last: '' };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

/** Project ID column (pulse_id_mm5kc9f8). */
export function parseProjectId(text: string | undefined | null): string | null {
  return clean(text);
}
