import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * Settings → Email → Order locked email: the "Send test", "Send again", wording and
 * preview routes.
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
  saveOrderLockedTemplate: vi.fn(async (input: unknown, _actor: string) => input),
  previewOrderLockedEmail: vi.fn(async (t: { subject: string; body: string }) => ({
    email: { subject: t.subject, text: t.body + '\n' },
    basedOn: 'SO-2026-000043',
  })),
  findOrderForNotice: vi.fn(async (ref: string) =>
    ref.trim().toUpperCase() === 'SO-2026-000042'
      ? { id: 'ord_42', number: 'SO-2026-000042' }
      : null,
  ),
}));

const recordAudit = vi.fn(async () => undefined);
vi.mock('../../src/lib/audit.js', () => ({ recordAudit }));

// The real validation, defaults and field list; only what touches the database is stubbed.
vi.mock('../../src/handoff/orderLockedNotice.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/handoff/orderLockedNotice.js')>()),
  loadOrderLockedTemplate: async () => ({ subject: 'Saved {{order_number}}', body: 'Saved body' }),
  saveOrderLockedTemplate: h.saveOrderLockedTemplate,
  previewOrderLockedEmail: h.previewOrderLockedEmail,
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
  h.saveOrderLockedTemplate.mockClear();
  recordAudit.mockClear();
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

describe('order locked email — wording', () => {
  it('returns the saved wording with the defaults and the merge-field list', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/order-locked-email/template',
      headers: await auth('SYSTEM_ADMIN'),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.subject).toBe('Saved {{order_number}}');
    expect(body.defaults.subject).toContain('{{order_number}}');
    expect(body.fields.map((f: { token: string }) => f.token)).toContain('customer_po');
    await app.close();
  });

  it('saves the wording and audits the change', async () => {
    const app = await makeApp();
    const payload = { subject: 'New {{order_number}}', body: 'Body' };
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/order-locked-email/template',
      headers: await auth('SYSTEM_ADMIN'),
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(h.saveOrderLockedTemplate).toHaveBeenCalledWith(payload, 'user-SYSTEM_ADMIN');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'settings.orderLockedEmail.template' }),
    );
    await app.close();
  });

  it('previews a draft, refusing an unknown merge field with a 400', async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: 'POST',
      url: '/admin/order-locked-email/preview',
      headers: await auth('SYSTEM_ADMIN'),
      payload: { subject: 'Draft {{order_number}}', body: 'Hi' },
    });
    expect(JSON.parse(ok.body)).toEqual({
      subject: 'Draft {{order_number}}',
      text: 'Hi\n',
      basedOn: 'SO-2026-000043',
    });
    const bad = await app.inject({
      method: 'POST',
      url: '/admin/order-locked-email/preview',
      headers: await auth('SYSTEM_ADMIN'),
      payload: { subject: '{{nope}}', body: '' },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).message).toMatch(/nope/);
    await app.close();
  });

  it('is refused without the Orders manage permission', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/order-locked-email/template',
      headers: await auth('SALES_REP'),
      payload: { subject: 'x', body: 'y' },
    });
    expect(res.statusCode).toBe(403);
    expect(h.saveOrderLockedTemplate).not.toHaveBeenCalled();
    await app.close();
  });
});
