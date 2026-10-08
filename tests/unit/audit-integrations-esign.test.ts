import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Audit: DocuSeal webhook routing (src/routes/esignWebhook.ts) and the daily
 * "still not signed" reminder sweep (sendEsignReminders in
 * src/integrations/docuseal/notifications.ts).
 *
 * Prisma is an in-memory stub that honours the `where` shapes these functions
 * use. The DocuSeal service calls are spies; sendAlert is captured. No network.
 */

const SECRET = 'audit-docuseal-webhook-secret';

const h = vi.hoisted(() => ({
  envelopes: [] as Array<Record<string, unknown>>,
  signers: [] as Array<Record<string, unknown>>,
  alerts: [] as Array<{ title: string; to?: string[]; fingerprint?: string }>,
  recordEvent: vi.fn(async (_input: { envelopeId: string; eventType: string }) => undefined),
  syncEnvelope: vi.fn(async (_id: string) => ({ status: 'SENT' })),
}));

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>();
  const overrides: Record<string, unknown> = {
    DOCUSEAL_WEBHOOK_SECRET: 'audit-docuseal-webhook-secret',
    ESIGN_ESCALATION_EMAIL: 'escalate@example.test',
  };
  return {
    ...real,
    env: new Proxy(real.env, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && prop in overrides) return overrides[prop];
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
  };
});
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/lib/alerts.js', () => ({
  sendAlert: (a: { title: string; to?: string[]; fingerprint?: string }) => h.alerts.push(a),
  deliverAlert: async (a: { title: string; to?: string[]; fingerprint?: string }) => {
    h.alerts.push(a);
  },
}));
vi.mock('../../src/integrations/docuseal/service.js', () => ({
  recordEvent: h.recordEvent,
  syncEnvelope: h.syncEnvelope,
}));

type Where = Record<string, unknown>;
function matchesReminderWhere(e: Record<string, unknown>, where: Where): boolean {
  const status = where.status as { in?: string[] } | undefined;
  if (status?.in && !status.in.includes(String(e.status))) return false;
  if (where.sentAt && e.sentAt == null) return false;
  const or = where.OR as Array<{ lastReminderSentAt: null | { lt: Date } }> | undefined;
  if (or) {
    const last = e.lastReminderSentAt as Date | null;
    const ok = or.some((c) =>
      c.lastReminderSentAt === null ? last == null : last != null && last < c.lastReminderSentAt.lt,
    );
    if (!ok) return false;
  }
  return true;
}

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    esignEnvelope: {
      findFirst: async ({ where }: { where: { docusealSubmissionId: string } }) =>
        h.envelopes.find((e) => e.docusealSubmissionId === where.docusealSubmissionId) ?? null,
      findMany: async ({ where }: { where: Where }) =>
        h.envelopes.filter((e) => matchesReminderWhere(e, where)),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const e = h.envelopes.find((x) => x.id === where.id);
        return e ? { ...e, signers: h.signers.filter((s) => s.envelopeId === e.id) } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const e = h.envelopes.find((x) => x.id === where.id)!;
        Object.assign(e, data);
        return e;
      },
      // Synchronous inside the async body, so it is atomic like a row-level UPDATE.
      updateMany: async ({
        where,
        data,
      }: {
        where: Where & { id: string };
        data: Record<string, unknown>;
      }) => {
        const rows = h.envelopes.filter((e) => e.id === where.id && matchesReminderWhere(e, where));
        for (const e of rows) Object.assign(e, data);
        return { count: rows.length };
      },
    },
    esignSigner: {
      findFirst: async ({ where }: { where: { docusealSubmitterId: string } }) =>
        h.signers.find((s) => s.docusealSubmitterId === where.docusealSubmitterId) ?? null,
    },
    proposal: {
      findUnique: async () => ({
        id: 'p1',
        number: 'P-100',
        title: 'Sensory gym',
        organizationId: 'o1',
        opportunityId: null,
      }),
    },
    user: { findUnique: async () => ({ email: 'rep@example.test' }) },
  },
}));

let app: FastifyInstance;

beforeAll(async () => {
  const Fastify = (await import('fastify')).default;
  const { registerDocusealWebhookRoutes } = await import('../../src/routes/esignWebhook.js');
  app = Fastify();
  registerDocusealWebhookRoutes(app);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const DAY = 24 * 60 * 60 * 1000;
beforeEach(() => {
  h.envelopes.length = 0;
  h.signers.length = 0;
  h.alerts.length = 0;
  h.recordEvent.mockClear();
  h.syncEnvelope.mockReset();
  h.syncEnvelope.mockResolvedValue({ status: 'SENT' });
});

function addEnvelope(id: string, sentAgoMs: number, extra: Record<string, unknown> = {}) {
  h.envelopes.push({
    id,
    proposalId: 'p1',
    status: 'SENT',
    sentAt: new Date(Date.now() - sentAgoMs),
    sentById: 'u1',
    lastReminderSentAt: null,
    docusealSubmissionId: `sub-${id}`,
    ...extra,
  });
  h.signers.push({
    id: `${id}-s1`,
    envelopeId: id,
    status: 'PENDING',
    viewOnly: false,
    name: 'Customer',
    role: 'Customer',
    email: 'c@example.test',
    docusealSubmitterId: `submitter-${id}`,
  });
}

describe('DocuSeal webhook', () => {
  const post = (
    payload: unknown,
    headers: Record<string, string> = { 'x-webhook-secret': SECRET },
  ) =>
    app.inject({ method: 'POST', url: '/webhooks/docuseal', payload: payload as object, headers });

  it('rejects a wrong shared secret with 401', async () => {
    const res = await post({ event_type: 'form.completed' }, { 'x-webhook-secret': 'wrong' });
    expect(res.statusCode).toBe(401);
    expect(h.syncEnvelope).not.toHaveBeenCalled();
  });

  it('acknowledges an event for an envelope that is not ours, without syncing', async () => {
    const res = await post({ event_type: 'submission.completed', data: { submission_id: 999 } });
    expect(res.statusCode).toBe(200);
    expect(h.recordEvent).not.toHaveBeenCalled();
    expect(h.syncEnvelope).not.toHaveBeenCalled();
  });

  it('resolves by submission id and re-reads state from DocuSeal', async () => {
    addEnvelope('e1', 0);
    const res = await post({
      event_type: 'submission.completed',
      data: { submission_id: 'sub-e1' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ envelopeId: 'e1' }));
    expect(h.syncEnvelope).toHaveBeenCalledWith('e1');
  });

  it('resolves form.* events by submitter id', async () => {
    addEnvelope('e2', 0);
    await post({ event_type: 'form.viewed', data: { id: 'submitter-e2' } });
    expect(h.syncEnvelope).toHaveBeenCalledWith('e2');
  });

  it('still answers 200 when the DocuSeal read-back fails (event is recorded)', async () => {
    addEnvelope('e3', 0);
    h.syncEnvelope.mockRejectedValueOnce(new Error('DocuSeal 502'));
    const res = await post({ event_type: 'form.completed', data: { submission_id: 'sub-e3' } });
    expect(res.statusCode).toBe(200);
    expect(h.recordEvent).toHaveBeenCalled();
  });
});

describe('sendEsignReminders', () => {
  it('does not remind an envelope sent less than a day ago', async () => {
    const { sendEsignReminders } = await import('../../src/integrations/docuseal/notifications.js');
    addEnvelope('r1', 2 * 60 * 60 * 1000);
    expect(await sendEsignReminders()).toEqual({ reminded: 0 });
    expect(h.alerts).toHaveLength(0);
  });

  it('reminds once a day, escalating past the first 24h', async () => {
    const { sendEsignReminders } = await import('../../src/integrations/docuseal/notifications.js');
    addEnvelope('r2', 3 * DAY);
    expect(await sendEsignReminders()).toEqual({ reminded: 1 });
    expect(h.alerts[0]!.title).toContain('still not signed after 3 days');
    expect(h.alerts[0]!.to).toEqual(['escalate@example.test']);
    // A second run the same day finds nothing due.
    expect(await sendEsignReminders()).toEqual({ reminded: 0 });
    expect(h.alerts).toHaveLength(1);
  });

  it('skips envelopes that are signed, declined or voided', async () => {
    const { sendEsignReminders } = await import('../../src/integrations/docuseal/notifications.js');
    addEnvelope('r3', 3 * DAY, { status: 'COMPLETED' });
    addEnvelope('r4', 3 * DAY, { status: 'VOIDED' });
    expect(await sendEsignReminders()).toEqual({ reminded: 0 });
  });

  // BUG (low): lastReminderSentAt is written with an unconditional update after the
  // read, not claimed with a conditional updateMany like the other notifications.
  // A double-fired cron (or a manual re-run racing the schedule) on two instances
  // sends two reminders; sendAlert's in-memory dedupe is per instance only.
  it('BUG: two overlapping sweeps send one reminder, not two', async () => {
    const { sendEsignReminders } = await import('../../src/integrations/docuseal/notifications.js');
    addEnvelope('r5', 3 * DAY);
    const [a, b] = await Promise.all([sendEsignReminders(), sendEsignReminders()]);
    expect(a.reminded + b.reminded).toBe(1);
  });
});
