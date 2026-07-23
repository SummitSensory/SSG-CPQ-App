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

async function request<T>(
  realmId: string,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; requestId?: string; query?: Record<string, string> } = {},
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
        Accept: 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
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
    return (await res.json()) as T;
  }
  throw lastErr ?? new Error('QuickBooks: exhausted retries');
}

/** Read-only query (find-or-create lookups). Uses the SQL-like QBO query API. */
export async function query<T>(realmId: string, sql: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const data = await request<{ QueryResponse: T }>(realmId, 'GET', 'query', { query: { query: sql } }, fetchImpl);
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

export { backoff };
