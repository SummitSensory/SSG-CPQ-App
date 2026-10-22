import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { MondayItem } from '../../src/integrations/monday/discovery.js';

/**
 * New Deal Tracking customers appear in the CRM by themselves, and the New proposal
 * customer picker can bring one in on the spot — against a REAL database, with monday
 * mocked out entirely (no request ever leaves the process).
 *
 * What matters most here is that none of the three entry points — the create_item
 * webhook, the nightly sweep and the picker — can create a second organization or
 * opportunity for the same deal, including when two of them run at once.
 *
 * Every row is created under a per-run prefix and removed in afterAll.
 */

const h = vi.hoisted(() => {
  process.env.MONDAY_API_TOKEN = 'test-token-never-sent';
  process.env.MONDAY_DEAL_AUTO_IMPORT = 'true';
  return {
    items: new Map<string, MondayItem>(),
    created: [] as Array<MondayItem & { createdAt: Date | null }>,
    sweepFails: false,
    searchFails: false,
    search: [] as MondayItem[],
  };
});

vi.mock('../../src/integrations/monday/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/integrations/monday/client.js')>()),
  mondayQuery: vi.fn(async () => {
    throw new Error('monday must not be called from this test');
  }),
}));
vi.mock('../../src/integrations/monday/webhook.js', () => ({
  verifyMondayWebhook: vi.fn(async () => true),
}));
vi.mock('../../src/integrations/monday/discovery.js', async (orig) => ({
  ...(await orig<typeof import('../../src/integrations/monday/discovery.js')>()),
  fetchItemById: vi.fn(async (id: string) => {
    // A little latency, so two concurrent imports genuinely overlap.
    await new Promise((r) => setTimeout(r, 25));
    return h.items.get(id) ?? null;
  }),
  fetchItemsCreatedSince: vi.fn(async () => {
    if (h.sweepFails) throw new Error('monday API did not answer within 20 s');
    return h.created;
  }),
  searchItemsByName: vi.fn(async () => {
    if (h.searchFails) throw new Error('getaddrinfo ENOTFOUND api.monday.com');
    return h.search;
  }),
}));

const RUN = Date.now().toString(36).toUpperCase();
const P = `ADI${RUN}`;
const ID_BASE = Number(String(Date.now()).slice(-9)) * 10;
const itemIds = [1, 2, 3, 4, 5].map((n) => String(ID_BASE + n));

function deal(id: string, name: string, extra: Record<string, string> = {}): MondayItem {
  return {
    id,
    name,
    text: {
      text9__1: `Pat ${P}`,
      email_1__1: `pat-${id}@audit.invalid`,
      text_mkq2tbvv: 'Denver',
      text_mkpzwfqz: 'CO',
      ...extra,
    },
    raw: {},
    titles: {},
  };
}

let prisma: PrismaClient;
let app: FastifyInstance;
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
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerIntegrationRoutes } = await import('../../src/routes/integrations.js');
  const { registerCustomerPickerRoutes } = await import('../../src/routes/customerPicker.js');
  app = Fastify();
  registerErrorHandler(app);
  registerIntegrationRoutes(app);
  registerCustomerPickerRoutes(app);
  const { registerAuthRoutes } = await import('../../src/routes/auth.js');
  registerAuthRoutes(app);
  await app.ready();
});

afterAll(async () => {
  const orgs = await prisma.organization.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  const orgIds = orgs.map((o) => o.id);
  const opps = await prisma.opportunity.findMany({
    where: { organizationId: { in: orgIds } },
    select: { id: true },
  });
  await prisma.externalLink.deleteMany({ where: { externalId: { in: itemIds } } });
  await prisma.integrationSyncLog.deleteMany({ where: { externalId: { in: itemIds } } });
  await prisma.integrationSyncLog.deleteMany({
    where: { entity: 'monday-deal-sweep', createdAt: { gte: new Date(Date.now() - 3_600_000) } },
  });
  await prisma.opportunity.deleteMany({ where: { id: { in: opps.map((o) => o.id) } } });
  await prisma.contact.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.address.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

beforeEach(() => {
  h.sweepFails = false;
  h.searchFails = false;
});

async function countFor(name: string) {
  const orgs = await prisma.organization.findMany({ where: { name }, select: { id: true } });
  const opps = await prisma.opportunity.count({
    where: { organizationId: { in: orgs.map((o) => o.id) } },
  });
  const contacts = await prisma.contact.count({
    where: { organizationId: { in: orgs.map((o) => o.id) } },
  });
  return { orgs: orgs.length, opps, contacts };
}

describe('importDealNow', () => {
  it('two concurrent imports of the same new deal create one customer, not two', async () => {
    const id = itemIds[0]!;
    const name = `${P} Sensory Clinic`;
    h.items.set(id, deal(id, name));
    const { importDealNow } = await import('../../src/integrations/monday/dealAutoImport.js');

    const [a, b] = await Promise.all([importDealNow(id, 'webhook'), importDealNow(id, 'picker')]);
    expect([a.result, b.result].sort()).toEqual(['created', 'updated']);
    expect(a.organizationId).toBe(b.organizationId);
    expect(a.opportunityId).toBe(b.opportunityId);
    expect(await countFor(name)).toEqual({ orgs: 1, opps: 1, contacts: 1 });
  });

  it('reports a deal that is no longer on the board as notfound', async () => {
    const { importDealNow } = await import('../../src/integrations/monday/dealAutoImport.js');
    const out = await importDealNow('999000000001', 'picker');
    expect(out.result).toBe('notfound');
    expect(out.organizationId).toBeNull();
  });
});

describe('POST /integrations/monday/webhook — create_item on Deal Tracking', () => {
  it('imports the new deal, and a redelivery does not duplicate it', async () => {
    const id = itemIds[1]!;
    const name = `${P} Kids Therapy`;
    h.items.set(id, deal(id, name));
    const payload = {
      event: { type: 'create_pulse', boardId: 6527740233, pulseId: Number(id), pulseName: name },
    };
    const first = await app.inject({
      method: 'POST',
      url: '/integrations/monday/webhook',
      headers: { authorization: 'Bearer signed' },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, result: 'created' });

    const again = await app.inject({
      method: 'POST',
      url: '/integrations/monday/webhook',
      headers: { authorization: 'Bearer signed' },
      payload,
    });
    expect(again.json()).toMatchObject({ ok: true, result: 'updated' });
    expect(await countFor(name)).toEqual({ orgs: 1, opps: 1, contacts: 1 });
  });
});

describe('sweepNewDeals', () => {
  it('imports rows the webhook missed, re-reads the ones it saw, and is idempotent', async () => {
    const seen = itemIds[1]!; // imported by the webhook test above
    const missed = itemIds[2]!;
    const name = `${P} Missed Webhook Academy`;
    h.created = [
      { ...deal(missed, name), createdAt: new Date() },
      { ...h.items.get(seen)!, createdAt: new Date() },
    ];
    const { sweepNewDeals } = await import('../../src/integrations/monday/dealAutoImport.js');

    const first = await sweepNewDeals();
    expect(first).toMatchObject({ seen: 2, created: 1, updated: 1, complete: true });
    expect(first.error).toBeUndefined();

    const second = await sweepNewDeals();
    expect(second).toMatchObject({ seen: 2, created: 0, updated: 2, complete: true });
    expect(await countFor(name)).toEqual({ orgs: 1, opps: 1, contacts: 1 });
  });

  it('never throws when monday is unreachable, and records the failed sweep', async () => {
    h.sweepFails = true;
    const { sweepNewDeals } = await import('../../src/integrations/monday/dealAutoImport.js');
    const out = await sweepNewDeals();
    expect(out.error).toMatch(/did not answer/);
    expect(out.complete).toBe(false);
    const log = await prisma.integrationSyncLog.findFirst({
      where: { entity: 'monday-deal-sweep' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log?.status).toBe('error');
  });
});

describe('customer picker', () => {
  it('searches the CRM and monday together, offering only deals the CRM does not hold', async () => {
    const linked = itemIds[0]!; // already imported above
    const fresh = itemIds[3]!;
    h.search = [h.items.get(linked)!, deal(fresh, `${P} Sensory Clinic`)];

    const res = await app.inject({
      method: 'GET',
      url: `/crm/customer-picker?q=${encodeURIComponent(P + ' Sensory')}`,
      headers: { authorization: `Bearer ${tokens.SALES_REP}` },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.crm.map((r: { organizationName: string }) => r.organizationName)).toContain(
      `${P} Sensory Clinic`,
    );
    expect(d.monday.status).toBe('ok');
    // The linked deal is represented by its CRM row, not offered again.
    expect(d.monday.rows.map((r: { itemId: string }) => r.itemId)).toEqual([fresh]);
    // Same name as an existing customer: importing it adds a project to that customer.
    expect(d.monday.rows[0].existingOrganizationId).toBeTruthy();
  });

  it('still answers from the CRM when monday is down', async () => {
    h.searchFails = true;
    const res = await app.inject({
      method: 'GET',
      url: `/crm/customer-picker?q=${encodeURIComponent(P)}`,
      headers: { authorization: `Bearer ${tokens.SALES_REP}` },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.crm.length).toBeGreaterThan(0);
    expect(d.monday).toMatchObject({ status: 'unavailable', rows: [] });
  });

  it('imports a picked deal and hands back the CRM ids; picking it again returns the same ones', async () => {
    const id = itemIds[4]!;
    const name = `${P} Picked From Monday`;
    h.items.set(id, deal(id, name, { text_mkpz1234: '' }));
    const first = await app.inject({
      method: 'POST',
      url: `/crm/customer-picker/monday/${id}`,
      headers: { authorization: `Bearer ${tokens.SALES_REP}` },
    });
    expect(first.statusCode).toBe(200);
    const a = first.json();
    expect(a).toMatchObject({ result: 'created', organizationName: name });
    expect(a.organizationId).toBeTruthy();
    expect(a.opportunityId).toBeTruthy();

    const second = await app.inject({
      method: 'POST',
      url: `/crm/customer-picker/monday/${id}`,
      headers: { authorization: `Bearer ${tokens.SALES_REP}` },
    });
    expect(second.json()).toMatchObject({
      result: 'updated',
      organizationId: a.organizationId,
      opportunityId: a.opportunityId,
    });
    expect(await countFor(name)).toEqual({ orgs: 1, opps: 1, contacts: 1 });
  });

  it('read-only users see CRM customers only and cannot import', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/crm/customer-picker?q=${encodeURIComponent(P)}`,
      headers: { authorization: `Bearer ${tokens.READ_ONLY}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().monday.status).toBe('not-permitted');

    const imp = await app.inject({
      method: 'POST',
      url: `/crm/customer-picker/monday/${itemIds[3]}`,
      headers: { authorization: `Bearer ${tokens.READ_ONLY}` },
    });
    expect(imp.statusCode).toBe(403);
  });

  it('rejects an item id that is not a monday id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/crm/customer-picker/monday/not-a-number',
      headers: { authorization: `Bearer ${tokens.SALES_REP}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /auth/me — navOrder (reorderable sidebar tabs)', () => {
  const auth = () => ({ authorization: `Bearer ${tokens.SALES_REP}` });

  it('saves the tab order to the account, and null resets it', async () => {
    const order = ['proposals', 'crm', 'dashboard', 'strategic-partnerships'];
    const saved = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: auth(),
      payload: { navOrder: order },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().navOrder).toEqual(order);

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth() });
    expect(me.json().navOrder).toEqual(order);

    const reset = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: auth(),
      payload: { navOrder: null },
    });
    expect(reset.json().navOrder).toBeNull();
  });

  it('leaves the order alone when a profile save does not mention it', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: auth(),
      payload: { navOrder: ['crm'] },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: auth(),
      payload: { tipsEnabled: false },
    });
    expect(res.json().navOrder).toEqual(['crm']);
  });

  it('rejects ids that are not nav ids', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: auth(),
      payload: { navOrder: ['<script>'] },
    });
    expect(res.statusCode).toBe(400);
  });
});
