import { describe, expect, it } from 'vitest';
import {
  formatCanadianPostalCode,
  isCanadianPostalCode,
  normalizeCountry,
  normalizeProvince,
  postalCodeProvinceHint,
} from '../../src/lib/country.js';
import { resolveJurisdiction } from '../../src/crossborder/jurisdiction.js';
import {
  BankOfCanadaExchangeRateProvider,
  convertCadMinorToUsd,
  convertUsdMinorToCad,
  isStale,
  ManualExchangeRateProvider,
} from '../../src/crossborder/fx.js';
import {
  applicableTaxTypes,
  applyPercent,
  computeCanadianTax,
  type TaxabilityRule,
  type TaxRateRule,
  type TaxRegistration,
} from '../../src/crossborder/tax.js';

/* ── Country and province normalization ───────────────────────────────────── */

describe('normalizeCountry', () => {
  it('maps every spelling of Canada this database contains', () => {
    for (const raw of ['CA', 'CAN', 'Canada', 'canada', 'CANADA', ' Canada ', 'Canadá']) {
      expect(normalizeCountry(raw)).toBe('CA');
    }
  });

  it('maps every spelling of the United States this database contains', () => {
    for (const raw of ['US', 'USA', 'U.S.A.', 'United States', 'united states of america']) {
      expect(normalizeCountry(raw)).toBe('US');
    }
  });

  it('returns null for empty input rather than defaulting to a country', () => {
    expect(normalizeCountry('')).toBeNull();
    expect(normalizeCountry('   ')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
  });

  it('passes through a two-letter code it does not know', () => {
    expect(normalizeCountry('MX')).toBe('MX');
    expect(normalizeCountry('gb')).toBe('GB');
  });

  it('returns null for a country name it does not know', () => {
    expect(normalizeCountry('Mexico')).toBeNull();
  });
});

describe('normalizeProvince', () => {
  it('maps codes, full names, French names and legacy abbreviations', () => {
    expect(normalizeProvince('ON')).toBe('ON');
    expect(normalizeProvince('Ontario')).toBe('ON');
    expect(normalizeProvince('PQ')).toBe('QC');
    expect(normalizeProvince('Québec')).toBe('QC');
    expect(normalizeProvince('Colombie-Britannique')).toBe('BC');
    expect(normalizeProvince('NFLD')).toBe('NL');
    expect(normalizeProvince('Newfoundland and Labrador')).toBe('NL');
    expect(normalizeProvince('NWT')).toBe('NT');
    expect(normalizeProvince('PEI')).toBe('PE');
  });

  it('does not map a US state', () => {
    expect(normalizeProvince('CA')).toBeNull(); // California, not a province
    expect(normalizeProvince('Texas')).toBeNull();
  });
});

describe('Canadian postal codes', () => {
  it('accepts valid codes with or without a space', () => {
    expect(isCanadianPostalCode('T2P 2M5')).toBe(true);
    expect(isCanadianPostalCode('t2p2m5')).toBe(true);
    expect(isCanadianPostalCode('M5V 3L9')).toBe(true);
  });

  it('rejects codes using letters Canada Post does not use', () => {
    expect(isCanadianPostalCode('D2P 2M5')).toBe(false);
    expect(isCanadianPostalCode('T2P 2M5X')).toBe(false);
    expect(isCanadianPostalCode('90210')).toBe(false);
  });

  it('formats to the display form', () => {
    expect(formatCanadianPostalCode('t2p2m5')).toBe('T2P 2M5');
  });

  it('hints a province from the sortation area, and refuses to guess on X', () => {
    expect(postalCodeProvinceHint('T2P 2M5')).toBe('AB');
    expect(postalCodeProvinceHint('M5V 3L9')).toBe('ON');
    expect(postalCodeProvinceHint('H3B 4W8')).toBe('QC');
    // X is shared by the Northwest Territories and Nunavut.
    expect(postalCodeProvinceHint('X1A 2B3')).toBeNull();
  });
});

/* ── Jurisdiction resolution, from the BILLING address ────────────────────── */

const calgary = {
  line1: '100 7 Ave SW',
  city: 'Calgary',
  region: 'Alberta',
  postalCode: 'T2P 2M5',
  country: 'Canada',
};

describe('resolveJurisdiction', () => {
  it('turns the cross-border pipeline on for a complete Canadian address', () => {
    const j = resolveJurisdiction(calgary);
    expect(j.regime).toBe('CANADA');
    expect(j.country).toBe('CA');
    expect(j.province).toBe('AB');
    expect(j.provinceLabel).toBe('Alberta');
    expect(j.isCanadian).toBe(true);
    expect(j.complete).toBe(true);
    expect(j.issues).toEqual([]);
  });

  it('normalizes CAN and Canada identically', () => {
    expect(resolveJurisdiction({ ...calgary, country: 'CAN' }).province).toBe('AB');
    expect(resolveJurisdiction({ ...calgary, country: 'CA' }).province).toBe('AB');
  });

  it('leaves a US address entirely alone', () => {
    const j = resolveJurisdiction({
      line1: '1 Main St',
      city: 'Albany',
      region: 'MO',
      postalCode: '64402',
      country: 'United States',
    });
    expect(j.regime).toBe('DOMESTIC');
    expect(j.isCanadian).toBe(false);
    expect(j.complete).toBe(true);
    expect(j.issues).toEqual([]);
  });

  it('never infers a missing province', () => {
    const j = resolveJurisdiction({ ...calgary, region: '' });
    expect(j.regime).toBe('CANADA_INCOMPLETE');
    expect(j.province).toBeNull();
    expect(j.issues).toContain('missing_province');
    expect(j.complete).toBe(false);
  });

  it('flags a postal code that disagrees with the province', () => {
    const j = resolveJurisdiction({ ...calgary, region: 'Ontario' });
    expect(j.issues).toContain('province_postal_mismatch');
    expect(j.complete).toBe(false);
  });

  it('tells an unknown country apart from a missing one', () => {
    expect(resolveJurisdiction({ ...calgary, country: 'Mexico' }).issues).toEqual([
      'unsupported_country',
    ]);
    expect(resolveJurisdiction({ ...calgary, country: '' }).issues).toEqual(['missing_country']);
  });

  it('reports a customer with no billing address', () => {
    expect(resolveJurisdiction(null).issues).toEqual(['no_billing_address']);
  });
});

/* ── Currency conversion ──────────────────────────────────────────────────── */

describe('convertUsdMinorToCad', () => {
  it('converts an exact amount with no rounding', () => {
    // $1,000.00 at 1.3721 = $1,372.10
    expect(convertUsdMinorToCad(100_000n, '1.3721')).toBe(137_210n);
  });

  it('rounds half away from zero, symmetrically', () => {
    expect(convertUsdMinorToCad(1n, '1.5')).toBe(2n);
    expect(convertUsdMinorToCad(-1n, '1.5')).toBe(-2n);
  });

  it('leaves the USD amount untouched', () => {
    const usd = 123_456n;
    convertUsdMinorToCad(usd, '1.3721');
    expect(usd).toBe(123_456n);
  });

  it('rejects a malformed rate rather than producing a number', () => {
    expect(() => convertUsdMinorToCad(100n, '1,3721')).toThrow();
    expect(() => convertUsdMinorToCad(100n, '-1.37')).toThrow();
  });

  it('converts a CAD-quoted broker fee into USD', () => {
    // A CAD 250.00 flat fee at 1.3721 is USD 182.20.
    expect(convertCadMinorToUsd(25_000n, '1.3721')).toBe(18_220n);
  });
});

describe('isStale', () => {
  const obs = {
    pair: 'USD/CAD',
    rate: '1.3721',
    observationDate: '2026-08-14',
    source: 'BANK_OF_CANADA' as const,
    retrievedAt: new Date('2026-08-14T12:00:00Z'),
  };

  it('is not stale inside the threshold', () => {
    expect(isStale(obs, '2026-08-17', 5)).toBe(false);
  });

  it('is stale beyond it', () => {
    expect(isStale(obs, '2026-08-25', 5)).toBe(true);
  });
});

/* ── The Bank of Canada provider, against a stubbed transport ──────────────── */

function stubFetch(payload: unknown, ok = true): typeof fetch {
  return (async () => ({
    ok,
    status: ok ? 200 : 503,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

describe('BankOfCanadaExchangeRateProvider', () => {
  it('takes the last observation in the window, so a weekend falls back to Friday', async () => {
    const provider = new BankOfCanadaExchangeRateProvider(
      'FXUSDCAD',
      stubFetch({
        observations: [
          { d: '2026-08-13', FXUSDCAD: { v: '1.3699' } },
          { d: '2026-08-14', FXUSDCAD: { v: '1.3721' } },
        ],
      }),
    );
    // 2026-08-16 is a Sunday; the Bank published nothing that day.
    const obs = await provider.observationOnOrBefore('2026-08-16');
    expect(obs?.observationDate).toBe('2026-08-14');
    expect(obs?.rate).toBe('1.3721');
    expect(obs?.source).toBe('BANK_OF_CANADA');
  });

  it('returns null when the window genuinely holds no observation', async () => {
    const provider = new BankOfCanadaExchangeRateProvider(
      'FXUSDCAD',
      stubFetch({ observations: [] }),
    );
    expect(await provider.observationOnOrBefore('2026-08-16')).toBeNull();
  });

  it('throws after exhausting retries rather than inventing a rate', async () => {
    const provider = new BankOfCanadaExchangeRateProvider('FXUSDCAD', stubFetch({}, false));
    await expect(provider.observationOnOrBefore('2026-08-16')).rejects.toThrow(
      /No USD\/CAD observation/,
    );
  });

  it('ignores a manual rate that is not yet effective', async () => {
    const manual = new ManualExchangeRateProvider('1.4000', '2026-09-01');
    expect(await manual.observationOnOrBefore('2026-08-16')).toBeNull();
    expect((await manual.observationOnOrBefore('2026-09-02'))?.source).toBe('MANUAL');
  });
});

/* ── Tax ──────────────────────────────────────────────────────────────────── */

describe('applyPercent', () => {
  it('applies whole and fractional rates exactly', () => {
    expect(applyPercent(100_000n, '13')).toBe(13_000n);
    expect(applyPercent(100_000n, '9.975')).toBe(9_975n);
    expect(applyPercent(100_000n, '5')).toBe(5_000n);
  });

  it('rounds a discount the same way as a charge', () => {
    expect(applyPercent(-100_000n, '13')).toBe(-13_000n);
  });
});

/** Rates as the migration seeds them. effectiveTo is EXCLUSIVE. */
const RATES: TaxRateRule[] = [
  {
    id: 'ab-gst',
    province: 'AB',
    taxType: 'GST',
    ratePercent: '5',
    effectiveFrom: '2008-01-01',
    effectiveTo: null,
  },
  {
    id: 'bc-gst',
    province: 'BC',
    taxType: 'GST',
    ratePercent: '5',
    effectiveFrom: '2008-01-01',
    effectiveTo: null,
  },
  {
    id: 'bc-pst',
    province: 'BC',
    taxType: 'PST',
    ratePercent: '7',
    effectiveFrom: '2013-04-01',
    effectiveTo: null,
  },
  {
    id: 'mb-gst',
    province: 'MB',
    taxType: 'GST',
    ratePercent: '5',
    effectiveFrom: '2008-01-01',
    effectiveTo: null,
  },
  {
    id: 'mb-rst',
    province: 'MB',
    taxType: 'RST',
    ratePercent: '7',
    effectiveFrom: '2019-07-01',
    effectiveTo: null,
  },
  {
    id: 'on-hst',
    province: 'ON',
    taxType: 'HST',
    ratePercent: '13',
    effectiveFrom: '2010-07-01',
    effectiveTo: null,
  },
  {
    id: 'ns-hst-15',
    province: 'NS',
    taxType: 'HST',
    ratePercent: '15',
    effectiveFrom: '2010-07-01',
    effectiveTo: '2025-04-01',
  },
  {
    id: 'ns-hst-14',
    province: 'NS',
    taxType: 'HST',
    ratePercent: '14',
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
  },
  {
    id: 'qc-gst',
    province: 'QC',
    taxType: 'GST',
    ratePercent: '5',
    effectiveFrom: '2008-01-01',
    effectiveTo: null,
  },
  {
    id: 'qc-qst',
    province: 'QC',
    taxType: 'QST',
    ratePercent: '9.975',
    effectiveFrom: '2013-01-01',
    effectiveTo: null,
  },
];

/** Equipment and freight taxable everywhere, for every tax type. */
const TAXABILITY: TaxabilityRule[] = (['GST', 'HST', 'PST', 'RST', 'QST'] as const).flatMap(
  (taxType) =>
    (['EQUIPMENT', 'FREIGHT'] as const).map((category) => ({
      id: `${category}-${taxType}`,
      category,
      taxType,
      province: null,
      taxable: true,
      effectiveFrom: '2008-01-01',
      effectiveTo: null,
    })),
);

/** One federal GST/HST registration, as SSG will actually hold it. */
const FEDERAL_ONLY: TaxRegistration[] = [
  {
    taxType: 'GST',
    province: null,
    status: 'REGISTERED',
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
  },
];

const CHARGES = [
  { category: 'EQUIPMENT' as const, usdMinor: 100_000n },
  { category: 'FREIGHT' as const, usdMinor: 20_000n },
];

type TaxArgs = Parameters<typeof computeCanadianTax>[0];

function compute(province: TaxArgs['province'], extra: Partial<TaxArgs> = {}) {
  return computeCanadianTax({
    province,
    asOf: '2026-08-20',
    responsibility: 'SELLER_COLLECTS',
    charges: CHARGES,
    rates: RATES,
    taxability: TAXABILITY,
    registrations: FEDERAL_ONLY,
    exemptions: [],
    ...extra,
  });
}

describe('computeCanadianTax', () => {
  it('Alberta: GST only, no provincial line', () => {
    const r = compute('AB');
    expect(r.lines.map((l) => l.label)).toEqual(['GST']);
    expect(r.lines[0]?.ratePercent).toBe('5');
    expect(r.totalTaxUsdMinor).toBe(6_000n); // 5% of 1,200.00
  });

  it('Ontario: one HST line, never split into federal and provincial parts', () => {
    const r = compute('ON');
    expect(r.lines.map((l) => l.label)).toEqual(['HST']);
    expect(r.lines[0]?.ratePercent).toBe('13');
    expect(r.totalTaxUsdMinor).toBe(15_600n);
  });

  it('holds a single federal GST/HST registration valid in an HST province', () => {
    // The regression this locks: an HST province must not demand a registration
    // row whose taxType is literally 'HST'. One federal registration covers both.
    const r = compute('ON');
    expect(r.lines[0]?.status).toBe('CHARGED');
    expect(r.issues).toEqual([]);
    expect(r.readyForCustomer).toBe(true);
  });

  it('Manitoba labels its provincial tax RST, not PST', () => {
    const r = compute('MB', {
      registrations: [
        ...FEDERAL_ONLY,
        {
          taxType: 'RST',
          province: 'MB',
          status: 'REGISTERED',
          effectiveFrom: '2020-01-01',
          effectiveTo: null,
        },
      ],
    });
    expect(r.lines.map((l) => l.label).sort()).toEqual(['GST', 'RST']);
  });

  it('Quebec produces separate GST and QST lines and does not compound them', () => {
    const r = compute('QC', {
      registrations: [
        ...FEDERAL_ONLY,
        {
          taxType: 'QST',
          province: 'QC',
          status: 'REGISTERED',
          effectiveFrom: '2020-01-01',
          effectiveTo: null,
        },
      ],
    });
    const byType = Object.fromEntries(r.lines.map((l) => [l.taxType, l]));
    expect(byType.GST?.taxUsdMinor).toBe(6_000n);
    // 9.975% of the same 1,200.00 base — not of 1,200.00 plus GST.
    expect(byType.QST?.taxableBasisUsdMinor).toBe(120_000n);
    expect(byType.QST?.taxUsdMinor).toBe(11_970n);
  });

  it('honours effective dates: Nova Scotia was 15%, then 14%', () => {
    expect(applicableTaxTypes('NS', '2025-03-31', RATES)[0]?.ratePercent).toBe('15');
    expect(applicableTaxTypes('NS', '2025-04-01', RATES)[0]?.ratePercent).toBe('14');
    expect(applicableTaxTypes('NS', '2026-08-20', RATES)[0]?.ratePercent).toBe('14');
  });

  it('needs review when no registration exists, instead of charging or omitting', () => {
    const r = compute('BC'); // PST rate exists, no PST registration supplied
    const pst = r.lines.find((l) => l.taxType === 'PST');
    expect(pst?.status).toBe('REQUIRES_TAX_REVIEW');
    expect(pst?.taxUsdMinor).toBe(0n);
    expect(r.issues).toContain('missing_registration');
    expect(r.readyForCustomer).toBe(false);
  });

  it('needs review when a charge category has no taxability rule', () => {
    const r = compute('AB', {
      charges: [...CHARGES, { category: 'INSTALLATION' as const, usdMinor: 50_000n }],
    });
    expect(r.issues).toContain('missing_taxability_rule');
    expect(r.readyForCustomer).toBe(false);
  });

  it('ignores an exemption that has not been approved', () => {
    const r = compute('AB', {
      exemptions: [
        {
          taxTypes: ['GST'],
          certificateNumber: 'SCHOOL-1',
          effectiveFrom: '2020-01-01',
          effectiveTo: null,
          approved: false,
        },
      ],
    });
    expect(r.lines[0]?.status).toBe('CHARGED');
    expect(r.totalTaxUsdMinor).toBe(6_000n);
  });

  it('suppresses only the exempted tax type once approved', () => {
    const r = compute('QC', {
      registrations: [
        ...FEDERAL_ONLY,
        {
          taxType: 'QST',
          province: 'QC',
          status: 'REGISTERED',
          effectiveFrom: '2020-01-01',
          effectiveTo: null,
        },
      ],
      exemptions: [
        {
          taxTypes: ['QST'],
          certificateNumber: 'QC-EX-1',
          effectiveFrom: '2020-01-01',
          effectiveTo: null,
          approved: true,
        },
      ],
    });
    const byType = Object.fromEntries(r.lines.map((l) => [l.taxType, l]));
    expect(byType.QST?.status).toBe('EXEMPT');
    expect(byType.QST?.taxUsdMinor).toBe(0n);
    expect(byType.GST?.status).toBe('CHARGED');
  });

  it('charges nothing when the customer pays tax at import', () => {
    const r = compute('ON', { responsibility: 'CUSTOMER_PAYS_AT_IMPORT' });
    expect(r.lines).toEqual([]);
    expect(r.totalTaxUsdMinor).toBe(0n);
    expect(r.readyForCustomer).toBe(true);
  });

  it('blocks release when tax responsibility itself is unresolved', () => {
    const r = compute('ON', { responsibility: 'REQUIRES_TAX_REVIEW' });
    expect(r.readyForCustomer).toBe(false);
    expect(r.issues).toContain('responsibility_requires_review');
  });
});
