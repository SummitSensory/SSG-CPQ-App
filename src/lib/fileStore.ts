import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Where uploaded documents are kept.
 *
 * Vercel Blob over its REST API, the same choice and the same reasoning as
 * integrations/docuseal/storage.ts: this deployment is already on Vercel, a
 * serverless function has no writable disk, and two fetch calls do not justify a
 * dependency. That file is deliberately PDF-only and named for signing
 * documents; this one takes any content type, because a customer's purchase order
 * arrives as whatever their procurement system produced — a PDF, a scan, a
 * screenshot pasted into an image.
 *
 * Unconfigured is NOT a supported state here, unlike the signing store. A signed
 * contract we failed to copy still exists in DocuSeal; a purchase order we failed
 * to store exists nowhere else, and an upload that silently went nowhere would
 * look identical on screen to one that worked. `putFile` throws instead.
 */

const BLOB_API = 'https://blob.vercel-storage.com';
const API_VERSION = '7';

/** Per-file cap. Graph refuses a single attachment much above this. */
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

/** What a browser is allowed to hand us for a purchase order. */
export const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/tiff': 'tif',
  'image/heic': 'heic',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

export function isFileStoreConfigured(): boolean {
  return Boolean(env.BLOB_READ_WRITE_TOKEN);
}

export interface StoredUpload {
  url: string;
  pathname: string;
  bytes: number;
}

/**
 * Turn a path fragment into something safe to put in a URL and readable in a
 * bucket listing. Unicode, spaces and punctuation all collapse to hyphens; the
 * extension is preserved because the download reply uses it.
 */
export function safeSegment(input: string, fallback = 'file'): string {
  const s = String(input ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return s || fallback;
}

/** `purchase-orders/<order number>/<id>-<filename>`. */
export function purchaseOrderPath(input: {
  orderNumber: string;
  fileId: string;
  filename: string;
}): string {
  return `purchase-orders/${safeSegment(input.orderNumber, 'order')}/${input.fileId}-${safeSegment(
    input.filename,
  )}`;
}

/**
 * PDF-only cap for the reference-document library (a W9, a certificate of insurance).
 *
 * Larger than the purchase-order cap: those come in over email and get forwarded
 * through Outlook, which is the 3 MB ceiling in that file's own comment. These are
 * uploaded once by staff and merged as extra PDF pages (see src/lib/pdfMerge.ts), with
 * no email-attachment size to respect — a multi-page scanned certificate can run
 * larger than a one-page W9.
 */
export const MAX_REFERENCE_DOC_BYTES = 5 * 1024 * 1024;

/**
 * PDF only. A reference document is merged into a customer-facing PDF as real pages
 * (see src/lib/pdfMerge.ts) — an image or a Word document is not the same operation,
 * and converting one to match would be lossy for exactly the kind of form (an IRS W9)
 * this exists to carry unmodified.
 */
export const REFERENCE_DOC_CONTENT_TYPE = 'application/pdf';

/** `reference-documents/<id>-<filename>`. */
export function referenceDocumentPath(input: { fileId: string; filename: string }): string {
  return `reference-documents/${input.fileId}-${safeSegment(input.filename)}`;
}

/**
 * Store bytes and return where they went.
 *
 * `x-add-random-suffix: 0` because the pathname already carries a cuid, so the
 * same path is the same document and a random suffix would leave orphans nothing
 * points at.
 */
export async function putFile(
  pathname: string,
  bytes: Buffer,
  contentType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredUpload> {
  if (!isFileStoreConfigured()) {
    throw new Error(
      'File storage is not configured on this deployment (BLOB_READ_WRITE_TOKEN is not set), so the upload was not kept.',
    );
  }
  const clean = pathname.replace(/^\/+/, '');
  const res = await fetchImpl(`${BLOB_API}/${encodeURI(clean)}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.BLOB_READ_WRITE_TOKEN!}`,
      'x-api-version': API_VERSION,
      'x-content-type': contentType,
      'x-add-random-suffix': '0',
      'x-cache-control-max-age': '31536000',
      // The store is configured for private access (not world-readable by URL —
      // right for a customer's purchase order or W9). Omitting this defaults to
      // public and the API refuses the mismatch: "Cannot use public access on a
      // private store." The header name is `x-vercel-blob-access`, not the more
      // guessable `x-access` — confirmed against @vercel/blob's own source
      // (packages/blob/src/put-helpers.ts), since this raw-fetch call bypasses
      // the SDK and its public `access: 'private'` option entirely.
      'x-vercel-blob-access': 'private',
    },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.error(
      { status: res.status, pathname: clean, detail: detail.slice(0, 300) },
      'blob: upload failed',
    );
    throw new Error(`The file store refused the upload (HTTP ${res.status}).`);
  }
  const body = (await res.json()) as { url?: string; pathname?: string };
  if (!body.url) throw new Error('The file store accepted the upload but did not say where it is.');
  return { url: body.url, pathname: body.pathname ?? clean, bytes: bytes.length };
}

/** Read a stored file back, for a download proxy or an email attachment. */
export async function getFile(url: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const res = await fetchImpl(url, {
    headers: env.BLOB_READ_WRITE_TOKEN
      ? { Authorization: `Bearer ${env.BLOB_READ_WRITE_TOKEN}` }
      : {},
  });
  if (!res.ok) throw new Error(`The stored file could not be read back (HTTP ${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Delete a stored file. Never throws: the database row is already gone by the
 * time this is called, and a blob that outlives its row is a housekeeping matter,
 * not a reason to fail the request that removed it.
 */
export async function deleteFile(url: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!isFileStoreConfigured()) return;
  try {
    const res = await fetchImpl(`${BLOB_API}/delete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.BLOB_READ_WRITE_TOKEN!}`,
        'x-api-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ urls: [url] }),
    });
    if (!res.ok) logger.warn({ status: res.status }, 'blob: delete failed');
  } catch (err) {
    logger.warn({ err }, 'blob: delete threw');
  }
}
