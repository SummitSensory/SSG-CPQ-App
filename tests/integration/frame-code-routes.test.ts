import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_FRAME_CODE_CONVENTION } from '../../src/proposals/frameCode.js';

/**
 * Administration → Frame naming.
 *
 *  - only SYSTEM_ADMIN (FRAME_CODE_MANAGE) may read or change the convention;
 *  - saving appends a new version and never rewrites one (proposals stamp the version
 *    that named them);
 *  - a convention that would make codes unreadable is refused;
 *  - the pricing route refuses width greater than length and names the frame with the
 *    newest version.
 *
 * Prisma is a plain stub, following this repo's convention.
 */

const ROWS: Array<Record<string, unknown>> = [];

vi.mock('../../src/lib/prisma.js', () => {
  const byVersionDesc = () => [...ROWS].sort((a, b) => Number(b.version) - Number(a.version));
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
    frameCodeConvention: {
      findFirst: async () => byVersionDesc()[0] ?? null,
      findMany: async () => byVersionDesc().reverse(),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (ROWS.some((r) => r.version === data.version)) throw new Error('unique violation');
        const row = { id: 'fc-' + (ROWS.length + 1), createdAt: new Date(), ...data };
        ROWS.push(row);
        return row;
      },
    },
    auditLog: { create: async () => ({}) },
  };
  return { prisma };
});

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

beforeEach(() => {
  ROWS.length = 0;
});

async function tokenFor(role: string): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub: 'user-' + role, role });
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerFrameCodeRoutes } = await import('../../src/routes/frameCode.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerFrameCodeRoutes(app);
  await app.ready();
  return app;
}

const withB = {
  ...DEFAULT_FRAME_CODE_CONVENTION,
  segments: ['shape', 'dimensions', 'features'],
  features: DEFAULT_FRAME_CODE_CONVENTION.features.map((f) =>
    f.key === 'monkeyBars' ? { ...f, letter: 'b' } : f,
  ),
};

describe('frame naming — permissions', () => {
  it.each(['SALES_REP', 'EXECUTIVE'])('refuses %s, read and write', async (role) => {
    const app = await makeApp();
    const headers = { authorization: 'Bearer ' + (await tokenFor(role)) };
    expect(
      (await app.inject({ method: 'GET', url: '/frame-code/convention', headers })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/frame-code/convention',
          headers,
          payload: { convention: withB },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });
});

describe('frame naming — versions', () => {
  it('starts on the built-in default, version 1', async () => {
    const app = await makeApp();
    const headers = { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) };
    const res = await app.inject({ method: 'GET', url: '/frame-code/convention', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.active.version).toBe(1);
    expect(body.samples[0].code).toBe('SQ-H2MBL2T2-10x10');
    await app.close();
  });

  it('saves a change as version 2, then 3, uppercasing letters', async () => {
    const app = await makeApp();
    const headers = { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) };
    const first = await app.inject({
      method: 'PUT',
      url: '/frame-code/convention',
      headers,
      payload: { convention: withB, note: 'B for monkey bars' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().active.version).toBe(2);
    expect(first.json().samples[0].code).toBe('SQ-10x10-H2BL2T2');
    const second = await app.inject({
      method: 'PUT',
      url: '/frame-code/convention',
      headers,
      payload: { convention: DEFAULT_FRAME_CODE_CONVENTION },
    });
    expect(second.json().active.version).toBe(3);
    expect(ROWS.map((r) => r.version)).toEqual([2, 3]);
    await app.close();
  });

  it('refuses a convention whose codes could be read two ways', async () => {
    const app = await makeApp();
    const headers = { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) };
    const bad = {
      ...DEFAULT_FRAME_CODE_CONVENTION,
      features: DEFAULT_FRAME_CODE_CONVENTION.features.map((f) =>
        f.key === 'monkeyBars'
          ? { ...f, letter: 'B' }
          : f.key === 'ballRack'
            ? { ...f, letter: 'BR' }
            : f,
      ),
    };
    const preview = await app.inject({
      method: 'POST',
      url: '/frame-code/convention/preview',
      headers,
      payload: bad,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().problems.join(' ')).toMatch(/start of/);
    const save = await app.inject({
      method: 'PUT',
      url: '/frame-code/convention',
      headers,
      payload: { convention: bad },
    });
    expect(save.statusCode).toBe(400);
    expect(ROWS).toHaveLength(0);
    await app.close();
  });
});
