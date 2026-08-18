import { describe, it, expect, beforeEach } from 'vitest';
import { hit, reset, clearAll, AUTH_RULES } from '../../src/lib/rateLimit.js';

/** PROPOSAL-003 — the auth endpoints had no throttle of any kind. */
describe('auth rate limiting', () => {
  beforeEach(() => clearAll());

  it('allows attempts up to the limit and refuses the next one', () => {
    const rule = { limit: 3, windowMs: 60_000 };
    expect(hit('k', rule).allowed).toBe(true);
    expect(hit('k', rule).allowed).toBe(true);
    expect(hit('k', rule).allowed).toBe(true);
    const blocked = hit('k', rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it('opens a fresh window once the old one has passed', () => {
    const rule = { limit: 1, windowMs: 1_000 };
    const t0 = 1_000_000;
    expect(hit('k', rule, t0).allowed).toBe(true);
    expect(hit('k', rule, t0 + 500).allowed).toBe(false);
    expect(hit('k', rule, t0 + 1_500).allowed).toBe(true);
  });

  it('keeps buckets independent, so one IP cannot lock out another', () => {
    const rule = { limit: 1, windowMs: 60_000 };
    expect(hit('login:ip:1.1.1.1', rule).allowed).toBe(true);
    expect(hit('login:ip:1.1.1.1', rule).allowed).toBe(false);
    expect(hit('login:ip:2.2.2.2', rule).allowed).toBe(true);
  });

  it('clears a bucket on success so typos cost a real user nothing', () => {
    const rule = { limit: 2, windowMs: 60_000 };
    hit('login:id:kari@example.com', rule);
    hit('login:id:kari@example.com', rule);
    reset('login:id:kari@example.com');
    expect(hit('login:id:kari@example.com', rule).allowed).toBe(true);
  });

  it('ships with limits that are actually restrictive', () => {
    expect(AUTH_RULES.login.limit).toBeLessThanOrEqual(10);
    expect(AUTH_RULES.forgot.limit).toBeLessThanOrEqual(5);
    expect(AUTH_RULES.login.windowMs).toBeGreaterThanOrEqual(60_000);
  });
});
