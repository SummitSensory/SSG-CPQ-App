import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the exchange-rate layer promises, tested at the seam where it decides.
 *
 * `fx.test.ts` covers reading the Bank of Canada and converting money. This file
 * covers the three things `rateService` owns and `fx.ts` must not: when to skip the
 * network, what to do when the network fails, and what gets written down. Every one
 * of those is a decision about a quote a customer will hold Summit to, so each is
 * asserted rather than assumed:
 *
 *  - a date resolves once, and the same date always returns the same rate;
 *  - a manual rate is never cached and never silent;
 *  - a fallback is never cached, so the Bank is tried again next time;
 *  - a rate nobody can produce blocks release rather than quoting zero.
 *
 * Prisma and the audit log are mocked. Nothing here touches a database or a network.
 */

const db = vi.hoisted(() => ({
  exchangeRateResolution: { findUnique: vi.fn(), upsert: vi.fn() },
  exchangeRateObservation: { findFirst: vi.fn(), upsert: vi.fn() },
  exchangeRateOverride: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));
const audit = vi.hoisted(() => ({ recordAudit: vi.fn() }));

vi.mock('../../src/lib/prisma.js', () => ({ prisma: db }));
vi.mock('../../src/lib/audit.js', () => ({ recordAudit: audit.recordAudit }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  deactivateRateOverride,
  recordRateOverride,
  resolveRateForDate,
  type FxFallbackModeValue,
} from '../../src/crossborder/rateService.js';
import type { ExchangeRateProvider, RateObservation } from '../../src/crossborder/fx.js';

const ASOF = '2026-08-21';

function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** A provider that answers with whatever the test hands it. */
function provider(answer: RateObservation | null | Error): ExchangeRateProvider {
  return {
    name: 'test',
    observationOnOrBefore: vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
}

function published(observationDate: string, rate = '1.3721'): RateObservation {
  return {
    pair: 'USD/CAD',
    rate,
    observationDate,
    source: 'BANK_OF_CANADA',
    retrievedAt: utc(observationDate),
  };
}

function opts(
  fallbackMode: FxFallbackModeValue,
  p: ExchangeRateProvider,
  staleRateDays = 7,
): Parameters<typeof resolveRateForDate>[1] {
  return { provider: p, fallbackMode, staleRateDays };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.exchangeRateResolution.findUnique.mockResolvedValue(null);
  db.exchangeRateObservation.findFirst.mockResolvedValue(null);
  db.exchangeRateOverride.findFirst.mockResolvedValue(null);
  db.$transaction.mockImplementation(async (ops: unknown[]) => ops);
});

describe('resolving a rate for a date', () => {
  it('answers from the resolution cache without calling the Bank', async () => {
    db.exchangeRateResolution.findUnique.mockResolvedValue({
      pair: 'USD/CAD',
      rate: '1.3699',
      observationDate: utc('2026-08-20'),
      source: 'BANK_OF_CANADA',
      resolvedAt: utc('2026-08-21'),
    });
    const p = provider(published('2026-08-20'));

    const r = await resolveRateForDate(ASOF, opts('LAST_CACHED', p));

    expect(p.observationOnOrBefore).not.toHaveBeenCalled();
    expect(r.observation?.rate).toBe('1.3699');
    expect(r.fallbackUsed).toBe(false);
    expect(r.blocksFinalization).toBe(false);
    expect(r.warning).toBeNull();
  });

  it('caches a published rate against the date it was needed for, not the date it was published', async () => {
    const p = provider(published('2026-08-20'));

    const r = await resolveRateForDate(ASOF, opts('LAST_CACHED', p));

    expect(r.observation?.source).toBe('BANK_OF_CANADA');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // The resolution is keyed on the proposal date; the observation on the Bank's
    // publication date. Collapsing the two is what makes a Monday proposal either
    // re-fetch on every page view or quote Friday as though it were Monday.
    const [call] = db.exchangeRateResolution.upsert.mock.calls;
    expect(call?.[0].where.pair_forDate.forDate).toEqual(utc(ASOF));
    expect(call?.[0].create.observationDate).toEqual(utc('2026-08-20'));
    const [obsCall] = db.exchangeRateObservation.upsert.mock.calls;
    expect(obsCall?.[0].where.pair_observationDate.observationDate).toEqual(utc('2026-08-20'));
  });

  it('discloses a stale published rate but still lets the proposal go out', async () => {
    const p = provider(published('2026-08-05'));

    const r = await resolveRateForDate(ASOF, opts('LAST_CACHED', p, 7));

    // It IS the latest thing the Bank published — over a holiday week that is the
    // correct rate to quote. Disclosed, not refused.
    expect(r.stale).toBe(true);
    expect(r.blocksFinalization).toBe(false);
    expect(r.allowsDraft).toBe(true);
    expect(r.warning).toContain('2026-08-05');
  });

  it('does not cache a manual rate handed back by the provider, and warns about it', async () => {
    const manual: RateObservation = {
      pair: 'USD/CAD',
      rate: '1.4000',
      observationDate: '2026-08-18',
      source: 'MANUAL',
      retrievedAt: utc('2026-08-18'),
    };

    const r = await resolveRateForDate(ASOF, opts('MANUAL_RATE', provider(manual)));

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(r.warning).toContain('manually entered');
    expect(r.observation?.source).toBe('MANUAL');
  });
});

describe('when the Bank cannot be reached', () => {
  it('quotes the last rate on file under LAST_CACHED, and says so', async () => {
    db.exchangeRateObservation.findFirst.mockResolvedValue({
      rate: '1.3610',
      observationDate: utc('2026-08-19'),
      retrievedAt: utc('2026-08-19'),
    });

    const r = await resolveRateForDate(
      ASOF,
      opts('LAST_CACHED', provider(new Error('valet unreachable'))),
    );

    expect(r.fallbackUsed).toBe(true);
    expect(r.observation?.source).toBe('CACHE');
    expect(r.observation?.rate).toBe('1.3610');
    expect(r.blocksFinalization).toBe(false);
    expect(r.warning).toContain('2026-08-19');
    // A fallback is never written as a resolution: the next read tries the Bank again.
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('permits a draft but holds release under DRAFT_WITH_REVIEW', async () => {
    db.exchangeRateObservation.findFirst.mockResolvedValue({
      rate: '1.3610',
      observationDate: utc('2026-08-19'),
      retrievedAt: utc('2026-08-19'),
    });

    const r = await resolveRateForDate(
      ASOF,
      opts('DRAFT_WITH_REVIEW', provider(new Error('valet unreachable'))),
    );

    expect(r.allowsDraft).toBe(true);
    expect(r.blocksFinalization).toBe(true);
    expect(r.warning).toContain('review');
  });

  it('uses the administrator’s manual rate under MANUAL_RATE, carrying the reason', async () => {
    db.exchangeRateOverride.findFirst.mockResolvedValue({
      rate: '1.3800',
      effectiveDate: utc('2026-08-15'),
      reason: 'Valet API unreachable — rate from the Bank’s daily page',
      createdAt: utc('2026-08-15'),
    });

    const r = await resolveRateForDate(
      ASOF,
      opts('MANUAL_RATE', provider(new Error('valet unreachable'))),
    );

    expect(r.observation?.rate).toBe('1.3800');
    expect(r.observation?.source).toBe('MANUAL');
    // Configured deliberately, so it does not block — but it is always disclosed.
    expect(r.blocksFinalization).toBe(false);
    expect(r.warning).toContain('manually entered');
    expect(r.overrideReason).toContain('Valet API unreachable');
  });

  it('blocks rather than quoting zero when MANUAL_RATE is configured and no rate was entered', async () => {
    const r = await resolveRateForDate(
      ASOF,
      opts('MANUAL_RATE', provider(new Error('valet unreachable'))),
    );

    expect(r.observation).toBeNull();
    expect(r.blocksFinalization).toBe(true);
    expect(r.allowsDraft).toBe(true);
    expect(r.warning).toContain('cannot be finalized');
  });

  it('withholds the draft entirely under BLOCK_FINALIZATION', async () => {
    const r = await resolveRateForDate(
      ASOF,
      opts('BLOCK_FINALIZATION', provider(new Error('valet unreachable'))),
    );

    expect(r.observation).toBeNull();
    expect(r.allowsDraft).toBe(false);
    expect(r.blocksFinalization).toBe(true);
  });

  it('treats an empty publication window as no answer, not as an error', async () => {
    db.exchangeRateObservation.findFirst.mockResolvedValue({
      rate: '1.3610',
      observationDate: utc('2026-08-19'),
      retrievedAt: utc('2026-08-19'),
    });

    // A successful call that published nothing in the window: no throw, but no rate
    // either, so the configured fallback still applies.
    const r = await resolveRateForDate(ASOF, opts('LAST_CACHED', provider(null)));

    expect(r.fallbackUsed).toBe(true);
    expect(r.observation?.source).toBe('CACHE');
  });

  it('never throws out of a provider failure', async () => {
    await expect(
      resolveRateForDate(ASOF, opts('LAST_CACHED', provider(new Error('boom')))),
    ).resolves.toBeTruthy();
  });
});

describe('recording a manual rate', () => {
  beforeEach(() => {
    db.exchangeRateOverride.create.mockResolvedValue({ id: 'ovr_1' });
  });

  it('writes the override and the audit row together', async () => {
    await recordRateOverride({
      rate: '1.3800',
      effectiveDate: '2026-08-15',
      reason: '  Valet API unreachable  ',
      actorId: 'user_1',
    });

    const data = db.exchangeRateOverride.create.mock.calls[0]?.[0].data;
    expect(data.rate).toBe('1.3800');
    expect(data.effectiveDate).toEqual(utc('2026-08-15'));
    expect(data.reason).toBe('Valet API unreachable');
    expect(data.createdById).toBe('user_1');
    expect(audit.recordAudit).toHaveBeenCalledTimes(1);
    expect(audit.recordAudit.mock.calls[0]?.[0]).toMatchObject({
      actorId: 'user_1',
      action: 'crossborder.fx.override',
      entityId: 'ovr_1',
    });
  });

  it('refuses a rate with no reason against it', async () => {
    await expect(
      recordRateOverride({
        rate: '1.38',
        effectiveDate: '2026-08-15',
        reason: '   ',
        actorId: 'u',
      }),
    ).rejects.toThrow(/requires a reason/i);
    expect(db.exchangeRateOverride.create).not.toHaveBeenCalled();
  });

  it('refuses a rate that is not a number', async () => {
    for (const rate of ['1.38.2', 'one', '', '-1.38', '1,38']) {
      await expect(
        recordRateOverride({ rate, effectiveDate: '2026-08-15', reason: 'outage', actorId: 'u' }),
      ).rejects.toThrow(/invalid exchange rate/i);
    }
    expect(db.exchangeRateOverride.create).not.toHaveBeenCalled();
  });

  it('withdrawing one is audited too', async () => {
    db.exchangeRateOverride.update.mockResolvedValue({ id: 'ovr_1' });

    await deactivateRateOverride('ovr_1', 'user_2');

    expect(db.exchangeRateOverride.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'ovr_1' },
      data: { active: false },
    });
    expect(audit.recordAudit.mock.calls[0]?.[0]).toMatchObject({
      actorId: 'user_2',
      action: 'crossborder.fx.override.deactivate',
    });
  });
});
