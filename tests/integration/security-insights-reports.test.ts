import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

/**
 * Saved-report ownership against a real database: who may re-point a shared
 * scheduled report, and from whose mailbox it may be sent. Rows are created under a
 * per-run prefix and removed in afterAll. Nothing is ever scheduled or sent.
 */

const P = `SECR${Date.now().toString(36).toUpperCase()}`;

let prisma: PrismaClient;
let app: FastifyInstance;
const users: Record<string, string> = {};
const tokens: Record<string, string> = {};

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  for (const role of ['SALES_REP', 'SALES_MANAGER', 'ACCOUNTING', 'SYSTEM_ADMIN']) {
    const u = await prisma.user.create({
      data: {
        email: `${P.toLowerCase()}-${role.toLowerCase()}@audit.invalid`,
        name: `${P} ${role}`,
        passwordHash: 'x',
        role: role as never,
      },
    });
    users[role] = u.id;
    tokens[role] = await signAccessToken({ sub: u.id, role: role as never });
  }
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerInsightRoutes } = await import('../../src/routes/insights.js');
  app = Fastify();
  registerErrorHandler(app);
  registerInsightRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (!prisma) return;
  const ids = Object.values(users);
  await prisma.savedReport.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

const auth = (role: string) => ({ authorization: 'Bearer ' + tokens[role] });

async function scheduledReportOwnedBy(role: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/insights/reports',
    headers: auth(role),
    payload: {
      name: `${P} weekly`,
      definition: {},
      cadence: 'WEEKLY',
      scheduleDay: 1,
      recipients: 'team@summitsensory.com',
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ id: string }>().id;
}

describe('saved reports: schedule ownership', () => {
  it('Accounting can still save a report (INSIGHTS_WRITE)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/insights/reports',
      headers: auth('ACCOUNTING'),
      payload: { name: `${P} ar view`, definition: {} },
    });
    expect(res.statusCode).toBe(200);
  });

  it('a sales rep cannot schedule a report sent from another user’s mailbox', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/insights/reports',
      headers: auth('SALES_REP'),
      payload: {
        name: `${P} as manager`,
        definition: {},
        cadence: 'WEEKLY',
        scheduleDay: 1,
        recipients: 'team@summitsensory.com',
        sendAsId: users.SALES_MANAGER,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('an admin may choose the sending mailbox', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/insights/reports',
      headers: auth('SYSTEM_ADMIN'),
      payload: { name: `${P} admin`, definition: {}, sendAsId: users.SALES_MANAGER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ sendAsId: string }>().sendAsId).toBe(users.SALES_MANAGER);
  });

  it('a non-owner cannot re-point, reschedule or change a shared scheduled report', async () => {
    const id = await scheduledReportOwnedBy('SALES_MANAGER');
    for (const payload of [
      { recipients: 'outsider@example.invalid' },
      { cadence: 'MONTHLY' },
      { shared: false },
      { definition: { groupBy: ['CUSTOMER'] } },
    ]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/insights/reports/${id}`,
        headers: auth('SALES_REP'),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(403);
    }
    const row = await prisma.savedReport.findUnique({ where: { id } });
    expect(row?.recipients).toBe('team@summitsensory.com');
    expect(row?.cadence).toBe('WEEKLY');
  });

  it('a non-owner can still rename a shared report; the owner can re-point it', async () => {
    const id = await scheduledReportOwnedBy('SALES_MANAGER');
    const rename = await app.inject({
      method: 'PATCH',
      url: `/insights/reports/${id}`,
      headers: auth('SALES_REP'),
      payload: { name: `${P} renamed` },
    });
    expect(rename.statusCode).toBe(200);
    const repoint = await app.inject({
      method: 'PATCH',
      url: `/insights/reports/${id}`,
      headers: auth('SALES_MANAGER'),
      payload: { recipients: 'leads@summitsensory.com' },
    });
    expect(repoint.statusCode).toBe(200);
  });
});
