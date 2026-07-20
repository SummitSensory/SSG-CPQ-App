import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computePricing } from '../../src/pricing/engine.js';

/**
 * Regression suite against ANONYMIZED, APPROVED historical proposals.
 * Drop fixtures in ./fixtures/*.json (see README.md for the format). Each fixture
 * provides the pricing input and the known-good expected totals. If no fixtures
 * are present the suite is skipped — meaning historical reproduction has NOT yet
 * been demonstrated. Do not treat a skipped suite as a pass.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');

interface Fixture {
  name: string;
  input: unknown;
  expected: { grandTotal: string; tax?: string; goodsNet?: string; marginBps?: number };
}

function reviveBigints(obj: unknown): unknown {
  return JSON.parse(JSON.stringify(obj), (_k, v) =>
    typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  );
}

const files = existsSync(fixturesDir) ? readdirSync(fixturesDir).filter((f) => f.endsWith('.json')) : [];

describe('historical proposal regression', () => {
  if (files.length === 0) {
    it.skip('no fixtures present — historical totals NOT yet reproduced', () => {});
    return;
  }
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as Fixture;
    it(`reproduces ${fixture.name}`, () => {
      const input = reviveBigints(fixture.input) as Parameters<typeof computePricing>[0];
      const r = computePricing(input);
      expect(r.grandTotal.toString()).toBe(fixture.expected.grandTotal);
      if (fixture.expected.tax !== undefined) expect(r.tax.toString()).toBe(fixture.expected.tax);
      if (fixture.expected.goodsNet !== undefined) expect(r.goodsNet.toString()).toBe(fixture.expected.goodsNet);
      if (fixture.expected.marginBps !== undefined) expect(r.marginBps).toBe(fixture.expected.marginBps);
    });
  }
});
