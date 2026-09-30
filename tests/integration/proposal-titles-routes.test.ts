import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * Prebuilt proposal titles — Administration → Proposal content → Proposal titles,
 * offered on the New proposal form. Any proposal reader sees the list; only
 * PROPOSAL_REVIEW can change it; a stale editor is refused rather than overwriting.
 */
const h = vi.hoisted(() => ({
  settings: new Map<string, { value: string; updatedAt: Date }>(),
}));

const recordAudit = vi.fn();
vi.mock('../../src/lib/audit.js', () => ({ recordAudit }));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
    uiSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const row = h.settings.get(where.key);
        return row ? { key: where.key, value: row.value, updatedAt: row.updatedAt } : null;
      },
      create: async ({ data }: { data: { key: string; value: string } }) => {
        if (h.settings.has(data.key)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        h.settings.set(data.key, { value: data.value, updatedAt: new Date(1_000) });
        return {};
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { key: string; updatedAt: Date };
        data: { value: string };
      }) => {
        const row = h.settings.get(where.key);
        if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
        h.settings.set(where.key, {
          value: data.value,
          updatedAt: new Date(row.updatedAt.getTime() + 1_000),
        });
        return { count: 1 };
      },
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
  h.settings.clear();
  recordAudit.mockClear();
});

async function headers(role: string): Promise<{ authorization: string }> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return { authorization: 'Bearer ' + (await signAccessToken({ sub: 'user-' + role, role })) };
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerProposalTitleRoutes } = await import('../../src/routes/proposalTitles.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerProposalTitleRoutes(app);
  await app.ready();
  return app;
}

type List = {
  titles: Array<{ id: string; title: string; active: boolean }>;
  version: string | null;
};

describe('proposal titles', () => {
  it('starts empty, saves an ordered list, and serves it to any proposal reader', async () => {
    const app = await makeApp();
    const empty = await app.inject({
      method: 'GET',
      url: '/proposal-titles',
      headers: await headers('SALES_REP'),
    });
    expect(empty.statusCode).toBe(200);
    expect(JSON.parse(empty.body)).toEqual({ titles: [], version: null });

    const saved = await app.inject({
      method: 'PUT',
      url: '/proposal-titles',
      headers: await headers('SYSTEM_ADMIN'),
      payload: {
        version: null,
        titles: [
          { id: 'a', title: '  Sensory Gym — Adventure Series ', active: true },
          { id: 'b', title: 'Soar Sensory System', active: false },
          // A repeat, differently spaced and cased, is dropped.
          { id: 'c', title: 'sensory gym — adventure  series', active: true },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    const body = JSON.parse(saved.body) as List;
    expect(body.titles).toEqual([
      { id: 'a', title: 'Sensory Gym — Adventure Series', active: true },
      { id: 'b', title: 'Soar Sensory System', active: false },
    ]);
    expect(body.version).toBeTruthy();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'proposal.titlePresets.save' }),
    );

    const rep = await app.inject({
      method: 'GET',
      url: '/proposal-titles',
      headers: await headers('SALES_REP'),
    });
    expect((JSON.parse(rep.body) as List).titles.map((t) => t.title)).toEqual([
      'Sensory Gym — Adventure Series',
      'Soar Sensory System',
    ]);
    await app.close();
  });

  it('refuses a rep who cannot review proposals', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/proposal-titles',
      headers: await headers('SALES_REP'),
      payload: { version: null, titles: [{ id: 'a', title: 'Anything', active: true }] },
    });
    expect(res.statusCode).toBe(403);
    expect(h.settings.size).toBe(0);
    await app.close();
  });

  it('refuses a save made from a stale copy of the list', async () => {
    const app = await makeApp();
    const admin = await headers('SYSTEM_ADMIN');
    const first = await app.inject({
      method: 'PUT',
      url: '/proposal-titles',
      headers: admin,
      payload: { version: null, titles: [{ id: 'a', title: 'First', active: true }] },
    });
    const v1 = (JSON.parse(first.body) as List).version;
    const second = await app.inject({
      method: 'PUT',
      url: '/proposal-titles',
      headers: admin,
      payload: { version: v1, titles: [{ id: 'a', title: 'Second', active: true }] },
    });
    expect(second.statusCode).toBe(200);
    // Still holding v1: someone else saved in between.
    const stale = await app.inject({
      method: 'PUT',
      url: '/proposal-titles',
      headers: admin,
      payload: { version: v1, titles: [{ id: 'a', title: 'Stale', active: true }] },
    });
    expect(stale.statusCode).toBe(409);
    const now = await app.inject({ method: 'GET', url: '/proposal-titles', headers: admin });
    expect((JSON.parse(now.body) as List).titles[0]?.title).toBe('Second');
    await app.close();
  });

  it('rejects a title shorter than a proposal allows', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/proposal-titles',
      headers: await headers('SYSTEM_ADMIN'),
      payload: { version: null, titles: [{ id: 'a', title: 'x', active: true }] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/at least 2 characters/);
    await app.close();
  });
});
