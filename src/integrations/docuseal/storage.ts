import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Where signing documents are kept.
 *
 * Vercel Blob, for three reasons that decided it over S3: this deployment is
 * already on Vercel, so it is one token rather than an IAM role, a bucket policy
 * and a signing library; a serverless function has no writable disk, so "keep it
 * on the box" was never an option; and the executed contract must not live only
 * inside DocuSeal, where our retention depends on someone else's account staying
 * open and paid.
 *
 * Talked to over its REST API rather than through `@vercel/blob`, so nothing is
 * added to the dependency tree for two calls — the same reasoning that keeps the
 * monday file upload on plain `fetch`.
 *
 * Unconfigured is a supported state: `putPdf` returns null, the envelope keeps
 * DocuSeal's own document URL, and the send still works. Moving to S3 later means
 * replacing this file and nothing else.
 */

const BLOB_API = 'https://blob.vercel-storage.com';
const API_VERSION = '7';

export function isBlobConfigured(): boolean {
  return Boolean(env.BLOB_READ_WRITE_TOKEN);
}

export interface StoredFile {
  url: string;
  pathname: string;
  bytes: number;
}

/**
 * Store a PDF and return its URL, or null when no store is configured.
 *
 * Never throws for a storage failure. A signed contract that we failed to copy is
 * a reconciliation job, not a reason to fail the request that discovered it — the
 * document still exists in DocuSeal and the error is logged with the pathname
 * needed to retry.
 */
export async function putPdf(
  pathname: string,
  bytes: Buffer,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredFile | null> {
  if (!isBlobConfigured()) return null;
  const clean = pathname.replace(/^\/+/, '');
  try {
    const res = await fetchImpl(`${BLOB_API}/${encodeURI(clean)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.BLOB_READ_WRITE_TOKEN!}`,
        'x-api-version': API_VERSION,
        'x-content-type': 'application/pdf',
        // Overwriting is deliberate: the pathname carries the envelope id, so the
        // same path is the same document. A random suffix would leave orphans that
        // nothing points at.
        'x-add-random-suffix': '0',
        'x-cache-control-max-age': '31536000',
        // Same store as src/lib/fileStore.ts, configured for private access — see
        // the comment there, including why this is `x-vercel-blob-access` and not
        // the more guessable `x-access`. Without this an executed contract's copy
        // failed silently (putPdf swallows storage errors) and nobody would know
        // until this file's own doc comment's worry — DocuSeal being the only
        // copy — came true.
        'x-vercel-blob-access': 'private',
      },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      logger.error({ status: res.status, pathname: clean }, 'blob: upload failed');
      return null;
    }
    const body = (await res.json()) as { url?: string; pathname?: string };
    if (!body.url) {
      logger.error({ pathname: clean }, 'blob: upload returned no url');
      return null;
    }
    return { url: body.url, pathname: body.pathname ?? clean, bytes: bytes.length };
  } catch (err) {
    logger.error({ err, pathname: clean }, 'blob: upload threw');
    return null;
  }
}

/** `esign/<proposal number>/<envelope id>/<kind>.pdf`, safe for a URL path. */
export function envelopePath(input: {
  proposalNumber: string;
  envelopeId: string;
  kind: 'package' | 'signed';
}): string {
  const number = input.proposalNumber.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `esign/${number || 'proposal'}/${input.envelopeId}/${input.kind}.pdf`;
}
