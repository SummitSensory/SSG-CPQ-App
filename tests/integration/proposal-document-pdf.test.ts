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

vi.mock('../../src/render/pdf.js', () => ({ renderPdf, pdfAvailable: async () => true }));
vi.mock('../../src/lib/pdfMerge.js', () => ({ appendPdfDocuments }));
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

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

beforeEach(() => {
  renderPdf.mockClear();
  appendPdfDocuments.mockClear();
  resolveReferenceDocuments.mockClear();
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
});
