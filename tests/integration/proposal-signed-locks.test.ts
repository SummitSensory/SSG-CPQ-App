import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
/**
 * "Proposal Signed" marks the version ACCEPTED and locks it into its operational
 * order in one request, so a signed proposal cannot be left unlocked.
 *
 * Mounted without a database, like proposals-authz: the status change, the CAD
 * freeze and the order creation are mocked, and the tests assert which of them run
 * and in what circumstances — above all that nothing changes status when the
 * approval details needed for the lock are missing.
 */
const changeStatus = vi.fn();
const createAcceptedOrder = vi.fn();
const freezeCrossBorderSnapshot = vi.fn();

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
vi.mock('../../src/proposals/service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/proposals/service.js')>()),
  changeStatus: (...a: unknown[]) => changeStatus(...a),
}));
vi.mock('../../src/handoff/service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/handoff/service.js')>()),
  createAcceptedOrder: (...a: unknown[]) => createAcceptedOrder(...a),
}));
vi.mock('../../src/crossborder/snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/crossborder/snapshot.js')>()),
  freezeCrossBorderSnapshot: (...a: unknown[]) => freezeCrossBorderSnapshot(...a),
}));

import type { FastifyInstance } from 'fastify';

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
  // The proposal routes pull in most of the app; importing them cold under a
  // parallel run can outlast the first test's timeout, whose request then lands
  // in the next test after the mocks were reset. Pay for it here instead.
  await import('../../src/routes/proposals.js');
}, 60_000);

beforeEach(() => {
  changeStatus.mockReset().mockResolvedValue({ warnings: [] });
  createAcceptedOrder.mockReset().mockResolvedValue({ id: 'ord-1', number: 'SO-1001' });
  freezeCrossBorderSnapshot.mockReset().mockResolvedValue(undefined);
});

async function tokenFor(role: string): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub: 'user-' + role, role });
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerProposalRoutes } = await import('../../src/routes/proposals.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerProposalRoutes(app);
  await app.ready();
  return app;
}

const approval = {
  method: 'COUNTERSIGNED_PROPOSAL',
  approverName: 'Pat Customer',
  approvedAt: '2026-09-22T00:00:00.000Z',
  trainingIncluded: true,
  installationIncluded: false,
};

async function sign(role: string, body: unknown) {
  const app = await makeApp();
  const res = await app.inject({
    method: 'POST',
    url: '/proposals/versions/v1/accept',
    headers: { authorization: 'Bearer ' + (await tokenFor(role)) },
    payload: body as object,
  });
  await app.close();
  return res;
}

describe('Proposal Signed locks the order', () => {
  it('accepts, freezes CAD, then creates the order with the approval details', async () => {
    const res = await sign('SALES_MANAGER', { approval });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ACCEPTED',
      locked: true,
      order: { id: 'ord-1', number: 'SO-1001' },
    });
    expect(changeStatus).toHaveBeenCalledWith('v1', 'ACCEPTED', 'user-SALES_MANAGER', undefined);
    expect(createAcceptedOrder).toHaveBeenCalledTimes(1);
    const [vid, appr] = createAcceptedOrder.mock.calls[0] as [string, Record<string, unknown>];
    expect(vid).toBe('v1');
    expect(appr.approverName).toBe('Pat Customer');
    expect(appr.installationIncluded).toBe(false);
    // The order reads the frozen cross-border snapshot, so the freeze comes first.
    expect(freezeCrossBorderSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      createAcceptedOrder.mock.invocationCallOrder[0]!,
    );
  });

  it('refuses without approval details and leaves the status untouched', async () => {
    const res = await sign('SALES_MANAGER', {});
    expect(res.statusCode).toBe(400);
    expect(changeStatus).not.toHaveBeenCalled();
    expect(createAcceptedOrder).not.toHaveBeenCalled();
  });

  it('tells a stale tab (no approval block at all) to reload, without changing status', async () => {
    const res = await sign('SALES_MANAGER', {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/older version of the app\. Reload the page/);
    expect(changeStatus).not.toHaveBeenCalled();
  });

  it('refuses a blank approver name with a readable message', async () => {
    const res = await sign('SALES_MANAGER', { approval: { ...approval, approverName: '   ' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/name of the customer/);
    expect(changeStatus).not.toHaveBeenCalled();
  });

  it('reports a failed lock without undoing the signature', async () => {
    createAcceptedOrder.mockRejectedValueOnce(new Error('database unavailable'));
    const res = await sign('EXECUTIVE', { approval });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ACCEPTED',
      locked: false,
      lockError: 'database unavailable',
    });
    expect(changeStatus).toHaveBeenCalledTimes(1);
  });

  it('still refuses a role without proposal review', async () => {
    const res = await sign('OPERATIONS', { approval });
    expect(res.statusCode).toBe(403);
    expect(changeStatus).not.toHaveBeenCalled();
  });
});
