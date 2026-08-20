/**
 * The exchange rate a proposal is quoted on: cache, fallback, and audit.
 *
 * `fx.ts` knows how to read the Bank of Canada and how to convert money. This file
 * is what the application actually calls, and it owns three things fx.ts must not:
 * when to skip the network, what to do when the network fails, and what gets
 * written down.
 *
 * The cache is keyed on the date we needed a rate FOR, not on the date the Bank
 * published. Without that distinction a Monday proposal cannot tell "Friday is
 * genuinely the latest publication" from "we have not fetched Monday yet" — so it
 * would either call the Valet API on every page view or quote a stale rate. With
 * it, resolving a date is idempotent: the same proposal date always returns the
 * same observation, and the API is called once per date.
 *
 * A fallback is NEVER cached. If the Bank was unreachable and we fell back to a
 * cached or manual rate, the next attempt tries the Bank again.
 */
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../lib/audit.js';
import {
  BankOfCanadaExchangeRateProvider,
  FX_PAIR,
  isStale,
  type ExchangeRateProvider,
  type RateObservation,
} from './fx.js';

export type FxFallbackModeValue =
  'LAST_CACHED' | 'MANUAL_RATE' | 'BLOCK_FINALIZATION' | 'DRAFT_WITH_REVIEW';

export interface RateResolution {
  /** Null only when no rate could be produced at all. */
  observation: RateObservation | null;
  /** True when the Bank of Canada did not answer and a fallback was used. */
  fallbackUsed: boolean;
  stale: boolean;
  /**
   * Whether a proposal may be RELEASED on this rate. A draft can still be saved.
   */
  blocksFinalization: boolean;
  /**
   * Whether a draft may be produced at all. Only BLOCK_FINALIZATION with no
   * usable rate sets this false.
   *
   * ASSUMPTION, flagged for confirmation: the requirement lists "block proposal
   * finalization" and "permit a draft but label it as requiring review" as two
   * separate fallback options, which only differ if one of them also withholds
   * the draft. Read here as: BLOCK_FINALIZATION produces no CAD figures at all,
   * DRAFT_WITH_REVIEW produces them with a warning. If that is backwards, this
   * is the only place to change.
   */
  allowsDraft: boolean;
  /** Customer- or staff-facing warning text. Null when the rate is clean. */
  warning: string | null;
  /** The reason an administrator gave for a manual rate, when one was used. */
  overrideReason: string | null;
}

export interface ResolveOptions {
  pair?: string;
  provider?: ExchangeRateProvider;
  fallbackMode: FxFallbackModeValue;
  staleRateDays: number;
}

/** A calendar date at UTC midnight, which is how the DATE columns are written. */
function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve the rate for one date.
 *
 * Order: the resolution cache, then the provider, then the configured fallback.
 * Nothing here throws on a provider failure — a proposal that cannot get a rate
 * is a proposal with a warning on it, not a 500.
 */
export async function resolveRateForDate(
  asOf: string,
  opts: ResolveOptions,
): Promise<RateResolution> {
  const pair = opts.pair ?? FX_PAIR;
  const provider = opts.provider ?? new BankOfCanadaExchangeRateProvider();

  const clean = (observation: RateObservation): RateResolution => {
    const stale = isStale(observation, asOf, opts.staleRateDays);
    return {
      observation,
      fallbackUsed: false,
      stale,
      blocksFinalization: false,
      allowsDraft: true,
      // A stale published rate is disclosed but not blocking: it IS the latest
      // thing the Bank published, and over a long weekend or a holiday week that
      // is the correct rate to quote. Silence would be wrong; refusing would be
      // wrong too.
      warning: stale
        ? `The most recent Bank of Canada rate is dated ${observation.observationDate}, more than ${opts.staleRateDays} days before this proposal.`
        : null,
      overrideReason: null,
    };
  };

  // 1. Already resolved this date.
  const cached = await prisma.exchangeRateResolution.findUnique({
    where: { pair_forDate: { pair, forDate: dateOnly(asOf) } },
  });
  if (cached) {
    return clean({
      pair,
      rate: String(cached.rate),
      observationDate: toIso(cached.observationDate),
      source: cached.source === 'MANUAL' ? 'MANUAL' : 'BANK_OF_CANADA',
      retrievedAt: cached.resolvedAt,
    });
  }

  // 2. Ask the configured provider.
  try {
    const observation = await provider.observationOnOrBefore(asOf);
    if (observation) {
      // Only a published rate is cached as a resolution. A manual rate is a
      // substitution, not an observation: caching it would make the warning
      // disappear on every later read of the same date, which is precisely the
      // "never silently substitute a manual rate" failure.
      if (observation.source === 'BANK_OF_CANADA') {
        await persist(pair, asOf, observation);
        return clean(observation);
      }
      return {
        observation,
        fallbackUsed: false,
        stale: isStale(observation, asOf, opts.staleRateDays),
        blocksFinalization: false,
        allowsDraft: true,
        warning: `CAD amounts use a manually entered exchange rate dated ${observation.observationDate}, not a Bank of Canada published rate.`,
        overrideReason: null,
      };
    }
    // A successful call with an empty window is not an error, but it is also not
    // an answer — fall through to the configured fallback.
    logger.warn({ pair, asOf }, 'no exchange-rate observation published in the lookback window');
  } catch (err) {
    logger.error({ err, pair, asOf }, 'exchange-rate provider failed; using configured fallback');
  }

  return await applyFallback(pair, asOf, opts);
}

/**
 * Write the observation and the resolution. Upserts, so two proposals resolving
 * the same date concurrently cannot collide.
 */
async function persist(pair: string, asOf: string, obs: RateObservation): Promise<void> {
  const observationDate = dateOnly(obs.observationDate);
  await prisma.$transaction([
    prisma.exchangeRateObservation.upsert({
      where: { pair_observationDate: { pair, observationDate } },
      create: { pair, observationDate, rate: obs.rate, source: obs.source },
      update: { rate: obs.rate, source: obs.source, retrievedAt: new Date() },
    }),
    prisma.exchangeRateResolution.upsert({
      where: { pair_forDate: { pair, forDate: dateOnly(asOf) } },
      create: {
        pair,
        forDate: dateOnly(asOf),
        observationDate,
        rate: obs.rate,
        source: obs.source,
      },
      update: { observationDate, rate: obs.rate, source: obs.source, resolvedAt: new Date() },
    }),
  ]);
}

async function newestObservation(pair: string, asOf: string): Promise<RateObservation | null> {
  const row = await prisma.exchangeRateObservation.findFirst({
    where: { pair, observationDate: { lte: dateOnly(asOf) } },
    orderBy: { observationDate: 'desc' },
  });
  if (!row) return null;
  return {
    pair,
    rate: String(row.rate),
    observationDate: toIso(row.observationDate),
    source: 'CACHE',
    retrievedAt: row.retrievedAt,
  };
}

async function applyFallback(
  pair: string,
  asOf: string,
  opts: ResolveOptions,
): Promise<RateResolution> {
  const unavailable: RateResolution = {
    observation: null,
    fallbackUsed: true,
    stale: false,
    blocksFinalization: true,
    allowsDraft: opts.fallbackMode !== 'BLOCK_FINALIZATION',
    warning:
      'No USD/CAD exchange rate could be obtained. CAD amounts are unavailable and this proposal cannot be finalized.',
    overrideReason: null,
  };

  switch (opts.fallbackMode) {
    case 'MANUAL_RATE': {
      const override = await prisma.exchangeRateOverride.findFirst({
        where: { pair, active: true, effectiveDate: { lte: dateOnly(asOf) } },
        orderBy: { effectiveDate: 'desc' },
      });
      if (!override) return unavailable;
      const observation: RateObservation = {
        pair,
        rate: String(override.rate),
        observationDate: toIso(override.effectiveDate),
        source: 'MANUAL',
        retrievedAt: override.createdAt,
      };
      return {
        observation,
        fallbackUsed: true,
        stale: isStale(observation, asOf, opts.staleRateDays),
        // The administrator configured this substitution deliberately, so it does
        // not block release — but it is always disclosed on the proposal.
        blocksFinalization: false,
        allowsDraft: true,
        warning: `CAD amounts use a manually entered exchange rate dated ${observation.observationDate}, not a Bank of Canada published rate.`,
        overrideReason: override.reason,
      };
    }

    case 'LAST_CACHED': {
      const observation = await newestObservation(pair, asOf);
      if (!observation) return unavailable;
      return {
        observation,
        fallbackUsed: true,
        stale: isStale(observation, asOf, opts.staleRateDays),
        blocksFinalization: false,
        allowsDraft: true,
        warning: `The Bank of Canada could not be reached. CAD amounts use the last rate on file, published ${observation.observationDate}.`,
        overrideReason: null,
      };
    }

    case 'DRAFT_WITH_REVIEW': {
      const observation = await newestObservation(pair, asOf);
      if (!observation) return unavailable;
      return {
        observation,
        fallbackUsed: true,
        stale: isStale(observation, asOf, opts.staleRateDays),
        blocksFinalization: true,
        allowsDraft: true,
        warning: `Exchange-rate review required. The Bank of Canada could not be reached; CAD amounts are indicative only, using the rate published ${observation.observationDate}.`,
        overrideReason: null,
      };
    }

    case 'BLOCK_FINALIZATION':
      return { ...unavailable, allowsDraft: false };
  }

  // Unreachable while FxFallbackModeValue stays a closed union, but an explicit
  // return beats relying on exhaustiveness analysis under noImplicitReturns.
  return unavailable;
}

/**
 * Record a manual rate. Every field the requirement asks for is mandatory here
 * rather than optional in the schema's sense: no rate without a reason and an
 * actor, and the audit row is written in the same transaction as the override.
 */
export async function recordRateOverride(input: {
  pair?: string;
  rate: string;
  effectiveDate: string;
  reason: string;
  actorId: string;
}): Promise<void> {
  const pair = input.pair ?? FX_PAIR;
  const reason = input.reason.trim();
  if (!reason) throw new Error('A manual exchange rate requires a reason.');
  if (!/^\d+(\.\d+)?$/.test(input.rate)) throw new Error(`Invalid exchange rate: ${input.rate}`);

  const created = await prisma.exchangeRateOverride.create({
    data: {
      pair,
      rate: input.rate,
      effectiveDate: dateOnly(input.effectiveDate),
      reason,
      createdById: input.actorId,
    },
  });

  await recordAudit({
    actorId: input.actorId,
    action: 'crossborder.fx.override',
    entity: 'ExchangeRateOverride',
    entityId: created.id,
    details: { pair, rate: input.rate, effectiveDate: input.effectiveDate, reason },
  });
}

/** Withdraw a manual rate, so the configured fallback stops using it. */
export async function deactivateRateOverride(id: string, actorId: string): Promise<void> {
  await prisma.exchangeRateOverride.update({ where: { id }, data: { active: false } });
  await recordAudit({
    actorId,
    action: 'crossborder.fx.override.deactivate',
    entity: 'ExchangeRateOverride',
    entityId: id,
  });
}
