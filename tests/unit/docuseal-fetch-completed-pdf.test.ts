import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

async function makePdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

const ORIGINAL_TOKEN = process.env.DOCUSEAL_API_TOKEN;

describe('fetchCompletedPdf', () => {
  beforeEach(() => {
    process.env.DOCUSEAL_API_TOKEN = 'test-token';
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.DOCUSEAL_API_TOKEN;
    else process.env.DOCUSEAL_API_TOKEN = ORIGINAL_TOKEN;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('merges every document on the submission, in order, and never fetches combined_document_url', async () => {
    const pageA = await makePdf(2);
    const pageB = await makePdf(1);

    const fakeFetch = vi.fn(async (url: string) => {
      if (url === 'https://api.docuseal.com/submissions/999') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 999,
            documents: [
              { name: 'doc-a', url: 'https://docs.example/a.pdf' },
              { name: 'doc-b', url: 'https://docs.example/b.pdf' },
            ],
            // Deliberately present but must never be fetched — see
            // fetchCompletedPdf's own comment for why.
            combined_document_url: 'https://docs.example/combined.pdf',
          }),
        };
      }
      if (url === 'https://docs.example/a.pdf') {
        return { ok: true, status: 200, arrayBuffer: async () => pageA };
      }
      if (url === 'https://docs.example/b.pdf') {
        return { ok: true, status: 200, arrayBuffer: async () => pageB };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fakeFetch);

    const { fetchCompletedPdf } = await import('../../src/integrations/docuseal/client.js');
    const result = await fetchCompletedPdf(999);

    expect(result).not.toBeNull();
    expect(result!.filename).toBe('doc-a.pdf');
    const merged = await PDFDocument.load(result!.bytes);
    expect(merged.getPageCount()).toBe(2 + 1);
    expect(fakeFetch).not.toHaveBeenCalledWith(
      'https://docs.example/combined.pdf',
      expect.anything(),
    );
  });

  it('returns a single document unmerged when there is only one', async () => {
    const onlyPage = await makePdf(4);
    const fakeFetch = vi.fn(async (url: string) => {
      if (url === 'https://api.docuseal.com/submissions/1000') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 1000,
            documents: [{ name: 'signed', url: 'https://docs.example/signed.pdf' }],
          }),
        };
      }
      if (url === 'https://docs.example/signed.pdf') {
        return { ok: true, status: 200, arrayBuffer: async () => onlyPage };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fakeFetch);

    const { fetchCompletedPdf } = await import('../../src/integrations/docuseal/client.js');
    const result = await fetchCompletedPdf(1000);

    expect(result).not.toBeNull();
    const doc = await PDFDocument.load(result!.bytes);
    expect(doc.getPageCount()).toBe(4);
  });

  it('returns null when the submission has no documents yet', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 1001, documents: [] }),
    }));
    vi.stubGlobal('fetch', fakeFetch);

    const { fetchCompletedPdf } = await import('../../src/integrations/docuseal/client.js');
    const result = await fetchCompletedPdf(1001);

    expect(result).toBeNull();
  });
});
