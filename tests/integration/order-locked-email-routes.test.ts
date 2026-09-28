import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * Settings → Email → Order locked email: the "Send test" and "Send again" routes.
 * The email itself is covered in tests/unit/order-locked-notice.test.ts; these prove
 * the routes are guarded, find the order by number, and hand back the reason a send
 * failed instead of a bare status.
 */
const h = vi.hoisted(() => ({
  sendOrderLockedTestEmail: vi.fn(async () => ({
    to: ['orders@example.com'],
    error: null as string | null,
  })),
  sendOrderLockedNotice: vi.fn(
    async (_id: string, _actor: string, _opts?: { resend?: boolean }) => null as string | null,
  ),
  findOrderForNotice: vi.fn(async (ref: string) =>
    ref.trim().toUpperCase() === 'SO-2026-000042'
      ? { id: 'ord_42', number: 'SO-2026-000042' }
      : null,
  ),
}));

vi.mock('../../src/handoff/orderLockedNotice.js', () => ({
  loadOrderLockedRecipients: async () => ['orders@example.com'],
  saveOrderLockedRecipients: async () => ['orders@example.com'],
  sendOrderLockedTestEmail: h.sendOrderLockedTestEmail,
  sendOrderLockedNotice: h.sendOrderLockedNotice,
  findOrderForNotice: h.findOrderForNotice,
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
        name: 'Test User',
        email: 'test@example.com',
      }),
    },
  },
}));

import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

beforeEach(() => {
  h.sendOrderLockedTestEmail.mockClear();
  h.sendOrderLockedNotice.mockClear();
});

async function auth(role: string) {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return { authorization: 'Bearer ' + (await signAccessToken({ sub: 'user-' + role, role })) };
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerOrderNotificationRoutes } =
    await import('../../src/routes/orderNotifications.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerOrderNotificationRoutes(app);
  await app.ready();
  return app;
}

describe('order locked email — send test', () => {
  it('sends and reports who it went to', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/order-locked-email/test',
      headers: await auth('SYSTEM_ADMIN'),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sent: true, to: ['orders@example.com'], error: null });
    await app.close();
  });

  it("returns Resend's reason when the send is refused", async () => {
    h.sendOrderLockedTestEmail.mockResolvedValueOnce({
      to: ['orders@example.com'],
      error: 'Resend rejected the notice (403): not authorized for crm.example.com',
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/order-locked-email/test',
      headers: await auth('SYSTEM_ADMIN'),
    });
    expect(JSON.parse(res.body)).toMatchObject({ sent: false, error: /not authorized/ });
    await app.close();
  });

  it('is refused without the Orders manage permission', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/order-locked-email/test',
      headers: await auth('SALES_REP'),
    });
    expect(res.statusCode).toBe(403);
    expect(h.sendOrderLockedTestEmail).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('order locked email — send again', () => {
  it('finds the order by number and re-sends it as a hand re-send', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/order-locked-email/resend',
      headers: await auth('SYSTEM_ADMIN'),
      payload: { order: ' so-2026-000042 ' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sent: true, number: 'SO-2026-000042', error: null });
    expect(h.sendOrderLockedNotice).toHaveBeenCalledWith('ord_42', 'user-SYSTEM_ADMIN', {
      resend: true,
    });
    await app.close();
  });

  it('404s an unknown order and sends nothing', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/order-locked-email/resend',
      headers: await auth('SYSTEM_ADMIN'),
      payload: { order: 'SO-1999-000001' },
    });
    expect(res.statusCode).toBe(404);
    expect(h.sendOrderLockedNotice).not.toHaveBeenCalled();
    await app.close();
  });
});
