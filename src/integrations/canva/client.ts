/**
 * Canva Connect REST client — the calls Strategic Partnership Proposals need and
 * nothing else: read a brand template's dataset, upload an image asset, run an
 * Autofill job, export a design as PDF, and poll each job.
 *
 * Plain HTTPS with a bearer token, deliberately not the Canva MCP server (the same
 * reasoning as the DocuSeal client): a production run must not depend on an agent
 * transport or an interactive prompt.
 *
 * Everything that touches the network is injected — `fetch` and the access-token
 * provider — so the orchestration is tested against a stub, and nothing in the test
 * suite can reach Canva.
 *
 * Every Canva operation here is asynchronous on Canva's side: a POST returns a job,
 * and a GET on the job reports `in_progress`, `success` or `failed`. The client does
 * NOT loop waiting for a job; one call is one request. The caller (service.ts) polls
 * across short requests, because a Vercel function has a 30-second budget and an
 * Autofill plus a PDF export can take longer than that.
 */
import { logger } from '../../lib/logger.js';

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

export class CanvaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CanvaError';
  }
}

export type JobStatus = 'in_progress' | 'success' | 'failed';

export interface CanvaJobError {
  code?: string;
  message?: string;
}

export type DatasetFieldType = 'text' | 'image' | 'chart';
export type BrandTemplateDataset = Record<string, { type: DatasetFieldType }>;

export type ChartCell =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean };

export interface ChartData {
  rows: Array<{ cells: ChartCell[] }>;
}

export type AutofillValue =
  | { type: 'text'; text: string }
  | { type: 'image'; asset_id: string }
  | { type: 'chart'; chart_data: ChartData };

export interface CanvaDesignRef {
  id: string;
  title?: string;
  url?: string;
  urls?: { edit_url?: string; view_url?: string };
}

export interface AssetUploadJob {
  id: string;
  status: JobStatus;
  asset?: { id: string };
  error?: CanvaJobError;
}

export interface AutofillJob {
  id: string;
  status: JobStatus;
  result?: { type?: string; design?: CanvaDesignRef };
  error?: CanvaJobError;
}

export interface ExportJob {
  id: string;
  status: JobStatus;
  urls?: string[];
  error?: CanvaJobError;
}

/** The surface service.ts depends on; a test passes its own implementation. */
export interface CanvaApi {
  getBrandTemplateDataset(brandTemplateId: string): Promise<BrandTemplateDataset>;
  startAssetUpload(name: string, bytes: Buffer): Promise<AssetUploadJob>;
  getAssetUpload(jobId: string): Promise<AssetUploadJob>;
  startAutofill(input: {
    brandTemplateId: string;
    title: string;
    data: Record<string, AutofillValue>;
  }): Promise<AutofillJob>;
  getAutofill(jobId: string): Promise<AutofillJob>;
  startPdfExport(designId: string): Promise<ExportJob>;
  getExport(jobId: string): Promise<ExportJob>;
  /** Download an export URL Canva handed back (a short-lived signed URL, no auth). */
  download(url: string): Promise<Buffer>;
}

export interface CanvaClientOptions {
  baseUrl: string;
  accessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function backoff(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/** Canva's asset-upload metadata header carries the name base64-encoded, max 50 chars. */
export function assetUploadMetadata(name: string): string {
  const clipped = name.slice(0, 50) || 'image';
  return JSON.stringify({ name_base64: Buffer.from(clipped, 'utf8').toString('base64') });
}

export function createCanvaClient(opts: CanvaClientOptions): CanvaApi {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function request<T>(
    path: string,
    init: {
      method?: string;
      json?: unknown;
      raw?: { body: Buffer; headers: Record<string, string> };
    },
  ): Promise<T> {
    const method = init.method ?? 'GET';
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const token = await opts.accessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };
      let body: Uint8Array | string | undefined;
      if (init.raw) {
        Object.assign(headers, init.raw.headers);
        body = new Uint8Array(init.raw.body);
      } else if (init.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(init.json);
      }
      const res = await fetchImpl(`${base}${path}`, { method, headers, body });
      if (res.status === 429 || res.status >= 500) {
        const wait = backoff(attempt, Number(res.headers.get('retry-after') ?? '') || undefined);
        logger.warn({ attempt, status: res.status, path, wait }, 'canva: retrying');
        lastErr = new CanvaError(`Canva HTTP ${res.status}`, res.status);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let code: string | undefined;
        let message = text.slice(0, 500);
        try {
          const j = JSON.parse(text) as { code?: string; message?: string };
          code = j.code;
          if (j.message) message = j.message;
        } catch {
          /* not JSON — keep the text */
        }
        throw new CanvaError(`Canva HTTP ${res.status}: ${message}`, res.status, code);
      }
      return (await res.json()) as T;
    }
    throw lastErr ?? new CanvaError('Canva: exhausted retries');
  }

  const enc = encodeURIComponent;

  return {
    async getBrandTemplateDataset(brandTemplateId) {
      const r = await request<{ dataset?: BrandTemplateDataset }>(
        `/v1/brand-templates/${enc(brandTemplateId)}/dataset`,
        {},
      );
      return r.dataset ?? {};
    },
    async startAssetUpload(name, bytes) {
      const r = await request<{ job: AssetUploadJob }>('/v1/asset-uploads', {
        method: 'POST',
        raw: {
          body: bytes,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Asset-Upload-Metadata': assetUploadMetadata(name),
          },
        },
      });
      return r.job;
    },
    async getAssetUpload(jobId) {
      const r = await request<{ job: AssetUploadJob }>(`/v1/asset-uploads/${enc(jobId)}`, {});
      return r.job;
    },
    async startAutofill({ brandTemplateId, title, data }) {
      const r = await request<{ job: AutofillJob }>('/v1/autofills', {
        method: 'POST',
        json: { brand_template_id: brandTemplateId, title, data },
      });
      return r.job;
    },
    async getAutofill(jobId) {
      const r = await request<{ job: AutofillJob }>(`/v1/autofills/${enc(jobId)}`, {});
      return r.job;
    },
    async startPdfExport(designId) {
      // No `size`: Canva only honours it for Docs. The page size is the design's
      // own, which is why the exported file is measured afterwards (service.ts).
      const r = await request<{ job: ExportJob }>('/v1/exports', {
        method: 'POST',
        json: { design_id: designId, format: { type: 'pdf', export_quality: 'regular' } },
      });
      return r.job;
    },
    async getExport(jobId) {
      const r = await request<{ job: ExportJob }>(`/v1/exports/${enc(jobId)}`, {});
      return r.job;
    },
    async download(url) {
      if (!/^https:\/\//i.test(url)) throw new CanvaError('Canva returned a non-HTTPS export URL.');
      const res = await fetchImpl(url);
      if (!res.ok)
        throw new CanvaError(`Downloading the Canva export failed (HTTP ${res.status}).`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
