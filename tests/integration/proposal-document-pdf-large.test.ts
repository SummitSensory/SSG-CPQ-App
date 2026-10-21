import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Save PDF for a document too big for one Vercel function response (a product
 * catalog attached as a reference document): the route parks it in the blob store
 * and the browser reads it back in parts. The store is an in-memory map here.
 */

const BIG = Buffer.alloc(7 * 1024 * 1024 + 123, 7);
const store = new Map<string, Buffer>();
const putFile = vi.fn(async (pathname: string, bytes: Buffer) => {
  store.set(pathname, Buffer.from(bytes));
  return {
    url: `https://store.private.blob.vercel-storage.com/${pathname}`,
    pathname,
    bytes: bytes.length,
  };
});
const blobGet = vi.fn(async (pathname: string) => {
  const b = store.get(pathname);
  if (!b) return null;
  return { statusCode: 200, stream: new Blob([b]).stream() };
});
const blobDel = vi.fn(async (pathname: string) => {
  store.delete(pathname);
});

vi.mock('@vercel/blob', async (orig) => ({
  ...(await orig<typeof import('@vercel/blob')>()),
  get: blobGet,
  del: blobDel,
}));

vi.mock('../../src/render/pdf.js', () => ({
  renderPdf: async () => BIG,
  warmRenderer: async () => ({ ok: true }),
  pdfAvailable: async () => true,
}));
vi.mock('../../src/lib/pdfMerge.js', () => ({
  appendPdfDocuments: async (pdf: Buffer) => pdf,
  setPdfTitle: async (pdf: Buffer) => pdf,
}));
vi.mock('../../src/proposals/referenceDocuments.js', () => ({
  resolveReferenceDocuments: async () => [],
}));
vi.mock('../../src/lib/fileStore.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/fileStore.js')>()),
  isFileStoreConfigured: () => true,
  putFile,
}));
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
  },
}));

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
  await (await makeApp()).close();
}, 30_000);

async function auth(): Promise<Record<string, string>> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  const token = await signAccessToken({ sub: 'user-SALES_REP', role: 'SALES_REP' });
  return { authorization: 'Bearer ' + token };
}

async function makeApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerRenderRoutes } = await import('../../src/routes/render.js');
  const app = Fastify();
  registerErrorHandler(app);
  registerRenderRoutes(app);
  await app.ready();
  return app;
}

const partUrl = (ticket: string, part: number) =>
  `/render/proposals/document-part?ticket=${encodeURIComponent(ticket)}&part=${part}`;

describe('Save PDF past the function response limit', () => {
  it('parks the PDF and hands it back in parts that reassemble exactly', async () => {
    const app = await makeApp();
    const headers = await auth();
    const res = await app.inject({
      method: 'POST',
      url: '/render/proposals/document.pdf',
      headers,
      payload: { proposalHtml: '<p>x</p>', filename: 'Big', referenceDocKeys: ['CATALOG'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      parked: { ticket: string; bytes: number; parts: number };
      missingReferenceDocs: boolean;
    }>();
    expect(body.parked.bytes).toBe(BIG.length);
    expect(body.parked.parts).toBe(3);
    expect(body.missingReferenceDocs).toBe(false);

    const parts: Buffer[] = [];
    for (let i = 0; i < body.parked.parts; i++) {
      const pr = await app.inject({ method: 'GET', url: partUrl(body.parked.ticket, i), headers });
      expect(pr.statusCode).toBe(200);
      expect(pr.rawPayload.length).toBeLessThanOrEqual(4 * 1024 * 1024);
      parts.push(pr.rawPayload);
    }
    expect(Buffer.concat(parts).equals(BIG)).toBe(true);
    // The parked copy only existed for this download.
    expect(blobDel).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
    // Only ever the fixed parking folder.
    expect(putFile.mock.calls[0]![0]).toMatch(/^rendered-pdfs\/[a-f0-9]{24}\.pdf$/);
    await app.close();
  });

  it('refuses a ticket it did not sign, and an anonymous caller', async () => {
    const app = await makeApp();
    const forged =
      Buffer.from(
        JSON.stringify({ id: '../purchase-orders/x', exp: Date.now() + 60_000 }),
      ).toString('base64url') + '.not-a-signature';
    const bad = await app.inject({ method: 'GET', url: partUrl(forged, 0), headers: await auth() });
    expect(bad.statusCode).toBe(400);
    const anon = await app.inject({ method: 'GET', url: partUrl('x', 0) });
    expect(anon.statusCode).toBe(401);
    expect(blobGet).not.toHaveBeenCalledWith(
      expect.stringContaining('purchase-orders'),
      expect.anything(),
    );
    await app.close();
  });
});
