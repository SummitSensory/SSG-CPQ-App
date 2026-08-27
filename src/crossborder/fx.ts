/**
 * USD/CAD exchange rates, from the Bank of Canada.
 *
 * Two rules shape this file.
 *
 * First: a rate is a fact with a date, not a current value. The proposal stores the
 * observation it was quoted on, and re-reading the proposal a month later must show
 * the same CAD figures. So nothing here returns "the rate" — everything returns the
 * most recently published observation on or before a given date, and the caller
 * records which one it got.
 *
 * Second: the Bank of Canada does not publish every day. Weekends, statutory
 * holidays and the odd outage all mean "yesterday's rate" may not exist. Asking for
 * a window and taking the last observation in it is the only correct way to read
 * this series; asking for a single date and treating an empty response as an error
 * would break every Monday-morning proposal.
 *
 * Conversion lives here too, because rounding is part of the rate: CAD is derived
 * from the authoritative USD minor units and the unrounded rate, never from an
 * already-rounded CAD unit price.
 */
import { logger } from '../lib/logger.js';

/** The series that gives Canadian dollars per one US dollar. */
export const FX_SERIES = 'FXUSDCAD';
export const FX_PAIR = 'USD/CAD';

const VALET_BASE = 'https://www.bankofcanada.ca/valet/observations';

/** How far back to look for the last published observation. */
const LOOKBACK_DAYS = 14;

// Sized against the serverless function budget, not against patience. Three attempts
// at six seconds is eighteen seconds worst case, which outlives the function: the
// platform kills the request first and the screen shows a generic failure instead of
// the reason. Two attempts at four seconds, with an overall deadline, always returns
// its own error message.
const REQUEST_TIMEOUT_MS = 4_000;
const ATTEMPTS = 2;
const TOTAL_BUDGET_MS = 8_500;

export interface RateObservation {
  pair: string;
  /** Decimal string, unrounded as published — e.g. "1.3721". Never a float. */
  rate: string;
  /** The date the Bank of Canada published this observation for (YYYY-MM-DD). */
  observationDate: string;
  source: 'BANK_OF_CANADA' | 'MANUAL' | 'CACHE';
  retrievedAt: Date;
}

export class ExchangeRateUnavailableError extends Error {
  constructor(
    readonly pair: string,
    readonly asOf: string,
    /**
     * Named `underlying` rather than `cause`: Error already declares an optional
     * mutable `cause` under the ES2022 lib, and redeclaring it as a readonly
     * parameter property is a modifier mismatch that some tsconfigs reject.
     */
    readonly underlying?: unknown,
  ) {
    super(`No ${pair} observation available on or before ${asOf}`);
    this.name = 'ExchangeRateUnavailableError';
  }
}

/** YYYY-MM-DD in UTC. Rate dates are calendar dates, not instants. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function minusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return isoDate(d);
}

interface ValetResponse {
  observations?: Array<Record<string, unknown>>;
}

/**
 * The provider contract. Two implementations ship: the Bank of Canada, and a
 * manual rate an administrator entered. Tests use a third that reads a fixture,
 * which is why this is an interface and why nothing else in the codebase calls
 * fetch() for a rate.
 */
export interface ExchangeRateProvider {
  readonly name: string;
  /** The last observation on or before `asOf`, or null if the source has none. */
  observationOnOrBefore(asOf: string): Promise<RateObservation | null>;
}

export class BankOfCanadaExchangeRateProvider implements ExchangeRateProvider {
  readonly name = 'BANK_OF_CANADA';

  constructor(
    private readonly series = FX_SERIES,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async observationOnOrBefore(asOf: string): Promise<RateObservation | null> {
    const start = minusDays(asOf, LOOKBACK_DAYS);
    const url = `${VALET_BASE}/${this.series}/json?start_date=${start}&end_date=${asOf}`;

    let lastError: unknown = null;
    const deadline = Date.now() + TOTAL_BUDGET_MS;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (Date.now() >= deadline) break;
      try {
        const body = await this.request(url, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
        const obs = body.observations ?? [];
        // Valet returns observations in ascending date order; the last one in the
        // window is the most recent publication on or before asOf.
        for (let i = obs.length - 1; i >= 0; i--) {
          const row = obs[i];
          if (!row) continue;
          const date = typeof row.d === 'string' ? row.d : null;
          const cell = row[this.series] as { v?: unknown } | undefined;
          const value = cell && typeof cell.v === 'string' ? cell.v : null;
          if (date && value && /^\d+(\.\d+)?$/.test(value)) {
            return {
              pair: FX_PAIR,
              rate: value,
              observationDate: date,
              source: 'BANK_OF_CANADA',
              retrievedAt: new Date(),
            };
          }
        }
        return null;
      } catch (err) {
        lastError = err;
        logger.warn(
          { err, attempt, url },
          'Bank of Canada rate request failed; retrying if attempts remain',
        );
      }
    }
    throw new ExchangeRateUnavailableError(FX_PAIR, asOf, lastError);
  }

  private async request(url: string, budgetMs = REQUEST_TIMEOUT_MS): Promise<ValetResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Valet responded ${res.status}`);
      return (await res.json()) as ValetResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A rate an administrator typed, with the reason they typed it. */
export class ManualExchangeRateProvider implements ExchangeRateProvider {
  readonly name = 'MANUAL';

  constructor(
    private readonly rate: string,
    private readonly effectiveDate: string,
  ) {}

  async observationOnOrBefore(asOf: string): Promise<RateObservation | null> {
    if (this.effectiveDate > asOf) return null;
    return {
      pair: FX_PAIR,
      rate: this.rate,
      observationDate: this.effectiveDate,
      source: 'MANUAL',
      retrievedAt: new Date(),
    };
  }
}

/* ── Conversion ───────────────────────────────────────────────────────────────
 *
 * CAD minor units = round(USD minor units × rate).
 *
 * Done in bigint against the rate's own scale, so no step touches a float. The
 * rate string is split into digits and a scale ("1.3721" → 13721, 4) and the
 * multiplication is exact; only the final division rounds.
 *
 * Rounding is HALF-UP AWAY FROM ZERO: 0.5 cent goes to 1 cent, and -0.5 goes to
 * -1. Chosen because it is what the rest of the application does to money and
 * because it is symmetric — a discount line and the charge it discounts round the
 * same way, so a proposal's CAD lines still sum to its CAD total.
 */

export interface ParsedRate {
  digits: bigint;
  scale: number;
}

export function parseRate(rate: string): ParsedRate {
  if (!/^\d+(\.\d+)?$/.test(rate)) throw new Error(`Invalid exchange rate: ${rate}`);
  const [whole, frac = ''] = rate.split('.');
  return { digits: BigInt(whole + frac), scale: frac.length };
}

/** Convert authoritative USD minor units to CAD minor units at `rate`. */
export function convertUsdMinorToCad(usdMinor: bigint, rate: string): bigint {
  const { digits, scale } = parseRate(rate);
  const divisor = 10n ** BigInt(scale);
  const product = usdMinor * digits;
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs * 2n + divisor) / (divisor * 2n);
  return negative ? -rounded : rounded;
}

/**
 * The inverse, for a broker fee quoted in CAD that has to be shown in USD. Kept
 * separate and explicitly named: this is the ONE direction in which a CAD figure
 * is allowed to produce a USD one, and only because the CAD figure is the source
 * document. A converted CAD amount must never be converted back.
 */
export function convertCadMinorToUsd(cadMinor: bigint, rate: string): bigint {
  const { digits, scale } = parseRate(rate);
  const multiplier = 10n ** BigInt(scale);
  const negative = cadMinor < 0n;
  const abs = negative ? -cadMinor : cadMinor;
  const rounded = (abs * multiplier * 2n + digits) / (digits * 2n);
  return negative ? -rounded : rounded;
}

/** "1 USD = 1.3721 CAD", for the exchange-rate banner. */
export function formatRateSentence(obs: RateObservation): string {
  return `1 USD = ${obs.rate} CAD`;
}

/** True when the observation is older than the configured staleness threshold. */
export function isStale(obs: RateObservation, asOf: string, thresholdDays: number): boolean {
  const age = Math.floor(
    (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${obs.observationDate}T00:00:00Z`)) / 86_400_000,
  );
  return age > thresholdDays;
}
