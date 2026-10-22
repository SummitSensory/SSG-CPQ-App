import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_FRAME_CODE_CONVENTION } from '../../src/proposals/frameCode.js';
import { DEFAULT_CLARITY_PAGE } from '../../src/proposals/clarityPages.js';

/**
 * The proposal clarity pages (What's Included / Before You Sign).
 *
 *  - POST /proposals/clarity-pages is open to anyone who can read proposals and reads
 *    the code by the newest convention version it fits;
 *  - the page wording is saved with the frame naming convention, as a new version, and
 *    a code written before the change keeps its own version's wording;
 *  - wording with duplicate page orders is refused.
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
  const { registerClarityPageRoutes } = await import('../../src/routes/clarityPages.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerFrameCodeRoutes(app);
  registerClarityPageRoutes(app);
  await app.ready();
  return app;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function pages(app: FastifyInstance, code: string, role = 'SALES_REP') {
  return app.inject({
    method: 'POST',
    url: '/proposals/clarity-pages',
    headers: { authorization: 'Bearer ' + (await tokenFor(role)) },
    payload: { code, lines: [{ lineType: 'PRODUCT', sku: 'SSG-SA-CWM', quantity: 1 }] },
  });
}

describe('POST /proposals/clarity-pages', () => {
  it('a sales rep gets the decoded pages for the reference proposal', async () => {
    const app = await makeApp();
    const res = await pages(app, 'R-2MBL1Z-10x8');
    expect(res.statusCode).toBe(200);
    const s = res.json().snapshot;
    expect(s.code).toBe('R-2MBL1Z-10x8');
    expect(s.frameRows.map((r: { badge: string }) => r.badge)).toEqual(['R', '2', 'MB', 'L1', 'Z']);
    expect(s.componentRows.map((r: { name: string }) => r.name)).toEqual([
      'Climbing Wall: Wall Mounted',
    ]);
  });

  it('answers null for a heading that is not a frame code', async () => {
    const app = await makeApp();
    const res = await pages(app, 'Frame Configuration');
    expect(res.statusCode).toBe(200);
    expect(res.json().snapshot).toBeNull();
  });

  it('needs a signed-in user', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/proposals/clarity-pages',
      payload: { code: 'SQ-10x10', lines: [] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('page wording saved with the convention', () => {
  it('GET returns the default wording on the built-in version', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/frame-code/convention',
      headers: { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().active.convention.page.text.includedHeading).toBe(
      "What's Included in Your Proposal",
    );
    expect(res.json().labels.icons).toContain('ladder');
  });

  it('MB → M saved as version 2: new codes read by it, old codes keep version 1 wording', async () => {
    const app = await makeApp();
    const c = clone(DEFAULT_FRAME_CODE_CONVENTION);
    c.features.find((f) => f.key === 'monkeyBars')!.letter = 'M';
    const page = clone(DEFAULT_CLARITY_PAGE);
    page.features.monkeyBars.displayName = 'Overhead Monkey Bars';
    const put = await app.inject({
      method: 'PUT',
      url: '/frame-code/convention',
      headers: { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) },
      payload: { convention: { ...c, page }, note: 'test' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().active.version).toBe(2);

    const fresh = (await pages(app, 'R-H2ML1-10x8')).json().snapshot;
    expect(fresh.conventionVersion).toBe(2);
    expect(fresh.frameRows.find((r: { key: string }) => r.key === 'monkeyBars').name).toBe(
      'Overhead Monkey Bars',
    );

    const old = (await pages(app, 'R-H2MBL1-10x8')).json().snapshot;
    expect(old.conventionVersion).toBe(1);
    expect(old.frameRows.find((r: { key: string }) => r.key === 'monkeyBars').name).toBe(
      'Monkey Bars',
    );
  });

  it('refuses duplicate page orders, and the preview reports them', async () => {
    const app = await makeApp();
    const page = clone(DEFAULT_CLARITY_PAGE);
    page.features.ladders.pageOrder = page.features.beams.pageOrder;
    const auth = { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) };
    const preview = await app.inject({
      method: 'POST',
      url: '/frame-code/convention/preview',
      headers: auth,
      payload: { ...DEFAULT_FRAME_CODE_CONVENTION, page },
    });
    expect(preview.json().problems.join(' ')).toMatch(/page order 20/);
    const put = await app.inject({
      method: 'PUT',
      url: '/frame-code/convention',
      headers: auth,
      payload: { convention: { ...DEFAULT_FRAME_CODE_CONVENTION, page } },
    });
    expect(put.statusCode).toBe(400);
    expect(ROWS).toHaveLength(0);
  });

  it('the preview includes the first sample’s What’s Included rows', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/frame-code/convention/preview',
      headers: { authorization: 'Bearer ' + (await tokenFor('SYSTEM_ADMIN')) },
      payload: { ...DEFAULT_FRAME_CODE_CONVENTION, page: DEFAULT_CLARITY_PAGE },
    });
    expect(res.json().pageSample.code).toBe('SQ-H2MBL2T2-10x10');
    expect(res.json().pageSample.frameRows[0].name).toBe('Square Frame');
  });
});
