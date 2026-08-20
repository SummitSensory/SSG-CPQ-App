/**
 * Country and Canadian-province normalization.
 *
 * This database holds the same country three different ways: `Address.country`
 * defaults to "US", `ShipToAddress.country` and `Manufacturer.country` default to
 * "USA", and `FreightRfq.shipToCountry` is whatever a monday column or a portal
 * submission happened to contain ("United States", "Canada", "CA", empty). Nothing
 * cared until now, because nothing branched on it.
 *
 * Cross-border behaviour branches on it, so every read goes through here first.
 * Pure functions, no database, no configuration — so the whole of country handling
 * is testable as a table of inputs, which is what tests/unit/crossBorderCountry
 * does.
 *
 * ISO 3166-1 alpha-2 is the normalized form: "CA", "US". The legacy spellings are
 * accepted on the way in and never written back out.
 */

/** The thirteen Canadian provinces and territories, ISO 3166-2:CA subdivisions. */
export type ProvinceCode =
  'AB' | 'BC' | 'MB' | 'NB' | 'NL' | 'NS' | 'NT' | 'NU' | 'ON' | 'PE' | 'QC' | 'SK' | 'YT';

export const PROVINCE_NAMES: Record<ProvinceCode, string> = {
  AB: 'Alberta',
  BC: 'British Columbia',
  MB: 'Manitoba',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
  ON: 'Ontario',
  PE: 'Prince Edward Island',
  QC: 'Quebec',
  SK: 'Saskatchewan',
  YT: 'Yukon',
};

/** Strip case, punctuation and internal spacing so "U.S.A." and "usa" agree. */
function key(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // "Canadá" → "Canada"
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

const CANADA = new Set(['CA', 'CAN', 'CANADA', 'CDN']);

const UNITED_STATES = new Set(['US', 'USA', 'UNITEDSTATES', 'UNITEDSTATESOFAMERICA', 'AMERICA']);

/**
 * Normalize a stored country value to ISO alpha-2.
 *
 * Returns null for empty or unrecognized input rather than guessing. A null is a
 * fact the caller must handle — an incomplete address is one of the states the
 * cross-border pipeline reports rather than one it papers over.
 *
 * An unrecognized non-empty value is returned as-is when it is already two letters
 * (so a country this function has never heard of still round-trips), and null
 * otherwise.
 */
export function normalizeCountry(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const k = key(raw);
  if (!k) return null;
  if (CANADA.has(k)) return 'CA';
  if (UNITED_STATES.has(k)) return 'US';
  return k.length === 2 ? k : null;
}

export function isCanada(raw: string | null | undefined): boolean {
  return normalizeCountry(raw) === 'CA';
}

export function isUnitedStates(raw: string | null | undefined): boolean {
  return normalizeCountry(raw) === 'US';
}

/**
 * Whether the field held anything at all, independent of whether we could map it.
 *
 * `normalizeCountry` returns null both for "empty" and for "a country name this
 * function has never heard of", and those are different facts: the first is an
 * incomplete address, the second is an unsupported destination. Callers that report
 * to a user need to tell them apart.
 */
export function hasCountryValue(raw: string | null | undefined): boolean {
  return raw != null && key(raw).length > 0;
}

/**
 * Province aliases. Codes, full names, the French names that appear on addresses
 * typed by Canadian customers, and the pre-ISO postal abbreviations that still
 * turn up in imported data ("PQ" for Quebec, "NF" for Newfoundland).
 */
const PROVINCE_ALIASES: Record<string, ProvinceCode> = {
  AB: 'AB',
  ALBERTA: 'AB',
  ALTA: 'AB',
  BC: 'BC',
  BRITISHCOLUMBIA: 'BC',
  COLOMBIEBRITANNIQUE: 'BC',
  MB: 'MB',
  MANITOBA: 'MB',
  MAN: 'MB',
  NB: 'NB',
  NEWBRUNSWICK: 'NB',
  NOUVEAUBRUNSWICK: 'NB',
  NL: 'NL',
  NF: 'NL',
  NFLD: 'NL',
  NEWFOUNDLAND: 'NL',
  NEWFOUNDLANDANDLABRADOR: 'NL',
  TERRENEUVEETLABRADOR: 'NL',
  NS: 'NS',
  NOVASCOTIA: 'NS',
  NOUVELLEECOSSE: 'NS',
  NT: 'NT',
  NWT: 'NT',
  NORTHWESTTERRITORIES: 'NT',
  TERRITOIRESDUNORDOUEST: 'NT',
  NU: 'NU',
  NUNAVUT: 'NU',
  ON: 'ON',
  ONT: 'ON',
  ONTARIO: 'ON',
  PE: 'PE',
  PEI: 'PE',
  PRINCEEDWARDISLAND: 'PE',
  ILEDUPRINCEEDOUARD: 'PE',
  QC: 'QC',
  PQ: 'QC',
  QUE: 'QC',
  QUEBEC: 'QC',
  SK: 'SK',
  SASK: 'SK',
  SASKATCHEWAN: 'SK',
  YT: 'YT',
  YK: 'YT',
  YUKON: 'YT',
  YUKONTERRITORY: 'YT',
};

/** Normalize a province or territory to its ISO subdivision code, or null. */
export function normalizeProvince(raw: string | null | undefined): ProvinceCode | null {
  if (raw == null) return null;
  const k = key(raw);
  if (!k) return null;
  return PROVINCE_ALIASES[k] ?? null;
}

export function provinceName(code: ProvinceCode): string {
  return PROVINCE_NAMES[code];
}

/**
 * The province a Canadian postal code's forward sortation area belongs to.
 *
 * Used ONLY to cross-check a province that was given, never to supply one that was
 * not: the requirement is explicit that a missing province is a validation error
 * rather than something to infer. A postal code that disagrees with the typed
 * province is worth surfacing, because one of the two is wrong and quoting tax off
 * the wrong one is the failure this guards against.
 *
 * The first letter is unambiguous except for X (Nunavut and Northwest Territories
 * share it) and A/B/C/E (single-province, but Newfoundland's A also covers Labrador).
 * X returns null rather than a coin flip.
 */
export function postalCodeProvinceHint(raw: string | null | undefined): ProvinceCode | null {
  if (raw == null) return null;
  const first = key(raw).charAt(0);
  const byLetter: Record<string, ProvinceCode | null> = {
    A: 'NL',
    B: 'NS',
    C: 'PE',
    E: 'NB',
    G: 'QC',
    H: 'QC',
    J: 'QC',
    K: 'ON',
    L: 'ON',
    M: 'ON',
    N: 'ON',
    P: 'ON',
    R: 'MB',
    S: 'SK',
    T: 'AB',
    V: 'BC',
    X: null, // NT and NU both use X.
    Y: 'YT',
  };
  return byLetter[first] ?? null;
}

/** A1A 1A1, with or without the space. Canada Post excludes D, F, I, O, Q and U. */
const CANADIAN_POSTAL = /^[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJKLMNPRSTVWXYZ]\d[ABCEGHJKLMNPRSTVWXYZ]\d$/;

export function isCanadianPostalCode(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  return CANADIAN_POSTAL.test(
    String(raw)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, ''),
  );
}

/** Display form: "T2P 2M5". Returns the input trimmed if it is not a valid code. */
export function formatCanadianPostalCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CANADIAN_POSTAL.test(c) ? `${c.slice(0, 3)} ${c.slice(3)}` : raw.trim();
}
