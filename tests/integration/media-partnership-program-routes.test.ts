import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_MEDIA_PROGRAM_CONTENT } from '../../src/mediaRebate/defaults.js';

/**
 * Permission gating and versioning for the Media Partnership Program (the Customer
 * Project Media Rebate) — see CLAUDE.md's spec. The behaviour worth proving here:
 *
 *  - only SYSTEM_ADMIN (MEDIA_PARTNERSHIP_MANAGE) can change the global defaults;
 *  - any signed-in role with PROPOSAL_READ can read the effective/pinned answers;
 *  - a proposal version's pinned snapshot does not change when the global settings
 *    are edited afterward — the non-negotiable requirement from spec section 11.
 *
 * Prisma is a plain stub, not a mock library, following part-integrity.test.ts's own
 * note on the convention this repo uses.
 */

let PROGRAM: Record<string, unknown> | null = null;
const SNAPSHOTS = new Map<string, Record<string, unknown>>();
const VERSIONS = new Map<string, Record<string, unknown>>();

vi.mock('../../src/lib/prisma.js', () => {
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
    mediaPartnershipProgram: {
      findUnique: async () => PROGRAM,
      upsert: async ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        PROGRAM = PROGRAM ? { ...PROGRAM, ...update } : { ...create };
        return PROGRAM;
      },
    },
    mediaRebateSnapshot: {
      findUnique: async ({ where }: { where: { id?: string; hash?: string } }) => {
        if (where.id) return SNAPSHOTS.get(where.id) ?? null;
        if (where.hash) {
          for (const s of SNAPSHOTS.values()) if (s.hash === where.hash) return s;
        }
        return null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = 'snap-' + (SNAPSHOTS.size + 1);
        const row = { id, ...data };
        SNAPSHOTS.set(id, row);
        return row;
      },
    },
    proposalVersion: {
      findUnique: async ({ where }: { where: { id: string } }) => VERSIONS.get(where.id) ?? null,
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

async function tokenFor(role: string): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub: 'user-' + role, role });
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerMediaPartnershipProgramRoutes } =
    await import('../../src/routes/mediaPartnershipProgram.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerMediaPartnershipProgramRoutes(app);
  await app.ready();
  return app;
}

const validBody = {
  active: true,
  customerFacingName: 'Customer Project Media Rebate',
  internalName: 'Media Partnership Program',
  rebateAmountMinor: 25_000,
  content: DEFAULT_MEDIA_PROGRAM_CONTENT,
};

describe('PUT /media-partnership-program — permissions', () => {
  it('rejects a non-admin (SALES_REP) with 403', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/media-partnership-program',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
      payload: validBody,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects an unauthenticated request with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/media-partnership-program',
      payload: validBody,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('allows SYSTEM_ADMIN to save, bumping the version', async () => {
    PROGRAM = null;
    const app = await makeApp();
    const admin = { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) };
    const first = await app.inject({
      method: 'PUT',
      url: '/media-partnership-program',
      headers: admin,
      payload: validBody,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(1);

    const second = await app.inject({
      method: 'PUT',
      url: '/media-partnership-program',
      headers: admin,
      payload: { ...validBody, rebateAmountMinor: 30_000 },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().version).toBe(2);
    expect(second.json().rebateAmountMinor).toBe(30_000);
    await app.close();
  });
});

describe('GET /media-partnership-program/effective', () => {
  it('is reachable by any role with PROPOSAL_READ (e.g. SALES_REP)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/media-partnership-program/effective',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('active');
    await app.close();
  });
});

describe('versioning — a released version keeps its pinned wording', () => {
  it('does not change after the global settings are edited again', async () => {
    PROGRAM = null;
    SNAPSHOTS.clear();
    VERSIONS.clear();
    const app = await makeApp();
    const admin = { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) };

    // Publish version 1, and pretend a proposal was released under it — the same
    // hash/payload shape src/mediaRebate/service.ts's snapshotMediaRebateProgram
    // would have written into MediaRebateSnapshot at release time.
    await app.inject({
      method: 'PUT',
      url: '/media-partnership-program',
      headers: admin,
      payload: validBody,
    });
    const payload = {
      customerFacingName: validBody.customerFacingName,
      internalName: validBody.internalName,
      rebateAmountMinor: validBody.rebateAmountMinor,
      content: validBody.content,
      version: 1,
    };
    SNAPSHOTS.set('snap-pinned', { id: 'snap-pinned', hash: 'h1', payload });
    VERSIONS.set('v1', {
      sections: [{ id: 'meta', data: { mediaRebate: { offered: true, participate: true } } }],
      mediaRebateSnapshotId: 'snap-pinned',
    });

    const before = await app.inject({
      method: 'GET',
      url: '/proposals/versions/v1/media-rebate',
      headers: admin,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().pinned).toBe(true);
    expect(before.json().program.rebateAmountMinor).toBe(25_000);

    // Now change the global default — must not retroactively alter the pinned version.
    await app.inject({
      method: 'PUT',
      url: '/media-partnership-program',
      headers: admin,
      payload: { ...validBody, rebateAmountMinor: 99_999, customerFacingName: 'Changed Name' },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/proposals/versions/v1/media-rebate',
      headers: admin,
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().pinned).toBe(true);
    expect(after.json().program.rebateAmountMinor).toBe(25_000);
    expect(after.json().program.customerFacingName).toBe('Customer Project Media Rebate');
    await app.close();
  });

  it('an unoffered version reports offered:false and is never pinned', async () => {
    VERSIONS.set('v2', {
      sections: [{ id: 'meta', data: {} }],
      mediaRebateSnapshotId: null,
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/proposals/versions/v2/media-rebate',
      headers: { authorization: 'Bearer ' + (await tokenFor('SALES_REP')) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pinned: false, offered: false, participate: false });
    await app.close();
  });
});
