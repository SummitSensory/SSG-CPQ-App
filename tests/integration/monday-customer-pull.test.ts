import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { MondayItem } from '../../src/integrations/monday/discovery.js';

/**
 * "Pull from monday" on a CRM customer, against a REAL database with monday mocked
 * (no request leaves the process).
 *
 *  - details entered on the Deal Tracking row after import are offered: a blank in
 *    the CRM as FILL, a value the CRM already holds as DIFFERS;
 *  - only the ticked keys are written, so a correction made in the CRM survives a pull
 *    unless somebody chooses to overwrite it;
 *  - read-only users cannot pull.
 *
 * Every row is created under a per-run prefix and removed in afterAll.
 */

const h = vi.hoisted(() => {
  process.env.MONDAY_API_TOKEN = 'test-token-never-sent';
  process.env.MONDAY_DEALS_BOARD_ID = '6527740233';
  return { items: new Map<string, MondayItem>() };
});

vi.mock('../../src/integrations/monday/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/integrations/monday/client.js')>()),
  mondayQuery: vi.fn(async () => {
    throw new Error('monday must not be called from this test');
  }),
}));
vi.mock('../../src/integrations/monday/discovery.js', async (orig) => ({
  ...(await orig<typeof import('../../src/integrations/monday/discovery.js')>()),
  fetchItemById: vi.fn(async (id: string) => h.items.get(id) ?? null),
}));

const RUN = Date.now().toString(36).toUpperCase();
const P = `CPL${RUN}`;
const ITEM = String(Number(String(Date.now()).slice(-9)) * 10 + 7);

function deal(text: Record<string, string>): MondayItem {
  return { id: ITEM, name: `${P} Sensory Clinic`, text, raw: {}, titles: {} };
}

let prisma: PrismaClient;
let app: FastifyInstance;
let orgId = '';
let oppId = '';
const tokens: Record<string, string> = {};
const userIds: string[] = [];

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  for (const role of ['SALES_REP', 'READ_ONLY']) {
    const u = await prisma.user.create({
      data: {
        email: `${P.toLowerCase()}-${role.toLowerCase()}@audit.invalid`,
        name: `${P} ${role}`,
        passwordHash: 'x',
        role: role as never,
      },
    });
    userIds.push(u.id);
    tokens[role] = await signAccessToken({ sub: u.id, role: role as never });
  }
  // A customer as the import left it: the contact's name and email only.
  const org = await prisma.organization.create({
    data: {
      name: `${P} Sensory Clinic`,
      normalizedName: `${P} sensory clinic`.toLowerCase(),
      customerType: 'OTHER',
    },
  });
  orgId = org.id;
  await prisma.contact.create({
    data: {
      organizationId: orgId,
      firstName: 'Pat',
      lastName: 'Lee',
      email: `pat-${RUN.toLowerCase()}@audit.invalid`,
      title: 'Director',
      isDecisionMaker: true,
    },
  });
  const opp = await prisma.opportunity.create({
    data: { organizationId: orgId, name: `${P} Sensory Clinic`, mondayItemId: ITEM },
  });
  oppId = opp.id;

  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerCrmRoutes } = await import('../../src/routes/crm.js');
  app = Fastify();
  registerErrorHandler(app);
  registerCrmRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await prisma.opportunity.deleteMany({ where: { organizationId: orgId } });
  await prisma.contact.deleteMany({ where: { organizationId: orgId } });
  await prisma.address.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

const auth = (role = 'SALES_REP') => ({ authorization: 'Bearer ' + tokens[role] });

describe('Pull from monday', () => {
  it('offers what was entered on the deal after import: blanks ticked, differences not', async () => {
    // Since the import: a phone, the site address and a deal value were added, and the
    // title was changed on the board.
    h.items.set(
      ITEM,
      deal({
        text9__1: 'Pat Lee',
        email_1__1: `pat-${RUN.toLowerCase()}@audit.invalid`,
        phone__1: '303-555-0100',
        text_mkpnvbkn: 'Executive Director',
        text_mkq2tbvv: 'Denver',
        text_mkpzwfqz: 'CO',
        text__1: '80202',
        numbers1__1: '24500',
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/crm/organizations/${orgId}/monday-pull`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const plan = res.json() as { changes: Array<{ key: string; kind: string; incoming: string }> };
    const byKey = Object.fromEntries(plan.changes.map((c) => [c.key, c]));
    expect(byKey['contact.phone']).toMatchObject({ kind: 'FILL', incoming: '303-555-0100' });
    expect(byKey['contact.title']).toMatchObject({
      kind: 'DIFFERS',
      incoming: 'Executive Director',
    });
    expect(byKey['address']?.kind).toBe('FILL');
    expect(byKey['opp.budget']?.kind).toBe('FILL');
    // Name and email already match: not offered.
    expect(byKey['contact.name']).toBeUndefined();
    expect(byKey['contact.email']).toBeUndefined();
  });

  it('writes only the ticked details — an untouched difference keeps the CRM value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/crm/organizations/${orgId}/monday-pull`,
      headers: auth(),
      payload: { opportunityId: oppId, keys: ['contact.phone', 'address', 'opp.budget'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied.sort()).toEqual(['address', 'contact.phone', 'opp.budget']);

    const contact = await prisma.contact.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(contact.phone).toBe('303-555-0100');
    expect(contact.title).toBe('Director');
    const addr = await prisma.address.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(addr).toMatchObject({
      city: 'Denver',
      region: 'CO',
      postalCode: '80202',
      type: 'SHIPPING',
    });
    const opp = await prisma.opportunity.findUniqueOrThrow({ where: { id: oppId } });
    expect(opp.budgetAmountMinor).toBe(2_450_000n);

    // A second preview now only offers what is still different.
    const again = await app.inject({
      method: 'GET',
      url: `/crm/organizations/${orgId}/monday-pull?opportunityId=${oppId}`,
      headers: auth(),
    });
    expect(again.json().changes.map((c: { key: string }) => c.key)).toEqual(['contact.title']);
  });

  it('adds a contact entered on the deal under a new name', async () => {
    h.items.set(
      ITEM,
      deal({
        text9__1: 'Sam Rivera',
        email_1__1: `sam-${RUN.toLowerCase()}@audit.invalid`,
        text_mkq2tbvv: 'Denver',
        text_mkpzwfqz: 'CO',
        text__1: '80202',
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/crm/organizations/${orgId}/monday-pull`,
      headers: auth(),
      payload: { keys: ['contact.new'] },
    });
    expect(res.json().applied).toEqual(['contact.new']);
    expect(await prisma.contact.count({ where: { organizationId: orgId } })).toBe(2);
  });

  it('read-only users cannot pull', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/crm/organizations/${orgId}/monday-pull`,
      headers: auth('READ_ONLY'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('a customer with no linked deal is told so, not given an empty list', async () => {
    const lone = await prisma.organization.create({
      data: { name: `${P} No Deal`, normalizedName: `${P} no deal`.toLowerCase() },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/crm/organizations/${lone.id}/monday-pull`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not linked/);
    await prisma.organization.delete({ where: { id: lone.id } });
  });
});
