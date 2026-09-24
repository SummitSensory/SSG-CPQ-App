import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The "order locked" email (src/handoff/orderLockedNotice.ts): who it goes to, what
 * it says, and that it can never fail the lock that triggered it.
 */

const settings = new Map<string, string>();
const events: Array<{ action: string; detail: unknown }> = [];
let failEventWrite = false;

const ORDER = {
  id: 'ord_1',
  number: 'SO-2026-000050',
  organizationId: 'org_1',
  opportunityId: 'opp_1',
  proposalId: 'prop_1',
  acceptedVersion: 3,
  currency: 'USD',
  grandTotalMinor: 1622664n,
  depositRequired: true,
  depositDueMinor: 811332n,
  acceptedById: 'user_1',
  createdAt: new Date('2026-09-24T21:30:00Z'),
  customerApproval: { approverName: 'Jen Gordon', method: 'ESIGN', poNumber: 'PO-77' },
};
let order: typeof ORDER | null = ORDER;

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    uiSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        settings.set(where.key, create.value);
        return {};
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        settings.delete(where.key);
        return { count: 1 };
      },
    },
    acceptedOrder: { findUnique: async () => order },
    organization: { findUnique: async () => ({ name: 'Firefly Autism' }) },
    proposal: {
      findUnique: async () => ({ number: 'P-2026-000148', title: 'Foundation System' }),
    },
    opportunity: { findUnique: async () => ({ name: 'Firefly Lakewood Gym' }) },
    user: { findUnique: async () => ({ name: 'Bryan Shepherd', email: 'b@example.com' }) },
    orderEvent: {
      create: async ({ data }: { data: { action: string; detail: unknown } }) => {
        if (failEventWrite) throw new Error('db down');
        events.push({ action: data.action, detail: data.detail });
        return {};
      },
    },
  },
}));

const envStub = {
  RESEND_API_KEY: 're_test' as string | undefined,
  APP_BASE_URL: 'https://crm.example.com/',
  ALERT_FROM_NAME: 'Summit Sensory CRM',
  ALERT_FROM_EMAIL: 'notifications@crm.example.com',
  BOM_REPLY_TO: 'orders@example.com',
};
vi.mock('../../src/config/env.js', () => ({ env: envStub }));

const fetchMock = vi.fn(
  async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }),
);

beforeEach(() => {
  settings.clear();
  events.length = 0;
  failEventWrite = false;
  order = ORDER;
  envStub.RESEND_API_KEY = 're_test';
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const mod = () => import('../../src/handoff/orderLockedNotice.js');

describe('order locked recipients', () => {
  it('normalises, de-duplicates and stores the list', async () => {
    const { saveOrderLockedRecipients, loadOrderLockedRecipients } = await mod();
    const saved = await saveOrderLockedRecipients(
      'ops@example.com\n Accounting@example.com, ops@EXAMPLE.com;',
      'user_1',
    );
    expect(saved).toEqual(['ops@example.com', 'Accounting@example.com']);
    expect(await loadOrderLockedRecipients()).toEqual(saved);
  });

  it('refuses anything that is not an email address, and saves nothing', async () => {
    const { saveOrderLockedRecipients, loadOrderLockedRecipients } = await mod();
    await expect(saveOrderLockedRecipients('ops@example.com, bob', 'user_1')).rejects.toThrow(
      /bob/,
    );
    expect(await loadOrderLockedRecipients()).toEqual([]);
  });

  it('clears the list when saved blank', async () => {
    const { saveOrderLockedRecipients, loadOrderLockedRecipients } = await mod();
    await saveOrderLockedRecipients(['ops@example.com'], 'user_1');
    expect(await saveOrderLockedRecipients('', 'user_1')).toEqual([]);
    expect(await loadOrderLockedRecipients()).toEqual([]);
  });
});

describe('the order locked email', () => {
  it('summarises the order and links to it', async () => {
    const { buildOrderLockedEmail } = await mod();
    const email = (await buildOrderLockedEmail('ord_1'))!;
    expect(email.subject).toBe('Order locked: SO-2026-000050 — Firefly Autism');
    expect(email.text).toContain('Customer:     Firefly Autism');
    expect(email.text).toContain('Project:      Firefly Lakewood Gym');
    expect(email.text).toContain('Proposal:     P-2026-000148 (version 3) — Foundation System');
    expect(email.text).toContain('Order total:  USD 16,226.64');
    expect(email.text).toContain('Deposit due:  USD 8,113.32');
    expect(email.text).toContain('Approved by:  Jen Gordon');
    expect(email.text).toContain('Customer PO:  PO-77');
    expect(email.text).toContain('Locked by:    Bryan Shepherd');
    expect(email.text).toContain('Locked at:    Sep 24, 2026, 3:30 PM (Mountain)');
    expect(email.text).toContain('Open the order: https://crm.example.com/?order=ord_1');
  });

  it('leaves out the lines an order does not have instead of leaving them blank', async () => {
    order = {
      ...ORDER,
      opportunityId: null as unknown as string,
      depositRequired: false,
      customerApproval: {
        approverName: 'Jen Gordon',
        method: 'ESIGN',
        poNumber: null as unknown as string,
      },
    };
    const { buildOrderLockedEmail } = await mod();
    const { text } = (await buildOrderLockedEmail('ord_1'))!;
    expect(text).not.toContain('Project:');
    expect(text).not.toContain('Customer PO:');
    expect(text).toContain('Deposit due:  None');
    expect(text).not.toMatch(/\n\n\n/);
  });
});

describe('sendOrderLockedNotice', () => {
  it('emails the list once and records it on the order', async () => {
    const { saveOrderLockedRecipients, sendOrderLockedNotice } = await mod();
    await saveOrderLockedRecipients('ops@example.com, acct@example.com', 'user_1');
    expect(await sendOrderLockedNotice('ord_1', 'user_1')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('order-locked-ord_1');
    const body = JSON.parse(String(init.body));
    expect(body.to).toEqual(['ops@example.com', 'acct@example.com']);
    expect(body.from).toBe('Summit Sensory CRM <notifications@crm.example.com>');
    expect(body.subject).toBe('Order locked: SO-2026-000050 — Firefly Autism');
    expect(events).toEqual([
      {
        action: 'order.locked.notice_sent',
        detail: { to: ['ops@example.com', 'acct@example.com'] },
      },
    ]);
  });

  it('sends nothing and records nothing when nobody is on the list', async () => {
    const { sendOrderLockedNotice } = await mod();
    expect(await sendOrderLockedNotice('ord_1', 'user_1')).toMatch(/No order-locked recipients/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('records why when email delivery is not configured', async () => {
    envStub.RESEND_API_KEY = undefined;
    const { saveOrderLockedRecipients, sendOrderLockedNotice } = await mod();
    await saveOrderLockedRecipients('ops@example.com', 'user_1');
    expect(await sendOrderLockedNotice('ord_1', 'user_1')).toMatch(/RESEND_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events[0]?.action).toBe('order.locked.notice_failed');
  });

  it('never throws: a rejected send, a network error or a failed event write', async () => {
    const { saveOrderLockedRecipients, sendOrderLockedNotice } = await mod();
    await saveOrderLockedRecipients('ops@example.com', 'user_1');

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 422 }));
    expect(await sendOrderLockedNotice('ord_1', 'user_1')).toMatch(/422/);
    expect(events.at(-1)?.action).toBe('order.locked.notice_failed');

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    expect(await sendOrderLockedNotice('ord_1', 'user_1')).toBe('network down');

    failEventWrite = true;
    await expect(sendOrderLockedNotice('ord_1', 'user_1')).resolves.toBeNull();
  });
});
