import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * POST /render/proposals/document.pdf — the preview's and builder's "Save PDF".
 * The browser renderer and the storage-backed reference documents are stubbed:
 * what is under test is the route's contract (auth, validation, the geometry it
 * asks the renderer for, the reference-document merge and its failure path, and
 * the download filename).
 */

const renderPdf = vi.fn(async () => Buffer.from('%PDF-proposal'));
const appendPdfDocuments = vi.fn(async (pdf: Buffer) => Buffer.concat([pdf, Buffer.from('+ref')]));
const resolveReferenceDocuments = vi.fn(async (keys: string[]) => keys.map(() => Buffer.from('')));
const setPdfTitle = vi.fn(async (pdf: Buffer, _title: string) => pdf);
const warmRenderer = vi.fn(async () => ({ ok: true, reused: false, ms: 5 }));

vi.mock('../../src/render/pdf.js', () => ({
  renderPdf,
  warmRenderer,
  pdfAvailable: async () => true,
}));
vi.mock('../../src/lib/pdfMerge.js', () => ({ appendPdfDocuments, setPdfTitle }));
vi.mock('../../src/proposals/referenceDocuments.js', () => ({ resolveReferenceDocuments }));
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

// The first import of the render routes pulls in the whole renderer module graph —
// over a second on its own, and past the 5s test timeout when the full suite runs in
// parallel. Loaded once here, with room for it, so no single test pays for it.
beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
  await (await makeApp()).close();
}, 30_000);

beforeEach(() => {
  renderPdf.mockClear();
  appendPdfDocuments.mockClear();
  resolveReferenceDocuments.mockClear();
  setPdfTitle.mockClear();
  warmRenderer.mockClear();
});

async function auth(role = 'SALES_REP'): Promise<Record<string, string>> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return { authorization: 'Bearer ' + (await signAccessToken({ sub: 'user-' + role, role })) };
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

const URL = '/render/proposals/document.pdf';

describe('POST /render/proposals/document.pdf', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: URL,
      payload: { proposalHtml: '<p>x</p>' },
    });
    expect(res.statusCode).toBe(401);
    expect(renderPdf).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a request without the document', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: URL, headers: await auth(), payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('renders edge-to-edge Letter and returns it as a named download', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: await auth(),
      payload: {
        proposalHtml: '<p>proposal</p>',
        filename: 'Firefly Autism-Summit Foundation System-P-2026-000160-09242026.pdf',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(renderPdf).toHaveBeenCalledWith('<p>proposal</p>', {
      format: 'Letter',
      edgeToEdge: true,
    });
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="Firefly Autism-Summit Foundation System-P-2026-000160-09242026.pdf"',
    );
    expect(res.rawPayload.toString()).toBe('%PDF-proposal');
    // Print prints this same PDF, and the print dialog names it after its Title.
    expect(setPdfTitle).toHaveBeenCalledWith(
      expect.any(Buffer),
      'Firefly Autism-Summit Foundation System-P-2026-000160-09242026',
    );
    expect(resolveReferenceDocuments).not.toHaveBeenCalled();
    expect(res.headers['x-reference-docs-missing']).toBeUndefined();
    await app.close();
  });

  it('strips characters that would break the Content-Disposition header', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: await auth(),
      payload: { proposalHtml: '<p>x</p>', filename: 'Bad"Name\r\nX-Evil: 1' },
    });
    expect(res.headers['content-disposition']).toBe('attachment; filename="BadNameX-Evil 1.pdf"');
    expect(res.headers['x-evil']).toBeUndefined();
    await app.close();
  });

  it('appends the reference documents, ignoring keys that are not strings', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: await auth(),
      payload: { proposalHtml: '<p>x</p>', referenceDocKeys: ['w9', 42, null] },
    });
    expect(res.statusCode).toBe(200);
    expect(resolveReferenceDocuments).toHaveBeenCalledWith(['w9']);
    expect(res.rawPayload.toString()).toBe('%PDF-proposal+ref');
    expect(res.headers['x-reference-docs-missing']).toBeUndefined();
    await app.close();
  });

  it('still returns the proposal, flagged, when a reference document cannot be read', async () => {
    resolveReferenceDocuments.mockRejectedValueOnce(new Error('storage unreachable'));
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: await auth(),
      payload: { proposalHtml: '<p>x</p>', referenceDocKeys: ['w9'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString()).toBe('%PDF-proposal');
    expect(res.headers['x-reference-docs-missing']).toBe('1');
    await app.close();
  });

  it('stamps the Title after the reference documents are attached, so it survives the merge', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: URL,
      headers: await auth(),
      payload: { proposalHtml: '<p>x</p>', filename: 'Name', referenceDocKeys: ['w9'] },
    });
    expect(setPdfTitle).toHaveBeenCalledWith(Buffer.from('%PDF-proposal+ref'), 'Name');
    await app.close();
  });
});

describe('GET /render/warm', () => {
  it('starts the renderer for a signed-in rep', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/render/warm', headers: await auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, reused: false, ms: 5 });
    expect(warmRenderer).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('refuses an unauthenticated request', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/render/warm' });
    expect(res.statusCode).toBe(401);
    expect(warmRenderer).not.toHaveBeenCalled();
    await app.close();
  });
});
