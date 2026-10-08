import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Audit: /pricing routes (src/routes/pricing.ts), mounted without a database — Prisma
 * is mocked (user lookup for requireAuth, and a stored PriceSnapshot for the read
 * route). Checks that cost and margin stay hidden from roles without COSTS_READ /
 * MARGINS_READ, and that schema-valid input cannot crash the engine.
 */

const storedSnapshot = {
  id: 'snap-1',
  subjectRef: 'deal-1',
  currency: 'USD',
  engineVersion: '1.0.0',
  input: {
    currency: 'USD',
    lines: [{ ref: 'L1', productId: 'P1', quantity: 1, unitPrice: '10000', unitCost: '6000' }],
  },
  breakdown: {
    lines: [{ ref: 'L1', net: '10000', cost: '6000', margin: '4000', marginBps: 4000 }],
    totalCost: '6000',
    totalMargin: '4000',
    marginBps: 4000,
    grandTotal: '10000',
  },
  grandTotal: 10000n,
  incomplete: false,
  createdById: 'user-SALES_MANAGER',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
    priceSnapshot: { findMany: async () => [storedSnapshot] },
  },
}));

let app: FastifyInstance;

async function tokenFor(role: string): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub: 'user-' + role, role });
}

beforeAll(async () => {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerPricingRoutes } = await import('../../src/routes/pricing.js');
  app = Fastify();
  registerErrorHandler(app);
  registerPricingRoutes(app);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const baseQuote = {
  currency: 'USD',
  lines: [
    {
      ref: 'L1',
      productId: 'P1',
      quantity: 1,
      unitPrice: '100.00',
      unitCost: '60.00',
      priceSource: 'price-list',
    },
  ],
};

describe('/pricing — role-scoped visibility (PASS)', () => {
  it('a SALES_REP quote has cost and margin fields stripped', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pricing/quote',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
      payload: baseQuote,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCost).toBeUndefined();
    expect(body.marginBps).toBeUndefined();
    expect(body.lines[0].cost).toBeUndefined();
    expect(body.lines[0].margin).toBeUndefined();
    expect(body.grandTotal).toBe('10000');
  });

  it('a SALES_MANAGER sees cost and margin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pricing/quote',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) },
      payload: baseQuote,
    });
    expect(res.json().marginBps).toBe(4000);
  });

  it('rejects a three-decimal money string and a fractional quantity with 400', async () => {
    for (const bad of [
      { ...baseQuote, lines: [{ ...baseQuote.lines[0], unitPrice: '1.005' }] },
      { ...baseQuote, lines: [{ ...baseQuote.lines[0], quantity: 1.5 }] },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/pricing/quote',
        headers: { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) },
        payload: bad,
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('/pricing — fixed defects (formerly it.fails)', () => {
  it('BUG: the margin-threshold finding message leaks the margin % to a role without MARGINS_READ', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pricing/quote',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
      payload: { ...baseQuote, thresholds: { minMarginBps: 5000 } },
    });
    expect(res.statusCode).toBe(200);
    // marginBps is deleted from the body, but findings[].message still reads
    // "Margin 4000 bps below threshold 5000 bps — approval required."
    expect(JSON.stringify(res.json().findings)).not.toMatch(/4000/);
  });

  it('BUG: GET /pricing/snapshots/:ref returns unit cost and margin to a role without COSTS_READ', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pricing/snapshots/deal-1',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
    });
    expect(res.statusCode).toBe(200);
    const text = res.body;
    expect(text).not.toMatch(/unitCost|totalCost|"margin"/);
  });

  it('BUG: fractional mileage (schema allows any non-negative number) returns 500 instead of a price or a 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pricing/quote',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) },
      payload: {
        ...baseQuote,
        fees: { mileage: { miles: 12.5, ratePerMile: '0.70', confirmed: true } },
      },
    });
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe('/pricing — authorization and server-owned thresholds (fix follow-ups)', () => {
  it('GET /pricing/snapshots/:ref is a 403 (not a 400) for a role without pricing:read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pricing/snapshots/deal-1',
      headers: { authorization: 'Bearer ' + (await tokenFor('INSTALLER')) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a SALES_MANAGER still reads cost and margin on a stored snapshot', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pricing/snapshots/deal-1',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].input.lines[0].unitCost).toBe('6000');
    expect(res.json()[0].breakdown.totalMargin).toBe('4000');
  });

  it('persist:true needs proposal:write — a READ_ONLY quote may compute but not store', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pricing/quote',
      headers: { authorization: 'Bearer ' + (await tokenFor('READ_ONLY')) },
      payload: { ...baseQuote, persist: true, subjectRef: 'deal-1' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a request can tighten but not loosen the server discount authority', async () => {
    const prev = process.env.PRICING_DISCOUNT_AUTHORITY_BPS;
    process.env.PRICING_DISCOUNT_AUTHORITY_BPS = '1000';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/pricing/quote',
        headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
        payload: {
          ...baseQuote,
          lines: [{ ...baseQuote.lines[0], lineDiscountBps: 2000 }],
          thresholds: { discountAuthorityBps: 10000 },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().requiresApproval).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PRICING_DISCOUNT_AUTHORITY_BPS;
      else process.env.PRICING_DISCOUNT_AUTHORITY_BPS = prev;
    }
  });

  it('a line discount above 100% is refused at the route with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pricing/quote',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_MANAGER')) },
      payload: { ...baseQuote, lines: [{ ...baseQuote.lines[0], lineDiscountBps: 15000 }] },
    });
    expect(res.statusCode).toBe(400);
  });
});
