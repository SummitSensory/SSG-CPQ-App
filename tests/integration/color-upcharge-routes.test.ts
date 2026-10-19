import { describe, it, expect, beforeAll, vi } from 'vitest';
/**
 * Who may bill the Prismatic upcharge. Mounted without a database, like
 * qbo-routes.test.ts: the role comes from the synthetic user id, and the billing
 * functions are stubbed so a request that gets past authorization says so with 200.
 */
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
  },
}));
vi.mock('../../src/integrations/quickbooks/colorUpcharge.js', () => ({
  colorUpchargeState: vi.fn(async () => ({ status: 'TO_BILL' })),
  colorUpchargePreview: vi.fn(async () => ({ mode: 'AMEND' })),
  pushColorUpcharge: vi.fn(async () => ({ mode: 'AMEND' })),
  markColorUpchargeHandled: vi.fn(async () => ({ status: 'BILLED' })),
  unbilledColorUpcharges: vi.fn(async () => []),
}));

import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerColorUpchargeRoutes } = await import('../../src/routes/colorUpcharge.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerColorUpchargeRoutes(app);
  await app.ready();
  return app;
}

async function as(role: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  const app = await makeApp();
  const res = await app.inject({
    method,
    url,
    headers: { authorization: 'Bearer ' + (await signAccessToken({ sub: 'user-' + role, role })) },
    ...(payload ? { payload } : {}),
  });
  await app.close();
  return res.statusCode;
}

const PUSH = {
  expectedCurrentTotalMinor: '1',
  expectedNewTotalMinor: '2',
  expectedChargeMinor: '1',
};

describe('Prismatic upcharge routes — authorization', () => {
  it('anyone who can read orders sees where it stands', async () => {
    expect(await as('SALES_REP', 'GET', '/orders/o1/color-upcharge')).toBe(200);
  });

  it('billing it is held by Accounting, Operations and Executive — not sales', async () => {
    for (const role of ['ACCOUNTING', 'OPERATIONS', 'EXECUTIVE', 'SYSTEM_ADMIN']) {
      expect(await as(role, 'POST', '/orders/o1/color-upcharge/push', PUSH)).toBe(200);
    }
    for (const role of ['SALES_REP', 'SALES_MANAGER', 'PROJECT_MANAGER', 'READ_ONLY']) {
      expect(await as(role, 'POST', '/orders/o1/color-upcharge/push', PUSH)).toBe(403);
      expect(
        await as(role, 'POST', '/orders/o1/color-upcharge/handled', {
          note: 'by hand',
          expectedChargeMinor: '1',
        }),
      ).toBe(403);
    }
  });

  it('the push needs the confirmed figures from the preview', async () => {
    expect(
      await as('ACCOUNTING', 'POST', '/orders/o1/color-upcharge/push', {
        expectedChargeMinor: '1',
      }),
    ).toBe(400);
  });

  it('recording it as handled by hand needs a note', async () => {
    expect(
      await as('ACCOUNTING', 'POST', '/orders/o1/color-upcharge/handled', {
        note: '',
        expectedChargeMinor: '1',
      }),
    ).toBe(400);
  });
});
