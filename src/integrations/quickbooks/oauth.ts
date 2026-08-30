import { env, qboEnvironment } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { encryptToken, decryptToken } from './crypto.js';
import { QboAuthError, backoff, intuitTid, isDeadGrant, sleep } from './http.js';

/**
 * QuickBooks Online OAuth 2.0. Authorization-code grant + refresh-token
 * rotation. Client id/secret come from env only; tokens are stored encrypted in
 * QboConnection. No credential ever appears in source or logs.
 *
 * Endpoints come from Intuit's discovery document rather than being pinned in
 * source, so a change on their side does not require a deploy here. The
 * constants below are the fallback for a cold start that cannot reach it.
 */
const FALLBACK_AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const FALLBACK_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const FALLBACK_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';

const DISCOVERY_URL = {
  PRODUCTION: 'https://developer.api.intuit.com/.well-known/openid_configuration',
  SANDBOX: 'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration',
} as const;

/** Token requests are retried; a rejected grant is not. */
const MAX_TOKEN_ATTEMPTS = 3;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

interface Endpoints {
  authorize: string;
  token: string;
  revoke: string;
}

/** Cached per environment for the life of the process. */
const endpointCache = new Map<string, Endpoints>();

/**
 * Intuit's published endpoints, falling back to the known-good constants.
 *
 * A discovery fetch that fails must never take the integration down with it —
 * the fallback values are the ones Intuit has published for years, so a failed
 * lookup is a missed update, not an outage.
 */
export async function endpoints(fetchImpl: typeof fetch = fetch): Promise<Endpoints> {
  const environment = qboEnvironment();
  const cached = endpointCache.get(environment);
  if (cached) return cached;

  const fallback: Endpoints = {
    authorize: FALLBACK_AUTH_BASE,
    token: FALLBACK_TOKEN_URL,
    revoke: FALLBACK_REVOKE_URL,
  };

  try {
    const res = await fetchImpl(DISCOVERY_URL[environment], {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = (await res.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
      revocation_endpoint?: string;
    };
    const resolved: Endpoints = {
      authorize: doc.authorization_endpoint || fallback.authorize,
      token: doc.token_endpoint || fallback.token,
      revoke: doc.revocation_endpoint || fallback.revoke,
    };
    endpointCache.set(environment, resolved);
    logger.info({ environment }, 'QuickBooks endpoints loaded from discovery document');
    return resolved;
  } catch (err) {
    logger.warn(
      { err, environment },
      'QuickBooks discovery document unavailable; using pinned endpoints',
    );
    endpointCache.set(environment, fallback);
    return fallback;
  }
}

/** Build the consent URL the user is redirected to. `state` is a CSRF nonce. */
export async function authorizeUrl(
  state: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!env.QBO_CLIENT_ID || !env.QBO_REDIRECT_URI)
    throw new Error('QuickBooks OAuth not configured');
  const { authorize } = await endpoints(fetchImpl);
  const p = new URLSearchParams({
    client_id: env.QBO_CLIENT_ID,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: env.QBO_REDIRECT_URI,
    state,
  });
  return `${authorize}?${p.toString()}`;
}

function basicAuth(): string {
  return Buffer.from(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`).toString('base64');
}

/**
 * POST to the token endpoint, retrying transient failures.
 *
 * Retries cover 429, 5xx and network errors — the cases where the same request
 * may well succeed a second later. A 4xx is a decision, not a hiccup: retrying
 * an `invalid_grant` just burns time and can trip Intuit's abuse limits, so it
 * throws on the first attempt.
 */
async function tokenRequest(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const { token: tokenUrl } = await endpoints(fetchImpl);
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth()}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });
    } catch (err) {
      // DNS failure, socket reset, timeout — worth another go.
      lastErr = err instanceof Error ? err : new Error(String(err));
      const wait = backoff(attempt);
      logger.warn({ attempt, wait, err }, 'QuickBooks token endpoint unreachable; retrying');
      await sleep(wait);
      continue;
    }

    const tid = intuitTid(res);

    if (res.status === 429 || res.status >= 500) {
      const wait = backoff(attempt, Number(res.headers.get('retry-after') ?? '') || undefined);
      logger.warn(
        { attempt, status: res.status, wait, intuitTid: tid },
        'QuickBooks token endpoint throttled/5xx; retrying',
      );
      lastErr = new Error(`QuickBooks token endpoint HTTP ${res.status}`);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (isDeadGrant(text)) {
        throw new QboAuthError(
          'QuickBooks rejected the stored authorization (invalid_grant). The connection must be re-authorized from Administration → Integrations.',
          tid,
        );
      }
      throw new QboAuthError(
        `QuickBooks token endpoint HTTP ${res.status}: ${text.slice(0, 300)}`,
        tid,
      );
    }

    return (await res.json()) as TokenResponse;
  }

  throw lastErr ?? new Error('QuickBooks token endpoint: exhausted retries');
}

function persist(realmId: string, connectedById: string, t: TokenResponse) {
  const now = Date.now();
  const environment = qboEnvironment();
  const data = {
    accessTokenEnc: encryptToken(t.access_token),
    refreshTokenEnc: encryptToken(t.refresh_token),
    accessTokenExpiresAt: new Date(now + t.expires_in * 1000),
    refreshTokenExpiresAt: new Date(now + t.x_refresh_token_expires_in * 1000),
    isActive: true,
  };
  return prisma.qboConnection.upsert({
    where: { realmId_environment: { realmId, environment } },
    update: data,
    create: { realmId, environment, connectedById, ...data },
  });
}

/**
 * Mark a connection dead so the UI stops offering actions that cannot work and
 * asks for a reconnect instead. Called whenever Intuit tells us the grant is
 * finished, or when the refresh token has simply aged out.
 */
async function deactivate(realmId: string, reason: string): Promise<void> {
  const environment = qboEnvironment();
  await prisma.qboConnection
    .update({ where: { realmId_environment: { realmId, environment } }, data: { isActive: false } })
    .catch(() => undefined);
  logger.warn(
    { realmId, environment, reason },
    'QuickBooks connection deactivated — reconnect required',
  );
}

/** Exchange an authorization code for tokens and store the connection. */
export async function exchangeCode(
  code: string,
  realmId: string,
  connectedById: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const t = await tokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.QBO_REDIRECT_URI!,
    }),
    fetchImpl,
  );
  await persist(realmId, connectedById, t);
  logger.info({ realmId, environment: qboEnvironment() }, 'QuickBooks connected');
}

/**
 * Return a valid access token for the realm, refreshing (and rotating the
 * refresh token) if it is expired or within 60s of expiring.
 *
 * Three failure modes are separated deliberately, because they need different
 * things from the operator: no connection, a refresh token that has expired
 * (Intuit's are good for 100 days and die of disuse), and a grant Intuit has
 * revoked. All three raise QboAuthError, which the UI reads as "reconnect".
 */
export async function getAccessToken(
  realmId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const environment = qboEnvironment();
  const conn = await prisma.qboConnection.findUnique({
    where: { realmId_environment: { realmId, environment } },
  });
  if (!conn || !conn.isActive) {
    throw new QboAuthError(
      `No active QuickBooks connection for realm ${realmId}. Connect from Administration → Integrations.`,
    );
  }

  if (conn.accessTokenExpiresAt.getTime() - Date.now() > 60_000) {
    return decryptToken(conn.accessTokenEnc);
  }

  // Checked before spending a request: an expired refresh token cannot be
  // refreshed, and asking anyway returns invalid_grant a moment later.
  if (conn.refreshTokenExpiresAt.getTime() <= Date.now()) {
    await deactivate(realmId, 'refresh token expired');
    throw new QboAuthError(
      'The QuickBooks authorization has expired through disuse. Reconnect from Administration → Integrations.',
    );
  }

  try {
    const t = await tokenRequest(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: decryptToken(conn.refreshTokenEnc),
      }),
      fetchImpl,
    );
    await persist(realmId, conn.connectedById, t);
    return t.access_token;
  } catch (err) {
    if (err instanceof QboAuthError) await deactivate(realmId, err.message);
    throw err;
  }
}

/** Disconnect: revoke the refresh token at Intuit and deactivate the connection. */
export async function disconnect(realmId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const environment = qboEnvironment();
  const conn = await prisma.qboConnection.findUnique({
    where: { realmId_environment: { realmId, environment } },
  });
  if (!conn) return;
  try {
    const { revoke } = await endpoints(fetchImpl);
    await fetchImpl(revoke, {
      method: 'POST',
      headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: decryptToken(conn.refreshTokenEnc) }),
    });
  } catch (err) {
    logger.warn({ err }, 'QuickBooks token revoke failed (deactivating anyway)');
  }
  await prisma.qboConnection.update({ where: { id: conn.id }, data: { isActive: false } });
}
