import { env, qboEnvironment } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { getAccessToken } from './oauth.js';
import { QboApiError, backoff, intuitTid, sleep } from './http.js';

/**
 * QuickBooks Online REST v3 client. Handles token injection, sandbox vs
 * production base URLs, rate-limit backoff, and — critically — native
 * idempotency via the `requestid` query param on create calls, so a retried
 * create never produces a duplicate document in QuickBooks.
 *
 * Every response's `intuit_tid` is captured. On failure it travels on the
 * thrown QboApiError and therefore into the sync log; on success it is logged
 * at debug level, which is enough to answer "what happened to this call" after
 * the fact.
 */
const MINOR_VERSION = '73';
const MAX_ATTEMPTS = 5;

export function apiBaseUrl(): string {
  return qboEnvironment() === 'PRODUCTION'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

/**
 * One attempt loop shared by every call shape. `accept` and `raw` exist because
 * two endpoints do not return JSON: the PDF download returns a binary body, and
 * the send-document call returns the object but is a POST with no body.
 */
async function request<T>(
  realmId: string,
  method: 'GET' | 'POST',
  path: string,
  opts: {
    body?: unknown;
    requestId?: string;
    query?: Record<string, string>;
    accept?: string;
    raw?: boolean;
  } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  if (!env.QBO_CLIENT_ID) throw new Error('QuickBooks not configured');
  const url = new URL(`${apiBaseUrl()}/v3/company/${realmId}/${path}`);
  url.searchParams.set('minorversion', MINOR_VERSION);
  // requestid is QuickBooks' server-side idempotency key: repeated creates with
  // the same value return the original object rather than creating a new one.
  if (opts.requestId) url.searchParams.set('requestid', opts.requestId);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const token = await getAccessToken(realmId, fetchImpl);
    const res = await fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: opts.accept ?? 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    const tid = intuitTid(res);

    if (res.status === 429 || res.status >= 500) {
      const wait = backoff(attempt, Number(res.headers.get('retry-after') ?? '') || undefined);
      logger.warn(
        { attempt, status: res.status, wait, intuitTid: tid, path },
        'QuickBooks throttled/5xx; backing off',
      );
      await sleep(wait);
      lastErr = new QboApiError(res.status, tid, '');
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 4xx is a rejected request, not a flaky one: a validation or syntax error
      // returns identically however many times it is sent. Fail immediately and
      // keep the fault detail, which names the offending field.
      const err = new QboApiError(res.status, tid, text);
      logger.error(
        { status: res.status, intuitTid: tid, faultCode: err.faultCode, detail: err.detail, path },
        'QuickBooks request rejected',
      );
      throw err;
    }
    logger.debug({ intuitTid: tid, path, method }, 'QuickBooks ok');
    if (opts.raw) return (await res.arrayBuffer()) as unknown as T;
    return (await res.json()) as T;
  }
  throw lastErr ?? new Error('QuickBooks: exhausted retries');
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
 * documents so a retry cannot double-create.
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
 * Read one object by its QuickBooks id. Returns the wrapper QuickBooks sends —
 * `{ Invoice: {...} }` or `{ Estimate: {...} }` — because the caller knows which
 * key it asked for and unwrapping here would lose the distinction.
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
 * Ask QuickBooks to email the document. QuickBooks composes and sends it, so
 * the message comes from the company's own QuickBooks account rather than from
 * us — which is what a customer expects to receive an invoice from.
 */
export async function sendDocument<T>(
  realmId: string,
  resource: string,
  id: string,
  /**
   * Override recipient. Null or omitted sends to the billing email QuickBooks
   * already holds for the customer, which is the normal case — the caller only
   * passes an address when someone typed a different one into the send dialog.
   */
  toEmail?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const to = String(toEmail ?? '').trim();
  return request<T>(
    realmId,
    'POST',
    `${resource}/${encodeURIComponent(id)}/send`,
    to ? { query: { sendTo: to } } : {},
    fetchImpl,
  );
}

/**
 * Download the QuickBooks-rendered PDF of a document. Binary, so it bypasses the
 * JSON parse.
 *
 * Returned as a Buffer rather than the raw ArrayBuffer the transport produces:
 * both callers need Buffer semantics — the reminder base64-encodes it to attach,
 * the route streams it to the reply — and an ArrayBuffer has neither.
 */
export async function fetchPdf(
  realmId: string,
  resource: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const bytes = await request<ArrayBuffer>(
    realmId,
    'GET',
    `${resource}/${encodeURIComponent(id)}/pdf`,
    { accept: 'application/pdf', raw: true },
    fetchImpl,
  );
  return Buffer.from(bytes);
}

export { backoff };
