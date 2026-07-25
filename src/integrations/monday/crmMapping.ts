/**
 * Mapping from the monday CRM boards to CPQ entities.
 *
 * The Organizations column ids below are the ones listed in
 * "Monday Column Mapping.xlsx" — that sheet is the source of truth for which
 * columns get pulled. Column ids are per-board and opaque: renaming a column
 * in monday keeps the id, but DELETING and re-adding a column changes it and
 * this file must be updated.
 *
 *   Organizations  board 6527740311  (~2,860 items)
 *   Contacts       board 6527740281  (~2,800 items)
 */

import type { CustomerType } from '@prisma/client';

export const ORGANIZATIONS_BOARD_ID = '6527740311';
export const CONTACTS_BOARD_ID = '6527740281';

/** Columns pulled from the Organizations board (per Monday Column Mapping.xlsx). */
export const ORG_COL = {
  /** lookup — see INDUSTRY_TO_CUSTOMER_TYPE */
  industry: 'lookup3__1',
  /** text — full name of the primary contact, mirrored onto the org row */
  primaryContactName: 'text9__1',
  /** email — primary contact email address */
  primaryContactEmail: 'email_1__1',
  /** phone — primary contact direct phone number */
  primaryContactPhone: 'phone__1',
  /** location — full location address (Google Places blob); fallback only */
  location: 'location__1',
  /** formula — street address line 1 */
  street1: 'formula_mkpsy1b6',
  /** text — unit / suite */
  unit: 'text_mm1zssfw',
  /** formula — city */
  city: 'formula_mkpsgx0y',
  /** text — state */
  state: 'text_mkpzwfqz',
  /** text — zip code */
  zip: 'text__1',
  /** status — country */
  country: 'status47__1',
  /** mirror — Project ID */
  projectId: 'mirror1__1',

  // Not on the mapping sheet, but present on the board and useful when set.
  // Missing columns simply read as undefined and are ignored.
  /** link — company website */
  website: 'company_domain',
  /** long_text */
  description: 'company_description',
  /** board_relation -> Contacts */
  contacts: 'account_contact',
} as const;

/** Columns on the Contacts board (used only when the Contacts pass runs). */
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
 * than failing the import.
 */
export const INDUSTRY_TO_CUSTOMER_TYPE: Record<string, CustomerType> = {
  'ABA Practice': 'PRIVATE_PRACTICE',
  'ABA Therapy Practice': 'PRIVATE_PRACTICE',
  'Therapy Clinic': 'PRIVATE_PRACTICE',
  'Multi-Disciplinary Therapy Practice': 'PRIVATE_PRACTICE',
  'Rehabilitation Facility': 'PRIVATE_PRACTICE',
  'Rehab Facility': 'PRIVATE_PRACTICE',
  Hospital: 'HOSPITAL',
  Hosptial: 'HOSPITAL',
  'K-12 School': 'SCHOOL',
  Childcare: 'SCHOOL',
  'University/Colllege': 'UNIVERSITY',
  'University / College': 'UNIVERSITY',
  'City / County': 'GOVERNMENT',
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

export function toCustomerType(label: string | undefined | null): CustomerType {
  if (!label) return 'OTHER';
  return INDUSTRY_TO_CUSTOMER_TYPE[label.trim()] ?? 'OTHER';
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

  // "…, Venus, TX, USA" -> region is the second-from-last comma part.
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

const clean = (v: string | undefined | null): string | null => {
  const t = (v ?? '').trim();
  return t && t !== '-' ? t : null;
};

/**
 * Address for an organization. The mapping sheet gives street / unit / city /
 * state / zip / country as their own columns, so those win; the location blob
 * is only a fallback for rows where the discrete columns are empty.
 */
export function buildAddress(
  text: Record<string, string | undefined>,
  rawLocation: string | null | undefined,
): ParsedLocation | null {
  const line1 = clean(text[ORG_COL.street1]);
  const line2 = clean(text[ORG_COL.unit]);
  const city = clean(text[ORG_COL.city]);
  const region = clean(text[ORG_COL.state]);
  const postalCode = clean(text[ORG_COL.zip]);
  const country = clean(text[ORG_COL.country]) ?? 'US';

  if (line1 || city || postalCode) {
    return { line1, line2, city, region, postalCode, country };
  }

  const loc = parseLocation(rawLocation);
  if (!loc) return null;
  return {
    ...loc,
    line2,
    postalCode: postalCode ?? loc.postalCode,
    region: region ?? loc.region,
  };
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

/** The Project ID column is a mirror; its text is the id. */
export function parseProjectId(text: string | undefined | null): string | null {
  return clean(text);
}
