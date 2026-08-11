/**
 * Shared HTTP plumbing for the QuickBooks integration: retry timing, the
 * `intuit_tid` correlation id, and typed errors.
 *
 * It lives in its own module because both the REST client and the OAuth flow
 * need it, and client.ts already imports oauth.ts — putting these in either one
 * would make the pair circular.
 *
 * `intuit_tid` is the id Intuit's support team asks for first when
 * troubleshooting. It comes back on every response, success or failure, and is
 * useless unless it was captured at the moment the call was made — so it is
 * pulled off every response and carried on the error itself, which puts it in
 * the log line, the IntegrationSyncLog row and the failed transaction record
 * without any of those needing to know it exists.
 */

export const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 500;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter; an explicit Retry-After always wins. */
export function backoff(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS) + Math.floor(Math.random() * 250);
}

/** The correlation id Intuit returns on every response. Null when absent. */
export function intuitTid(res: { headers: Headers }): string | null {
  return res.headers.get('intuit_tid') ?? res.headers.get('Intuit_Tid') ?? null;
}

/**
 * A QuickBooks API failure. The message carries the tid so that callers which
 * only persist `String(err)` — the sync log, the transaction error column —
 * record it without changing.
 */
export class QboApiError extends Error {
  readonly status: number;
  readonly intuitTid: string | null;
  /** Intuit's own fault code, when the body carried one. */
  readonly faultCode: string | null;
  readonly detail: string;

  constructor(status: number, tid: string | null, body: string) {
    const { code, detail } = parseFault(body);
    super(
      `QuickBooks HTTP ${status}` +
        (code ? ` (fault ${code})` : '') +
        `: ${detail || body.slice(0, 300) || 'no response body'}` +
        (tid ? ` [intuit_tid=${tid}]` : ''),
    );
    this.name = 'QboApiError';
    this.status = status;
    this.intuitTid = tid;
    this.faultCode = code;
    this.detail = detail;
  }
}

/**
 * An authorization failure that the user has to resolve by reconnecting. Raised
 * for `invalid_grant` and for a refresh token that has passed its expiry — both
 * mean the stored authorization is dead and no amount of retrying will revive
 * it.
 */
export class QboAuthError extends Error {
  readonly requiresReconnect = true;
  readonly intuitTid: string | null;

  constructor(message: string, tid: string | null = null) {
    super(message + (tid ? ` [intuit_tid=${tid}]` : ''));
    this.name = 'QboAuthError';
    this.intuitTid = tid;
  }
}

/**
 * Pull the useful part out of a QuickBooks fault body. The v3 API returns
 * `{ Fault: { Error: [{ code, Message, Detail }] } }`; the OAuth endpoints
 * return `{ error, error_description }`. Anything else falls through to the raw
 * text, which is better than swallowing it.
 */
function parseFault(body: string): { code: string | null; detail: string } {
  if (!body) return { code: null, detail: '' };
  try {
    const parsed = JSON.parse(body) as {
      Fault?: { Error?: Array<{ code?: string; Message?: string; Detail?: string }> };
      error?: string;
      error_description?: string;
    };
    const first = parsed.Fault?.Error?.[0];
    if (first) {
      return {
        code: first.code ?? null,
        detail: [first.Message, first.Detail].filter(Boolean).join(' — ').slice(0, 400),
      };
    }
    if (parsed.error) {
      return { code: parsed.error, detail: (parsed.error_description ?? '').slice(0, 400) };
    }
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return { code: null, detail: '' };
}

/** True for the OAuth error codes that mean "this authorization is finished". */
export function isDeadGrant(body: string): boolean {
  const { code } = parseFault(body);
  return code === 'invalid_grant' || code === 'unauthorized_client';
}
