import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * src/lib/dbRetry.ts — riding out a briefly unreachable database.
 *
 * 2026-10-22 14:01 UTC: /cron/esign-reminders' repair sweep died on P1001
 * ("Can't reach database server" at the Neon pooler) and alerted, and the day's
 * sweep was lost. Transient connectivity errors are now retried; everything else
 * throws exactly as before. No database, no real waiting — sleep is stubbed.
 */

const h = vi.hoisted(() => ({ sleeps: [] as number[], queryRaw: vi.fn() }));

vi.mock('node:timers/promises', () => ({
  setTimeout: async (ms: number) => {
    h.sleeps.push(ms);
  },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/lib/prisma.js', () => ({ prisma: { $queryRaw: h.queryRaw } }));

const { isTransientDbError, withDbRetry, ensureDbReachable } =
  await import('../../src/lib/dbRetry.js');

/** Shaped like Prisma's PrismaClientKnownRequestError. */
function knownError(code: string): Error {
  return Object.assign(new Error(`prisma ${code}`), {
    name: 'PrismaClientKnownRequestError',
    code,
  });
}
/** Shaped like Prisma's PrismaClientInitializationError. */
function initError(errorCode: string): Error {
  return Object.assign(new Error(`init ${errorCode}`), {
    name: 'PrismaClientInitializationError',
    errorCode,
  });
}

beforeEach(() => {
  h.sleeps.length = 0;
  h.queryRaw.mockReset();
});

describe('isTransientDbError', () => {
  it.each(['P1001', 'P1002', 'P1008', 'P1017'])('%s on a request error is transient', (code) => {
    expect(isTransientDbError(knownError(code))).toBe(true);
  });

  it('P1001 on an initialization error (errorCode) is transient', () => {
    expect(isTransientDbError(initError('P1001'))).toBe(true);
  });

  it.each(['P2022', 'P2002', 'P2025', 'P1000', 'P1003'])('%s is not transient', (code) => {
    expect(isTransientDbError(knownError(code))).toBe(false);
  });

  it('plain errors and non-errors are not transient', () => {
    expect(isTransientDbError(new Error("Can't reach database server"))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError('P1001')).toBe(false);
  });
});

describe('withDbRetry', () => {
  it('retries a transient failure and returns the eventual result', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(knownError('P1001'))
      .mockRejectedValueOnce(initError('P1001'))
      .mockResolvedValueOnce('ok');

    await expect(withDbRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(h.sleeps).toEqual([2_000, 5_000]);
  });

  it('throws the last error once a transient failure outlasts every attempt', async () => {
    const last = knownError('P1017');
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(knownError('P1001'))
      .mockRejectedValueOnce(knownError('P1002'))
      .mockRejectedValueOnce(last);

    await expect(withDbRetry(fn)).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('honours custom delays (attempts = delays + 1)', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(knownError('P1001'));
    await expect(withDbRetry(fn, { delaysMs: [10] })).rejects.toMatchObject({ code: 'P1001' });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(h.sleeps).toEqual([10]);
  });

  it('throws a non-transient error immediately, without retrying', async () => {
    const bad = knownError('P2022');
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(bad);

    await expect(withDbRetry(fn)).rejects.toBe(bad);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it('does not retry a success', async () => {
    const fn = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    await expect(withDbRetry(fn)).resolves.toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('ensureDbReachable', () => {
  it('probes with SELECT 1 and waits out a cold database', async () => {
    h.queryRaw.mockRejectedValueOnce(knownError('P1001')).mockResolvedValueOnce([{ x: 1 }]);
    await expect(ensureDbReachable('test')).resolves.toBeUndefined();
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
  });

  it('throws when the database stays unreachable', async () => {
    h.queryRaw.mockRejectedValue(knownError('P1001'));
    await expect(ensureDbReachable('test')).rejects.toMatchObject({ code: 'P1001' });
    expect(h.queryRaw).toHaveBeenCalledTimes(3);
  });
});
