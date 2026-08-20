/**
 * Which tax and customs regime a proposal falls under, resolved from ONE address.
 *
 * That address is the customer's BILLING address (`AddressType.BILLING`), by
 * explicit business decision. The usual cross-border rule is to branch on ship-to,
 * because tax follows where the goods land — but this application has no ship-to on
 * a proposal at all (`ShipToAddress` hangs off orders and BOM vendor sections, and
 * `FreightRfq` freezes its own copy at RFQ time), and SSG's Canadian customers are
 * billed and shipped in the same country.
 *
 * The consequence is recorded here rather than buried: a Canadian-billed order
 * shipping to a US address would be treated as Canadian, which would be wrong. If
 * that combination ever becomes real, `resolveJurisdiction` is the only function
 * that has to change — nothing downstream reads an address directly.
 */
import {
  hasCountryValue,
  isCanadianPostalCode,
  normalizeCountry,
  normalizeProvince,
  postalCodeProvinceHint,
  provinceName,
  type ProvinceCode,
} from '../lib/country.js';

/** The shape this needs from an Address row — not the Prisma type, so it stays pure. */
export interface AddressInput {
  line1?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export type JurisdictionRegime =
  /** Not a cross-border proposal. Everything behaves exactly as it did before. */
  | 'DOMESTIC'
  /** Canada, with a province resolved. Cross-border pipeline runs. */
  | 'CANADA'
  /** Canada, but something required is missing or contradictory. */
  | 'CANADA_INCOMPLETE'
  /** A country that is neither Canada nor the US, or no country at all. */
  | 'UNSUPPORTED';

/**
 * A machine-readable reason the regime is not simply CANADA or DOMESTIC. These
 * strings surface on the proposal as review items, so they are stable identifiers
 * rather than prose.
 */
export type JurisdictionIssue =
  | 'no_billing_address'
  | 'missing_country'
  | 'missing_province'
  | 'unrecognized_province'
  | 'missing_postal_code'
  | 'invalid_postal_code'
  | 'province_postal_mismatch'
  | 'unsupported_country';

export interface Jurisdiction {
  regime: JurisdictionRegime;
  /** ISO alpha-2, or null when the address has no usable country. */
  country: string | null;
  province: ProvinceCode | null;
  provinceLabel: string | null;
  /** Always 'BILLING' in this version. Named so a later change is visible in data. */
  source: 'BILLING';
  issues: JurisdictionIssue[];
  /** True when the cross-border pipeline should run at all. */
  isCanadian: boolean;
  /**
   * True when every input the tax engine needs is present and self-consistent.
   * A proposal may be SAVED without this; it may not be released as final.
   */
  complete: boolean;
}

/**
 * Resolve the regime for a billing address.
 *
 * Never infers a province. A Canadian address with no region comes back as
 * CANADA_INCOMPLETE with `missing_province`, which is a validation error the user
 * has to fix — not a silent fallback to the cheapest or commonest province.
 */
export function resolveJurisdiction(address: AddressInput | null | undefined): Jurisdiction {
  const base = {
    country: null,
    province: null,
    provinceLabel: null,
    source: 'BILLING' as const,
    isCanadian: false,
    complete: false,
    issues: [] as JurisdictionIssue[],
  };

  if (!address || !address.line1) {
    return { ...base, regime: 'UNSUPPORTED', issues: ['no_billing_address'] };
  }

  const country = normalizeCountry(address.country);
  if (!country) {
    // An empty country field and a country we cannot map are different problems.
    // Reporting the second as "missing" would send someone to fix an address that
    // is already complete.
    return hasCountryValue(address.country)
      ? { ...base, regime: 'UNSUPPORTED', issues: ['unsupported_country'] }
      : { ...base, regime: 'UNSUPPORTED', issues: ['missing_country'] };
  }

  if (country !== 'CA') {
    // Every non-Canadian country keeps its existing behaviour untouched. Only 'CA'
    // turns the cross-border pipeline on, so no proposal in production changes
    // because of this release.
    return { ...base, regime: 'DOMESTIC', country, complete: true };
  }

  const issues: JurisdictionIssue[] = [];
  const province = normalizeProvince(address.region);

  if (!address.region) issues.push('missing_province');
  else if (!province) issues.push('unrecognized_province');

  if (!address.postalCode) issues.push('missing_postal_code');
  else if (!isCanadianPostalCode(address.postalCode)) issues.push('invalid_postal_code');
  else if (province) {
    const hint = postalCodeProvinceHint(address.postalCode);
    // X is shared by NT and NU, so the hint is null there and no mismatch is
    // claimed. Anywhere else a disagreement means one of the two fields is wrong.
    if (hint && hint !== province) issues.push('province_postal_mismatch');
  }

  const complete = issues.length === 0;
  return {
    regime: complete ? 'CANADA' : 'CANADA_INCOMPLETE',
    country,
    province,
    provinceLabel: province ? provinceName(province) : null,
    source: 'BILLING',
    issues,
    isCanadian: true,
    complete,
  };
}

/** Human-readable review text for each issue, for the proposal's status panel. */
export const JURISDICTION_ISSUE_TEXT: Record<JurisdictionIssue, string> = {
  no_billing_address: 'This customer has no billing address on file.',
  missing_country: 'The billing address has no country.',
  missing_province:
    'The billing address has no province or territory. Canadian tax cannot be determined without it.',
  unrecognized_province: 'The province or territory on the billing address was not recognized.',
  missing_postal_code: 'The billing address has no postal code.',
  invalid_postal_code: 'The postal code is not a valid Canadian postal code.',
  province_postal_mismatch:
    'The postal code belongs to a different province than the one on the address. Confirm which is correct.',
  unsupported_country: 'This country is not supported for cross-border proposals.',
};
