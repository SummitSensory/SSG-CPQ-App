import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * PATCH /crm/contacts/:id is the fix for a customer's QuickBooks invoice going
 * to the wrong person — see loadCustomerSource (quickbooks/customers.ts),
 * which picks the org's contact by isDecisionMaker first. The behaviour worth
 * proving here is the exclusivity rule: promoting one contact to "the" invoice
 * contact must demote every other contact on the same organization, or two
 * contacts could both read isDecisionMaker: true and loadCustomerSource's
 * ordering would silently decide which one wins.
 *
 * The monday and QuickBooks pushes are mocked out — they have their own unit
 * coverage (monday-mapping, qbo-source-of-truth) — so this stays a test of the
 * route's own logic: permissions, the exclusivity update, and duplicate
 * detection.
 */

const CONTACTS = new Map<string, Record<string, unknown>>([
  [
    'c1',
    {
      id: 'c1',
      organizationId: 'org1',
      firstName: 'Alex',
      lastName: 'Old',
      email: 'alex@example.com',
      phone: null,
      title: null,
      isDecisionMaker: true,
      notes: null,
    },
  ],
  [
    'c2',
    {
      id: 'c2',
      organizationId: 'org1',
      firstName: 'Jordan',
      lastName: 'New',
      email: 'jordan@example.com',
      phone: null,
      title: null,
      isDecisionMaker: false,
      notes: null,
    },
  ],
]);

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
    contact: {
      findUnique: async ({ where }: { where: { id: string } }) => CONTACTS.get(where.id) ?? null,
      findMany: async ({ where }: { where: { organizationId: string; email?: string } }) =>
        [...CONTACTS.values()].filter(
          (c) =>
            c.organizationId === where.organizationId && (!where.email || c.email === where.email),
        ),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const current = CONTACTS.get(where.id)!;
        const next = { ...current, ...data };
        CONTACTS.set(where.id, next);
        return next;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { organizationId: string; id: { not: string } };
        data: Record<string, unknown>;
      }) => {
        for (const [id, c] of CONTACTS) {
          if (c.organizationId === where.organizationId && id !== where.id.not) {
            CONTACTS.set(id, { ...c, ...data });
          }
        }
        return { count: 0 };
      },
    },
    auditLog: { create: async () => ({}) },
  },
}));

vi.mock('../../src/integrations/monday/contactPush.js', () => ({
  pushContactToDeal: async () => ({ pushed: false, reason: 'not linked to a monday deal row' }),
}));

vi.mock('../../src/integrations/quickbooks/customers.js', () => ({
  refreshCustomerIfLinked: async () => {},
}));

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

async function tokenFor(role: string): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub: 'user-' + role, role });
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerCrmRoutes } = await import('../../src/routes/crm.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerCrmRoutes(app);
  await app.ready();
  return app;
}

describe('PATCH /crm/contacts/:id', () => {
  it('rejects a write from a role without crm:write', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/crm/contacts/c1',
      headers: { authorization: 'Bearer ' + (await tokenFor('READ_ONLY')) },
      payload: { firstName: 'Nope' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('404s for a contact that does not exist', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/crm/contacts/does-not-exist',
      headers: { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) },
      payload: { firstName: 'Nope' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('promoting one contact to the invoice contact demotes every other contact on the org', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/crm/contacts/c2',
      headers: { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) },
      payload: { isDecisionMaker: true },
    });
    expect(res.statusCode).toBe(200);
    expect(CONTACTS.get('c2')?.isDecisionMaker).toBe(true);
    expect(CONTACTS.get('c1')?.isDecisionMaker).toBe(false);
    await app.close();
  });

  it('clears the email with an explicit empty string', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/crm/contacts/c2',
      headers: { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) },
      payload: { email: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBeNull();
    await app.close();
  });

  it('409s when the new email collides with another contact on the same org', async () => {
    CONTACTS.set('c2', { ...CONTACTS.get('c2')!, email: 'jordan@example.com' });
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/crm/contacts/c2',
      headers: { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) },
      payload: { email: 'alex@example.com' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
