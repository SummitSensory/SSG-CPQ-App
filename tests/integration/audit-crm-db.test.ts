import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

/**
 * Audit: CRM / insights / receivables / approvals against a REAL database.
 *
 * Every row is created under a per-run prefix and removed in afterAll, so the file is
 * safe against a development database with data of its own. Nothing here reaches an
 * external service: the approvals notifier only logs, saved-report scheduling is
 * never triggered, and the receivables ledger reads the local QuickBooks mirror.
 *
 * `it.fails` marks a CONFIRMED bug — the assertion states the correct behaviour and
 * currently fails. Flip it to `it` once fixed.
 */

const RUN = Date.now().toString(36).toUpperCase();
const P = `AUDF${RUN}`;

let prisma: PrismaClient;
let app: FastifyInstance;
const users: Record<string, string> = {};
const tokens: Record<string, string> = {};
let orgId = '';

async function makeUser(role: string): Promise<string> {
  const u = await prisma.user.create({
    data: {
      email: `${P.toLowerCase()}-${role.toLowerCase()}@audit.invalid`,
      name: `${P} ${role}`,
      passwordHash: 'x',
      role: role as never,
    },
  });
  return u.id;
}

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
  const { signAccessToken } = await import('../../src/auth/tokens.js');

  for (const role of ['READ_ONLY', 'SALES_REP', 'SALES_MANAGER', 'EXECUTIVE']) {
    users[role] = await makeUser(role);
    tokens[role] = await signAccessToken({ sub: users[role]!, role: role as never });
  }
  const org = await prisma.organization.create({
    data: { name: `${P} Clinic`, normalizedName: `${P.toLowerCase()} clinic` },
  });
  orgId = org.id;

  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerInsightRoutes } = await import('../../src/routes/insights.js');
  const { registerCustomerNoteRoutes } = await import('../../src/routes/customerNotes.js');
  app = Fastify();
  registerErrorHandler(app);
  registerInsightRoutes(app);
  registerCustomerNoteRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (!prisma) return;
  const ids = Object.values(users);
  await prisma.salesGoal.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.savedReport.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.customerNote.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.approvalEvent.deleteMany({ where: { request: { reason: { startsWith: P } } } });
  await prisma.approvalRequest.deleteMany({ where: { reason: { startsWith: P } } });
  await prisma.approvalDelegation.deleteMany({ where: { fromUserId: { in: ids } } });
  await prisma.qboTransaction.deleteMany({ where: { idempotencyKey: { startsWith: P } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

const auth = (role: string) => ({ authorization: 'Bearer ' + tokens[role] });

/* ───────────────────────────── insights: saved reports ───────────────────────────── */

describe('audit: saved reports', () => {
  // BUG (security): routes/insights.ts:200-235 and 237-277 accept `sendAsId` and
  // `recipients` from any caller holding PROPOSAL_READ — READ_ONLY and INSTALLER
  // included — and cronInsights.ts:191,201 then sends the report CSV from THAT
  // user's own Outlook mailbox. A read-only account can schedule company sales data
  // to an outside address, sent as the CEO.
  it('a READ_ONLY user cannot schedule a report sent as another user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/insights/reports',
      headers: auth('READ_ONLY'),
      payload: {
        name: `${P} exfil`,
        definition: { groupBy: ['CUSTOMER'], measures: ['PROPOSAL_VALUE'] },
        cadence: 'WEEKLY',
        scheduleDay: 1,
        recipients: 'outsider@example.invalid',
        sendAsId: users.EXECUTIVE,
      },
    });
    expect([400, 403]).toContain(res.statusCode);
  });

  // BUG: routes/insights.ts:299-312 — run-by-id never checks `shared`/owner, while
  // PATCH and DELETE on the same resource answer 404 for someone else's private
  // report. A private report's definition and results are readable by id.
  it("another user's private report cannot be run by id", async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/insights/reports',
      headers: auth('SALES_MANAGER'),
      payload: { name: `${P} private`, shared: false, definition: {} },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json<{ id: string }>().id;

    const list = await app.inject({
      method: 'GET',
      url: '/insights/reports',
      headers: auth('SALES_REP'),
    });
    expect(list.json<Array<{ id: string }>>().some((r) => r.id === id)).toBe(false);

    const run = await app.inject({
      method: 'GET',
      url: `/insights/reports/${id}/run`,
      headers: auth('SALES_REP'),
    });
    expect(run.statusCode).toBe(404);
  });
});

/* ───────────────────────────── goals: edit contract ───────────────────────────── */

describe('audit: goal edit (public/goals.js -> PATCH /insights/goals/:id)', () => {
  // BUG (front-end contract): public/goals.js:711-729 sends metric, period and
  // savedReportId on edit; routes/insights.ts:412-436 silently ignores all three.
  // Switching a REVENUE goal to a deal count reports "saved", keeps metric=REVENUE and,
  // because the client sends targetMinor: 0 for a count metric, zeroes the target.
  it.fails('changing a goal from revenue to deal count sticks', async () => {
    const made = await app.inject({
      method: 'POST',
      url: '/insights/goals',
      headers: auth('SALES_MANAGER'),
      payload: { name: `${P} goal`, metric: 'REVENUE', period: 'MONTH', targetMinor: 100_000 },
    });
    expect(made.statusCode).toBe(200);
    const id = made.json<{ id: string }>().id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/insights/goals/${id}`,
      headers: auth('SALES_MANAGER'),
      payload: { metric: 'DEAL_COUNT', period: 'QUARTER', targetMinor: 0, targetCount: 5 },
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.salesGoal.findUnique({ where: { id } });
    expect(row?.metric).toBe('DEAL_COUNT');
    expect(row?.period).toBe('QUARTER');
  });
});

/* ───────────────────────────── customer notes / dates ───────────────────────────── */

describe('audit: customer notes', () => {
  // BUG: routes/customerNotes.ts:109,167 guard the WRITE endpoints (add a note, move
  // the decision window / follow-up date) with PROPOSAL_READ, which READ_ONLY and
  // INSTALLER hold. Every other CRM write (routes/crm.ts) requires CRM_WRITE.
  it('a READ_ONLY user cannot add a note to a customer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/crm/organizations/${orgId}/notes`,
      headers: auth('READ_ONLY'),
      payload: { body: 'read-only wrote this' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a READ_ONLY user cannot change a customer follow-up date', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/crm/organizations/${orgId}/dates`,
      headers: auth('READ_ONLY'),
      payload: { followUpDate: '2026-12-01' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('only the author may delete a note', async () => {
    const made = await app.inject({
      method: 'POST',
      url: `/crm/organizations/${orgId}/notes`,
      headers: auth('SALES_REP'),
      payload: { body: 'rep note' },
    });
    expect(made.statusCode).toBe(201);
    const id = made.json<{ id: string }>().id;
    const other = await app.inject({
      method: 'DELETE',
      url: `/customer-notes/${id}`,
      headers: auth('SALES_MANAGER'),
    });
    expect(other.statusCode).toBe(403);
    const own = await app.inject({
      method: 'DELETE',
      url: `/customer-notes/${id}`,
      headers: auth('SALES_REP'),
    });
    expect(own.statusCode).toBe(204);
  });

  it('rejects a decision window that ends before it starts', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/crm/organizations/${orgId}/dates`,
      headers: auth('SALES_REP'),
      payload: { decisionFrom: '2026-12-10', decisionTo: '2026-12-01' },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ───────────────────────────── receivables ledger ───────────────────────────── */

describe('audit: receivables ledger', () => {
  async function invoice(key: string, currency: string, balanceMinor: bigint, dueDate: Date) {
    return prisma.qboTransaction.create({
      data: {
        type: 'INVOICE',
        environment: 'SANDBOX',
        status: 'CREATED',
        proposalId: `${P}-prop`,
        proposalVersionId: `${P}-ver-${key}`,
        proposalVersion: 1,
        currency,
        proposalTotalMinor: balanceMinor,
        amountMinor: balanceMinor,
        totalsSnapshot: {},
        idempotencyKey: `${P}-${key}`,
        initiatedById: users.SALES_REP!,
        qboId: `${P}-${key}`,
        qboTotalMinor: balanceMinor,
        initialTotalMinor: balanceMinor,
        balanceMinor,
        paidMinor: 0n,
        qboStatus: 'OPEN',
        dueDate,
      },
    });
  }

  // BUG: integrations/quickbooks/receivables.ts:323-330 adds every row's balance into
  // one total regardless of `currency`, and public/accounts-receivable.js:662-667
  // prints that total with a "$". A CAD 500.00 invoice beside a USD 1,000.00 one shows
  // "Outstanding $1,500.00".
  it.fails('ledger totals do not add CAD balances into the USD figure', async () => {
    const { ledger } = await import('../../src/integrations/quickbooks/receivables.js');
    await invoice('usd', 'USD', 100_000n, new Date('2099-01-01T00:00:00Z'));
    await invoice('cad', 'CAD', 50_000n, new Date('2099-01-01T00:00:00Z'));
    const l = await ledger();
    const usdOnly = l.rows
      .filter((r) => r.currency === 'USD')
      .reduce((a, r) => a + BigInt(r.balanceMinor ?? '0'), 0n);
    expect(l.rows.some((r) => r.currency === 'CAD')).toBe(true);
    expect(BigInt(l.totals.outstandingMinor)).toBe(usdOnly);
  });

  it('past-due total only includes rows with days past due', async () => {
    const { ledger } = await import('../../src/integrations/quickbooks/receivables.js');
    await invoice('late', 'USD', 7_000n, new Date('2020-01-01T00:00:00Z'));
    const l = await ledger();
    const late = l.rows.find((r) => r.docNumber === null && r.qboId === `${P}-late`)!;
    expect(late.daysPastDue).toBeGreaterThan(0);
    const expected = l.rows
      .filter((r) => r.daysPastDue > 0)
      .reduce((a, r) => a + BigInt(r.balanceMinor ?? '0'), 0n);
    expect(BigInt(l.totals.pastDueMinor)).toBe(expected);
  });
});

/* ───────────────────────────── approvals ───────────────────────────── */

describe('audit: approval state machine', () => {
  async function newRequest(type = 'DISCOUNT') {
    const svc = await import('../../src/approvals/service.js');
    return svc.createRequest(
      { type: type as never, reason: `${P} ${type}`, requestedValue: '15%' },
      users.SALES_REP!,
    );
  }
  const manager = () => ({ userId: users.SALES_MANAGER!, role: 'SALES_MANAGER' as never });
  const exec = () => ({ userId: users.EXECUTIVE!, role: 'EXECUTIVE' as never });

  it('cannot be decided twice in sequence', async () => {
    const svc = await import('../../src/approvals/service.js');
    const { id } = await newRequest();
    await svc.approve(id, manager());
    await expect(svc.reject(id, exec())).rejects.toThrow(/APPROVED/);
  });

  it('the requester cannot approve their own discount', async () => {
    const svc = await import('../../src/approvals/service.js');
    const { id } = await newRequest();
    await expect(
      svc.approve(id, { userId: users.SALES_REP!, role: 'SALES_MANAGER' as never }),
    ).rejects.toThrow(/self-approval/);
  });

  // BUG: approvals/service.ts:118-145 — decide() reads the request (loadOpen), checks
  // it is open, then updates by id with no status condition. Two approvers acting at
  // once both pass the check: the request is approved AND rejected, both events are
  // recorded, and the last write wins. Fix: updateMany({ where: { id, status: { in:
  // open } } }) and treat count 0 as a conflict.
  it.fails('concurrent approve and reject: exactly one decision succeeds', async () => {
    const svc = await import('../../src/approvals/service.js');
    for (let i = 0; i < 5; i++) {
      const { id } = await newRequest();
      const results = await Promise.allSettled([
        svc.approve(id, manager()),
        svc.reject(id, exec()),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    }
  });

  // BUG: approvals/service.ts:232-266 — escalate() accepts any toUserId, including the
  // requester or a user with no approver authority, and nothing grants the target the
  // right to act: canDecide never consults escalatedToId. Escalating to the right
  // person by name does nothing for them, and escalating to the wrong one is
  // accepted silently.
  it.fails('escalating to someone who cannot decide it is refused', async () => {
    const svc = await import('../../src/approvals/service.js');
    const { id } = await newRequest();
    await expect(svc.escalate(id, manager(), users.READ_ONLY!)).rejects.toThrow();
  });
});
