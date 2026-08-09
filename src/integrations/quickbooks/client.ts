import { createHash } from 'node:crypto';
import { env, qboEnvironment } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { getAccessToken } from './oauth.js';

/**
 * QuickBooks Online REST v3 client. Handles token injection, sandbox vs
 * production base URLs, rate-limit backoff, and — critically — native
 * idempotency via the `requestid` query param on create calls, so a retried
 * create never produces a duplicate document in QuickBooks.
 */
const MINOR_VERSION = '73';
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/**
 * Intuit rejects a `requestid` longer than 50 characters (validation error
 * 6000). Our internal idempotency keys are readable and longer than that
 * (`qbo:SANDBOX:ESTIMATE:<cuid>:1` is 56), so the wire value is a stable
 * 32-char hash of the key: same key in, same requestid out, forever. That is
 * what preserves QuickBooks' server-side duplicate protection across retries.
 * Hex only, so nothing is altered by URL encoding either.
 */
const REQUEST_ID_MAX = 50;

export function toRequestId(idempotencyKey: string): string {
  if (idempotencyKey.length <= REQUEST_ID_MAX && /^[A-Za-z0-9._-]+$/.test(idempotencyKey)) {
    return idempotencyKey;
  }
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS) + Math.floor(Math.random() * 250);
}

export function apiBaseUrl(): string {
  return qboEnvironment() === 'PRODUCTION'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

interface RequestOptions {
  body?: unknown;
  requestId?: string;
  query?: Record<string, string>;
  /**
   * Response media type. Anything other than JSON (only `application/pdf`
   * today) comes back as a Buffer from `rawRequest` instead.
   */
  accept?: string;
  /**
   * Sent as the request Content-Type. QuickBooks' /send endpoints take no body
   * and require `application/octet-stream`; without it Intuit answers 400.
   */
  contentType?: string;
}

/**
 * One attempt loop shared by every call shape. Returns the raw Response so
 * binary endpoints (invoice PDF) can read bytes while JSON callers parse.
 * Retries 429 and 5xx with backoff; anything else surfaces immediately with
 * Intuit's own message, which is far more useful than a generic failure.
 */
async function rawRequest(
  realmId: string,
  method: 'GET' | 'POST',
  path: string,
  opts: RequestOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!env.QBO_CLIENT_ID) throw new Error('QuickBooks not configured');
  const url = new URL(`${apiBaseUrl()}/v3/company/${realmId}/${path}`);
  url.searchParams.set('minorversion', MINOR_VERSION);
  // requestid is QuickBooks' server-side idempotency key: repeated creates with
  // the same value return the original object rather than creating a new one.
  if (opts.requestId) url.searchParams.set('requestid', toRequestId(opts.requestId));
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const token = await getAccessToken(realmId, fetchImpl);
    const res = await fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: opts.accept ?? 'application/json',
        ...(opts.contentType
          ? { 'Content-Type': opts.contentType }
          : opts.body
            ? { 'Content-Type': 'application/json' }
            : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    if (res.status === 429 || res.status >= 500) {
      const wait = backoff(attempt, Number(res.headers.get('retry-after') ?? '') || undefined);
      logger.warn({ attempt, status: res.status, wait }, 'QuickBooks throttled/5xx; backing off');
      await sleep(wait);
      lastErr = new Error(`QuickBooks HTTP ${res.status}`);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`QuickBooks HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return res;
  }
  throw lastErr ?? new Error('QuickBooks: exhausted retries');
}

async function request<T>(
  realmId: string,
  method: 'GET' | 'POST',
  path: string,
  opts: RequestOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await rawRequest(realmId, method, path, opts, fetchImpl);
  return (await res.json()) as T;
}

/** Read-only query (find-or-create lookups). Uses the SQL-like QBO query API. */
export async function query<T>(
  realmId: string,
  sql: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const data = await request<{ QueryResponse: T }>(
    realmId,
    'GET',
    'query',
    { query: { query: sql } },
    fetchImpl,
  );
  return data.QueryResponse;
}

/**
 * Create an object. `requestId` MUST be a stable idempotency key for financial
 * documents so a retry cannot double-create. It is hashed to a wire-safe
 * 32-char value by toRequestId() — deterministically, so retries still match.
 */
export async function create<T>(
  realmId: string,
  resource: string,
  body: unknown,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  return request<T>(realmId, 'POST', resource, { body, requestId }, fetchImpl);
}

/**
 * Read one object by its QuickBooks id — the live copy, including the fields
 * QuickBooks owns and we never write: Balance, EmailStatus, DeliveryInfo,
 * LinkedTxn. This is the read half of the source-of-truth contract.
 */
export async function readById<T>(
  realmId: string,
  resource: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  return request<T>(realmId, 'GET', `${resource}/${encodeURIComponent(id)}`, {}, fetchImpl);
}

/**
 * Email a document to the customer through QuickBooks — the same send the
 * QuickBooks UI performs, so the invoice's EmailStatus and DeliveryInfo are
 * updated by Intuit and the delivery is recorded on their side, not just ours.
 *
 * Sending from QuickBooks rather than from our own mailer is deliberate: the
 * customer gets the QuickBooks invoice with its pay-online link and it appears
 * in the QuickBooks sent history, which is what the bookkeeper reconciles
 * against. A copy sent from our domain would satisfy neither.
 *
 * `sendTo` overrides the document's BillEmail for this one send; omit it to use
 * the address already on the document. QuickBooks requires the empty body to
 * carry an octet-stream content type.
 */
export async function sendDocument<T>(
  realmId: string,
  resource: string,
  id: string,
  sendTo: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  return request<T>(
    realmId,
    'POST',
    `${resource}/${encodeURIComponent(id)}/send`,
    {
      contentType: 'application/octet-stream',
      ...(sendTo ? { query: { sendTo } } : {}),
    },
    fetchImpl,
  );
}

/**
 * The document exactly as the customer received it, as PDF bytes. Fetched live
 * rather than cached: an invoice edited in QuickBooks after it was sent should
 * show its current state, and a stale copy stored here would quietly disagree
 * with the customer's.
 */
export async function fetchPdf(
  realmId: string,
  resource: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const res = await rawRequest(
    realmId,
    'GET',
    `${resource}/${encodeURIComponent(id)}/pdf`,
    { accept: 'application/pdf' },
    fetchImpl,
  );
  return Buffer.from(await res.arrayBuffer());
}

export { backoff };
