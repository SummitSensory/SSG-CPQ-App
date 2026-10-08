import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Audit: Resend delivery webhook (src/routes/webhooks.ts) — functional behaviour.
 *
 * Svix (Resend's webhook transport) delivers at-least-once: a slow 200, a timeout
 * or a 5xx means the same event (same svix-id) arrives again, and events for one
 * message can arrive out of order. The handler must therefore be idempotent and
 * must not let a late `email.delivered` erase a `email.bounced`.
 *
 * Prisma is an in-memory stub; signatures are computed with a test secret.
 */

const SECRET_RAW = Buffer.from('audit-resend-webhook-secret-bytes');
const SECRET = `whsec_${SECRET_RAW.toString('base64')}`;

const h = vi.hoisted(() => ({
  bomSends: [] as Array<Record<string, unknown>>,
  orderEvents: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get(target, prop, receiver) {
        if (prop === 'RESEND_WEBHOOK_SECRET') return SECRET;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
  };
});

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    bomSend: {
      findFirst: async ({ where }: { where: { providerMessageId: string } }) =>
        h.bomSends.find((s) => s.providerMessageId === where.providerMessageId) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = h.bomSends.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      // Honours the status guard the way Postgres would: synchronous, so atomic.
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: { not?: string; notIn?: string[] } };
        data: Record<string, unknown>;
      }) => {
        const rows = h.bomSends.filter(
          (s) =>
            s.id === where.id &&
            (where.status?.not === undefined || s.status !== where.status.not) &&
            (where.status?.notIn === undefined || !where.status.notIn.includes(String(s.status))),
        );
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      },
    },
    orderEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.orderEvents.push(data);
        return data;
      },
    },
    freightRfqSend: { findFirst: async () => null, update: async () => null },
    purchaseOrderSend: { findFirst: async () => null, update: async () => null },
  },
}));

function sign(id: string, ts: string, body: string): string {
  const sig = crypto
    .createHmac('sha256', SECRET_RAW)
    .update(`${id}.${ts}.${body}`)
    .digest('base64');
  return `v1,${sig}`;
}

let app: FastifyInstance;

async function deliver(
  svixId: string,
  payload: Record<string, unknown>,
  opts: { badSig?: boolean; ts?: number } = {},
) {
  const body = JSON.stringify(payload);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  return app.inject({
    method: 'POST',
    url: '/webhooks/resend',
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': ts,
      'svix-signature': opts.badSig ? 'v1,AAAA' : sign(svixId, ts, body),
    },
    payload: body,
  });
}

beforeAll(async () => {
  const Fastify = (await import('fastify')).default;
  const { registerWebhookRoutes } = await import('../../src/routes/webhooks.js');
  app = Fastify();
  registerWebhookRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.bomSends.length = 0;
  h.orderEvents.length = 0;
  h.bomSends.push({
    id: 'send-1',
    orderId: 'order-1',
    providerMessageId: 'msg-1',
    status: 'SENT',
    sentById: 'user-1',
    vendor: 'ACME',
    toEmail: 'vendor@example.com',
    openedAt: null,
  });
});

describe('Resend webhook: basic handling', () => {
  it('rejects a bad signature with 401 and writes nothing', async () => {
    const res = await deliver(
      'evt-x',
      { type: 'email.bounced', data: { email_id: 'msg-1' } },
      { badSig: true },
    );
    expect(res.statusCode).toBe(401);
    expect(h.bomSends[0]!.status).toBe('SENT');
  });

  it('rejects a timestamp outside the five-minute window', async () => {
    const res = await deliver(
      'evt-old',
      { type: 'email.delivered', data: { email_id: 'msg-1' } },
      { ts: Math.floor(Date.now() / 1000) - 3600 },
    );
    expect(res.statusCode).toBe(400);
  });

  it('marks a BOM send DELIVERED', async () => {
    const res = await deliver('evt-1', { type: 'email.delivered', data: { email_id: 'msg-1' } });
    expect(res.statusCode).toBe(200);
    expect(h.bomSends[0]!.status).toBe('DELIVERED');
  });

  it('acknowledges an email it does not track with 200', async () => {
    const res = await deliver('evt-2', { type: 'email.delivered', data: { email_id: 'other' } });
    expect(res.statusCode).toBe(200);
  });

  it('records a bounce with an order-timeline event', async () => {
    await deliver('evt-3', {
      type: 'email.bounced',
      data: { email_id: 'msg-1', bounce: { message: 'mailbox full' } },
    });
    expect(h.bomSends[0]!.status).toBe('BOUNCED');
    expect(h.bomSends[0]!.error).toBe('mailbox full');
    expect(h.orderEvents).toHaveLength(1);
  });
});

describe('Resend webhook: at-least-once delivery', () => {
  // BUG: no dedupe on svix-id (or on "already BOUNCED"), so a redelivered bounce
  // writes a second `bom.email.bounced` OrderEvent to the order timeline.
  it('BUG: a redelivered bounce (same svix-id) does not duplicate the timeline event', async () => {
    const payload = { type: 'email.bounced', data: { email_id: 'msg-1' } };
    await deliver('evt-bounce', payload);
    await deliver('evt-bounce', payload);
    expect(h.orderEvents).toHaveLength(1);
  });

  // BUG: status is overwritten unconditionally. Svix does not guarantee ordering,
  // so a `delivered` that lands after a `bounced` flips the row back to DELIVERED
  // and the audit trail claims the vendor received a BOM they never got.
  it('BUG: a late email.delivered does not overwrite BOUNCED', async () => {
    await deliver('evt-a', { type: 'email.bounced', data: { email_id: 'msg-1' } });
    await deliver('evt-b', { type: 'email.delivered', data: { email_id: 'msg-1' } });
    expect(h.bomSends[0]!.status).toBe('BOUNCED');
  });
});
