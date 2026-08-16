import { env, isDocusealConfigured } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * DocuSeal REST client.
 *
 * Plain HTTPS with an `X-Auth-Token` header — deliberately not the DocuSeal MCP
 * server. MCP is an agent convenience for a developer's editor; a production send
 * must not depend on an agent transport, an interactive auth prompt, or a service
 * that can change its tool surface between deploys.
 *
 * Retries on 429 and on 5xx with capped exponential backoff, the same shape as the
 * monday client, so a rate limit is a pause rather than a failed send.
 */

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS) + Math.floor(Math.random() * 250);
}

function baseUrl(): string {
  return (env.DOCUSEAL_API_URL ?? 'https://api.docuseal.com').replace(/\/+$/, '');
}

export class DocusealError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DocusealError';
  }
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  if (!isDocusealConfigured()) throw new DocusealError('DOCUSEAL_API_TOKEN is not configured');
  const url = `${baseUrl()}${path}`;
  const method = init.method ?? 'GET';

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetchImpl(url, {
      method,
      headers: {
        'X-Auth-Token': env.DOCUSEAL_API_TOKEN!,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

    if (res.status === 429 || res.status >= 500) {
      const wait = backoff(attempt, Number(res.headers.get('retry-after') ?? '') || undefined);
      logger.warn({ attempt, status: res.status, path, wait }, 'docuseal: retrying');
      lastErr = new DocusealError(`DocuSeal HTTP ${res.status}`, res.status);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      // DocuSeal reports validation problems as JSON; keep the message, it is
      // usually specific enough to act on (a bad email, an unknown role).
      const text = await res.text().catch(() => '');
      throw new DocusealError(`DocuSeal HTTP ${res.status}: ${text.slice(0, 500)}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  throw lastErr ?? new DocusealError('DocuSeal: exhausted retries');
}

export interface DocusealTemplate {
  id: number;
  name: string;
  slug?: string;
  fields?: Array<{ uuid: string; name: string; type: string; submitter_uuid?: string }>;
  submitters?: Array<{ uuid: string; name: string }>;
}

export interface DocusealSubmitter {
  id: number;
  submission_id?: number;
  uuid?: string;
  email: string;
  name?: string | null;
  role?: string | null;
  slug?: string;
  status?: string;
  sent_at?: string | null;
  opened_at?: string | null;
  completed_at?: string | null;
  declined_at?: string | null;
  embed_src?: string;
}

export interface DocusealSubmission {
  id: number;
  status?: string;
  submitters?: DocusealSubmitter[];
  completed_at?: string | null;
  documents?: Array<{ name: string; url: string }>;
  audit_log_url?: string | null;
}

/**
 * Create a template from a finished PDF.
 *
 * The package we upload already carries DocuSeal text tags — `{{Signature;
 * role=Customer;type=signature}}` and friends, rendered in the signature block —
 * so DocuSeal derives the fields and their positions from the document. That keeps
 * field placement in the same file as the layout: change the signature block and
 * the fields move with it, with no coordinates to maintain here.
 */
export async function createTemplateFromPdf(input: {
  name: string;
  filename: string;
  pdf: Buffer;
  folderName?: string;
}): Promise<DocusealTemplate> {
  return request<DocusealTemplate>('/templates/pdf', {
    method: 'POST',
    body: {
      name: input.name,
      ...(input.folderName ? { folder_name: input.folderName } : {}),
      documents: [
        {
          name: input.filename.replace(/\.pdf$/i, ''),
          file: input.pdf.toString('base64'),
        },
      ],
    },
  });
}

export async function createSubmission(input: {
  templateId: number;
  sendEmail: boolean;
  message?: { subject?: string; body?: string };
  submitters: Array<{
    role: string;
    email: string;
    name?: string;
    order?: number;
    /// Pre-filled, read-only values keyed by field name.
    values?: Record<string, unknown>;
  }>;
}): Promise<DocusealSubmitter[]> {
  const body: Record<string, unknown> = {
    template_id: input.templateId,
    send_email: input.sendEmail,
    // Sequential when the caller gave distinct orders, otherwise everyone at once.
    order: input.submitters.some((s) => (s.order ?? 1) > 1) ? 'preserved' : 'random',
    submitters: input.submitters.map((s) => ({
      role: s.role,
      email: s.email,
      ...(s.name ? { name: s.name } : {}),
      ...(s.values ? { values: s.values } : {}),
    })),
  };
  if (input.message?.subject || input.message?.body) {
    body.message = {
      ...(input.message.subject ? { subject: input.message.subject } : {}),
      ...(input.message.body ? { body: input.message.body } : {}),
    };
  }
  const created = await request<DocusealSubmitter[] | { submitters?: DocusealSubmitter[] }>(
    '/submissions',
    { method: 'POST', body },
  );
  // The API returns a bare array of submitters; tolerate the wrapped shape too.
  return Array.isArray(created) ? created : (created.submitters ?? []);
}

export async function getSubmission(submissionId: number | string): Promise<DocusealSubmission> {
  return request<DocusealSubmission>(`/submissions/${submissionId}`);
}

/** Archive a submission — DocuSeal's equivalent of voiding. */
export async function archiveSubmission(submissionId: number | string): Promise<void> {
  await request<void>(`/submissions/${submissionId}`, { method: 'DELETE' });
}

export async function archiveTemplate(templateId: number | string): Promise<void> {
  await request<void>(`/templates/${templateId}`, { method: 'DELETE' });
}

/**
 * The executed document(s) for a completed submission. DocuSeal returns signed
 * URLs; the bytes are fetched here so the caller can put a copy in our own storage.
 */
export async function fetchCompletedPdf(
  submissionId: number | string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ filename: string; bytes: Buffer } | null> {
  const submission = await getSubmission(submissionId);
  const doc = submission.documents?.[0];
  if (!doc?.url) return null;
  const res = await fetchImpl(doc.url);
  if (!res.ok) throw new DocusealError(`DocuSeal document download HTTP ${res.status}`, res.status);
  const bytes = Buffer.from(await res.arrayBuffer());
  const filename = /\.pdf$/i.test(doc.name) ? doc.name : `${doc.name}.pdf`;
  return { filename, bytes };
}

export { request as docusealRequest };
