import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * GET /proposals and GET /reports/proposals read only each proposal's LATEST version.
 *
 * Both used to load every version of every proposal — sections, items and (for the
 * report) status history — and use the first. They are the Proposals screen and the
 * dashboard's first request, so their cost grew with every revision ever saved. These
 * pin the narrower read: `take: 1` on versions, the count from `_count`, and (for the
 * list) only the `meta` section on the wire, since that and the items are all the list
 * reads.
 */

const findManyCalls: Array<Record<string, unknown>> = [];

const LATEST = {
  id: 'v3',
  proposalId: 'p1',
  version: 3,
  status: 'RELEASED',
  frozen: true,
  releasedAt: new Date('2026-10-01'),
  expirationDate: null,
  createdAt: new Date('2026-10-01'),
  updatedAt: new Date('2026-10-02'),
  createdById: 'user-SALES_REP',
  sections: [
    { id: 'meta', type: 'CUSTOMER_INFO', data: { contactName: 'Pat', projectId: '4821' } },
    { id: 'body', type: 'TEXT', data: { html: 'x'.repeat(5000) } },
  ],
  items: [{ lineType: 'PRODUCT', name: 'Frame', quantity: 1, rateMinor: 100000 }],
  statusHistory: [],
};

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
      findMany: async () => [{ id: 'user-SALES_REP', name: 'Rep', email: 'rep@example.test' }],
    },
    proposal: {
      findMany: async (args: Record<string, unknown>) => {
        findManyCalls.push(args);
        return [
          {
            id: 'p1',
            number: 'P-1',
            title: 'Gym',
            organizationId: 'org1',
            createdById: 'user-SALES_REP',
            currentVersion: 3,
            archivedAt: null,
            archivedById: null,
            archiveReason: null,
            createdAt: new Date('2026-09-01'),
            updatedAt: new Date('2026-10-02'),
            versions: [LATEST],
            _count: { versions: 3 },
          },
        ];
      },
    },
    organization: {
      findMany: async () => [{ id: 'org1', name: 'Acme Gym', customerType: 'SCHOOL' }],
    },
    qboTransaction: { findMany: async () => [] },
  },
}));

import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

async function auth(): Promise<Record<string, string>> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return {
    authorization:
      'Bearer ' + (await signAccessToken({ sub: 'user-SALES_REP', role: 'SALES_REP' })),
  };
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerProposalRoutes } = await import('../../src/routes/proposals.js');
  const { registerReportRoutes } = await import('../../src/routes/reports.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerProposalRoutes(app);
  registerReportRoutes(app);
  await app.ready();
  return app;
}

describe('proposal lists read only the latest version', () => {
  // Built once: importing the route modules is slow on a loaded runner, and a test that
  // timed out mid-request would push its call into the next test's capture.
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  }, 60_000);
  afterAll(async () => {});

  it('GET /proposals asks for one version and sends only its meta section', async () => {
    findManyCalls.length = 0;
    const res = await app.inject({ method: 'GET', url: '/proposals', headers: await auth() });
    expect(res.statusCode).toBe(200);

    const include = findManyCalls[0]!.include as {
      versions: { take?: number };
      _count?: unknown;
    };
    expect(include.versions.take).toBe(1);
    expect(include._count).toEqual({ select: { versions: true } });

    const [row] = res.json() as Array<{
      versionCount: number;
      versions: Array<{ id: string; sections: Array<{ id: string }>; items: unknown[] }>;
      _count?: unknown;
    }>;
    expect(row!.versionCount).toBe(3);
    expect(row!._count).toBeUndefined();
    expect(row!.versions).toHaveLength(1);
    expect(row!.versions[0]!.id).toBe('v3');
    // The body section is gone; meta (contact, Project ID, freight/tax) and the items
    // — what the list's total is computed from — are still there.
    expect(row!.versions[0]!.sections.map((s) => s.id)).toEqual(['meta']);
    expect(row!.versions[0]!.items).toHaveLength(1);
  });

  it('GET /reports/proposals asks for one version and counts the rest', async () => {
    findManyCalls.length = 0;
    const res = await app.inject({
      method: 'GET',
      url: '/reports/proposals',
      headers: await auth(),
    });
    expect(res.statusCode).toBe(200);
    const include = findManyCalls[0]!.include as {
      versions: { take?: number; include?: unknown };
      _count?: unknown;
    };
    expect(include.versions.take).toBe(1);
    expect(include.versions.include).toBeTruthy(); // status history still read, for decidedAt
    expect(include._count).toEqual({ select: { versions: true } });
  });
});
