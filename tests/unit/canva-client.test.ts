import { describe, it, expect } from 'vitest';
import {
  assetUploadMetadata,
  CanvaError,
  createCanvaClient,
} from '../../src/integrations/canva/client.js';

/**
 * The Canva client against a stub fetch. Nothing here reaches Canva: the point is
 * the request shapes (paths, headers, bodies) and the failure handling.
 */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(
  responses: Array<{
    status: number;
    json?: unknown;
    text?: string;
    headers?: Record<string, string>;
  }>,
) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    const r = responses.shift();
    if (!r) throw new Error('unexpected request ' + url);
    const body = r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? '');
    return new Response(body, { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(f: typeof fetch) {
  return createCanvaClient({
    baseUrl: 'https://api.canva.test/rest/',
    accessToken: async () => 'tok',
    fetchImpl: f,
    sleep: async () => undefined,
  });
}

describe('canva client', () => {
  it('reads a brand template dataset with a bearer token', async () => {
    const { impl, calls } = stubFetch([
      {
        status: 200,
        json: { dataset: { COVER: { type: 'text' }, CUSTOMER_LOGO: { type: 'image' } } },
      },
    ]);
    const ds = await client(impl).getBrandTemplateDataset('BT 1');
    expect(ds.COVER?.type).toBe('text');
    expect(calls[0]!.url).toBe('https://api.canva.test/rest/v1/brand-templates/BT%201/dataset');
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
  });

  it('starts an autofill with the brand template, title and data', async () => {
    const { impl, calls } = stubFetch([
      { status: 200, json: { job: { id: 'j1', status: 'in_progress' } } },
    ]);
    const job = await client(impl).startAutofill({
      brandTemplateId: 'BT',
      title: 'Treetop + Summit',
      data: { COVER: { type: 'text', text: 'Hi' } },
    });
    expect(job.id).toBe('j1');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toMatch(/\/v1\/autofills$/);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      brand_template_id: 'BT',
      title: 'Treetop + Summit',
      data: { COVER: { type: 'text', text: 'Hi' } },
    });
  });

  it('uploads an asset as octet-stream with base64 name metadata', async () => {
    const { impl, calls } = stubFetch([
      { status: 200, json: { job: { id: 'a1', status: 'in_progress' } } },
    ]);
    await client(impl).startAssetUpload('SPP-2026-0001 CUSTOMER_LOGO', Buffer.from([1, 2, 3]));
    expect(calls[0]!.headers['Content-Type']).toBe('application/octet-stream');
    const meta = JSON.parse(calls[0]!.headers['Asset-Upload-Metadata']!) as { name_base64: string };
    expect(Buffer.from(meta.name_base64, 'base64').toString()).toBe('SPP-2026-0001 CUSTOMER_LOGO');
    expect(Array.from(calls[0]!.body as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('asks for a PDF export of the design', async () => {
    const { impl, calls } = stubFetch([
      { status: 200, json: { job: { id: 'e1', status: 'in_progress' } } },
    ]);
    await client(impl).startPdfExport('D1');
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      design_id: 'D1',
      format: { type: 'pdf', export_quality: 'regular' },
    });
  });

  it('retries a 429 and a 5xx, then succeeds', async () => {
    const { impl, calls } = stubFetch([
      { status: 429, text: 'slow down', headers: { 'retry-after': '1' } },
      { status: 503, text: 'busy' },
      { status: 200, json: { job: { id: 'j', status: 'success' } } },
    ]);
    const job = await client(impl).getAutofill('j');
    expect(job.status).toBe('success');
    expect(calls).toHaveLength(3);
  });

  it('reports a 4xx with Canva’s own message and code', async () => {
    const { impl } = stubFetch([
      {
        status: 403,
        json: { code: 'permission_denied', message: 'Autofill requires Canva Enterprise' },
      },
    ]);
    const err = await client(impl)
      .startAutofill({ brandTemplateId: 'x', title: 't', data: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CanvaError);
    expect((err as CanvaError).status).toBe(403);
    expect((err as CanvaError).code).toBe('permission_denied');
    expect((err as CanvaError).message).toContain('Canva Enterprise');
  });

  it('only downloads exports over HTTPS', async () => {
    const { impl } = stubFetch([]);
    await expect(client(impl).download('http://example.com/x.pdf')).rejects.toThrow(/non-HTTPS/);
  });

  it('clips the asset name to Canva’s limit', () => {
    const meta = JSON.parse(assetUploadMetadata('x'.repeat(80))) as { name_base64: string };
    expect(Buffer.from(meta.name_base64, 'base64').toString()).toHaveLength(50);
  });
});
