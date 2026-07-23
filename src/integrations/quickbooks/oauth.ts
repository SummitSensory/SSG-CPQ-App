import { env, qboEnvironment } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { encryptToken, decryptToken } from './crypto.js';

/**
 * QuickBooks Online OAuth 2.0. Authorization-code grant + refresh-token
 * rotation. Client id/secret come from env only; tokens are stored encrypted in
 * QboConnection. No credential ever appears in source or logs.
 */
const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

/** Build the consent URL the user is redirected to. `state` is a CSRF nonce. */
export function authorizeUrl(state: string): string {
  if (!env.QBO_CLIENT_ID || !env.QBO_REDIRECT_URI) throw new Error('QuickBooks OAuth not configured');
  const p = new URLSearchParams({
    client_id: env.QBO_CLIENT_ID,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: env.QBO_REDIRECT_URI,
    state,
  });
  return `${AUTH_BASE}?${p.toString()}`;
}

function basicAuth(): string {
  return Buffer.from(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`).toString('base64');
}

async function tokenRequest(body: URLSearchParams, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`QuickBooks token endpoint HTTP ${res.status}`);
  return (await res.json()) as TokenResponse;
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

/** Exchange an authorization code for tokens and store the connection. */
export async function exchangeCode(
  code: string,
  realmId: string,
  connectedById: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const t = await tokenRequest(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: env.QBO_REDIRECT_URI! }),
    fetchImpl,
  );
  await persist(realmId, connectedById, t);
  logger.info({ realmId, environment: qboEnvironment() }, 'QuickBooks connected');
}

/**
 * Return a valid access token for the realm, refreshing (and rotating the
 * refresh token) if it is expired or within 60s of expiring.
 */
export async function getAccessToken(realmId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const environment = qboEnvironment();
  const conn = await prisma.qboConnection.findUnique({ where: { realmId_environment: { realmId, environment } } });
  if (!conn || !conn.isActive) throw new Error(`No active QuickBooks connection for realm ${realmId}`);

  if (conn.accessTokenExpiresAt.getTime() - Date.now() > 60_000) {
    return decryptToken(conn.accessTokenEnc);
  }
  const t = await tokenRequest(
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decryptToken(conn.refreshTokenEnc) }),
    fetchImpl,
  );
  await persist(realmId, conn.connectedById, t);
  return t.access_token;
}

/** Disconnect: revoke the refresh token at Intuit and deactivate the connection. */
export async function disconnect(realmId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const environment = qboEnvironment();
  const conn = await prisma.qboConnection.findUnique({ where: { realmId_environment: { realmId, environment } } });
  if (!conn) return;
  try {
    await fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: decryptToken(conn.refreshTokenEnc) }),
    });
  } catch (err) {
    logger.warn({ err }, 'QuickBooks token revoke failed (deactivating anyway)');
  }
  await prisma.qboConnection.update({ where: { id: conn.id }, data: { isActive: false } });
}
