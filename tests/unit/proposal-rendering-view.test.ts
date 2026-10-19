import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Opening a design rendering (src/routes/proposalRenderings.ts → /view and /file).
 *
 * Renderings are stored private, and the screen linked straight to the stored URL, so
 * clicking a rendering's name opened an empty tab. These routes hand the browser a
 * short-lived presigned link, or stream the file when no link can be made. Blob
 * storage, the database and the permission check are stubbed; nothing leaves the box.
 */

const h = vi.hoisted(() => ({
  presignFails: false,
  issued: [] as Array<Record<string, unknown>>,
  presigned: [] as Array<Record<string, unknown>>,
  blobGone: false,
}));

const ROW = {
  id: 'rnd1',
  proposalId: 'prop1',
  filename: '1-Apple Education Consulting R-3MBL2Z-20X10.png',
  contentType: 'image/png',
  byteSize: 5,
  url: 'https://store.private.blob.vercel-storage.com/design-renderings/P-2026-000199/x.png',
  pathname: 'design-renderings/P-2026-000199/x.png',
  sortOrder: 0,
};

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get(target, prop, receiver) {
        if (prop === 'BLOB_READ_WRITE_TOKEN') return 'vercel_blob_rw_test_token';
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
  };
});

vi.mock('../../src/plugins/authz.js', () => ({
  requirePermission: () => async () => undefined,
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    proposal: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'prop1' || where.id === 'prop2' ? { id: where.id, number: 'P' } : null,
    },
    proposalRendering: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === ROW.id ? ROW : null,
    },
  },
}));

vi.mock('@vercel/blob', async (orig) => {
  const real = await orig<typeof import('@vercel/blob')>();
  return {
    ...real,
    issueSignedToken: async (opts: Record<string, unknown>) => {
      h.issued.push(opts);
      if (h.presignFails) throw new Error('signed tokens not enabled for this store');
      return { delegationToken: 'dt', clientSigningToken: 'cst' };
    },
    presignUrl: async (_t: unknown, opts: Record<string, unknown>) => {
      h.presigned.push(opts);
      return {
        presignedUrl: `https://store.private.blob.vercel-storage.com/${String(opts.pathname)}?sig=abc`,
      };
    },
    get: async () =>
      h.blobGone
        ? null
        : {
            statusCode: 200,
            stream: new Blob([new Uint8Array([1, 2, 3, 4, 5])]).stream(),
            headers: new Headers(),
            blob: { contentType: 'image/png', size: 5 },
          },
  };
});

let app: FastifyInstance;

beforeAll(async () => {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerProposalRenderingRoutes } =
    await import('../../src/routes/proposalRenderings.js');
  app = Fastify();
  registerErrorHandler(app);
  registerProposalRenderingRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.presignFails = false;
  h.blobGone = false;
  h.issued.length = 0;
  h.presigned.length = 0;
});

describe('opening a rendering', () => {
  it('hands back a presigned, read-only, short-lived link for that one file', async () => {
    const before = Date.now();
    const res = await app.inject({ method: 'GET', url: '/proposals/prop1/renderings/rnd1/view' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ url: string; filename: string }>();
    expect(body.url).toContain('?sig=');
    expect(body.url).not.toBe(ROW.url);
    expect(body.filename).toBe(ROW.filename);
    expect(h.issued[0]).toMatchObject({ pathname: ROW.pathname, operations: ['get'] });
    expect(h.presigned[0]).toMatchObject({
      operation: 'get',
      pathname: ROW.pathname,
      access: 'private',
    });
    const until = h.issued[0]!.validUntil as number;
    expect(until).toBeGreaterThan(before);
    expect(until).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
  });

  it('answers null rather than failing when no link can be made', async () => {
    h.presignFails = true;
    const res = await app.inject({ method: 'GET', url: '/proposals/prop1/renderings/rnd1/view' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ url: string | null }>().url).toBeNull();
  });

  it('streams the file itself, inline, with its name', async () => {
    const res = await app.inject({ method: 'GET', url: '/proposals/prop1/renderings/rnd1/file' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="1-Apple Education/);
    expect([...res.rawPayload]).toEqual([1, 2, 3, 4, 5]);
  });

  it('is a 404 for a rendering that belongs to another proposal, or is gone', async () => {
    for (const url of [
      '/proposals/prop2/renderings/rnd1/view',
      '/proposals/prop2/renderings/rnd1/file',
      '/proposals/prop1/renderings/nope/view',
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    h.blobGone = true;
    expect(
      (await app.inject({ method: 'GET', url: '/proposals/prop1/renderings/rnd1/file' }))
        .statusCode,
    ).toBe(404);
  });
});
