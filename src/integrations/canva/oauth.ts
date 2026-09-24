/**
 * Canva Connect authorization — one org-wide connection.
 *
 * Canva Connect has no client-credentials grant: an API call acts as a Canva user,
 * so one person (whoever owns the Strategic Partnership brand template) connects the
 * CRM once from Administration, using OAuth 2.0 authorization code with PKCE. The
 * resulting tokens are stored encrypted on the single CanvaConnection row.
 *
 * Two Canva behaviours shape this file:
 *
 *  - PKCE's code_verifier must survive from the connect click to Canva's callback,
 *    which on a serverless host are two unrelated requests. It is kept (encrypted)
 *    on the connection row with the `state` it belongs to, never in the URL.
 *  - Canva ROTATES the refresh token on every refresh; the old one stops working.
 *    Two concurrent refreshes would leave one of them holding a dead token, so the
 *    new pair is written with a compare-and-swap on the refresh token that was used,
 *    and a request that loses the race re-reads the row and uses the winner's token.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env, isCanvaConfigured } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { CanvaError } from './client.js';

export const CANVA_AUTHORIZE_URL = 'https://www.canva.com/api/oauth/authorize';

/** What Autofill, asset upload and PDF export need. Nothing broader. */
export const CANVA_SCOPES = [
  'brandtemplate:meta:read',
  'brandtemplate:content:read',
  'design:meta:read',
  'design:content:read',
  'design:content:write',
  'asset:read',
  'asset:write',
].join(' ');

const PENDING_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before Canva's stated expiry, so a slow request is not caught out. */
const EXPIRY_SKEW_MS = 60 * 1000;
const CONNECTION_KEY = 'default';

/* ------------------------------------------------------------------ encryption */

function key(): Buffer {
  if (!env.CANVA_TOKEN_ENC_KEY) throw new CanvaError('CANVA_TOKEN_ENC_KEY is not configured.');
  return createHash('sha256').update(env.CANVA_TOKEN_ENC_KEY).digest();
}

/** AES-256-GCM, base64(iv[12] | ciphertext | tag[16]) — same shape as the QBO tokens. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString('base64');
}

export function decryptSecret(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([
    decipher.update(buf.subarray(12, buf.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

/* ------------------------------------------------------------------------ PKCE */

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

/* ------------------------------------------------------------------- connect */

function requireConfigured(): void {
  if (!isCanvaConfigured()) {
    throw new CanvaError(
      'Canva is not configured on this deployment (CANVA_CLIENT_ID, CANVA_CLIENT_SECRET, CANVA_REDIRECT_URI, CANVA_TOKEN_ENC_KEY).',
    );
  }
}

/** Start a connection: remember the verifier, return the Canva consent URL. */
export async function beginCanvaConnect(userId: string): Promise<string> {
  requireConfigured();
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(32));
  const pending = {
    pendingState: hashState(state),
    pendingVerifier: encryptSecret(verifier),
    pendingExpiresAt: new Date(Date.now() + PENDING_TTL_MS),
    connectedById: userId,
  };
  await prisma.canvaConnection.upsert({
    where: { key: CONNECTION_KEY },
    create: { key: CONNECTION_KEY, ...pending },
    update: pending,
  });
  const u = new URL(CANVA_AUTHORIZE_URL);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 's256');
  u.searchParams.set('scope', CANVA_SCOPES);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', env.CANVA_CLIENT_ID!);
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', env.CANVA_REDIRECT_URI!);
  return u.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

async function tokenRequest(
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const basic = Buffer.from(`${env.CANVA_CLIENT_ID}:${env.CANVA_CLIENT_SECRET}`).toString('base64');
  const res = await fetchImpl(`${env.CANVA_API_URL.replace(/\/+$/, '')}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new CanvaError(
      `Canva token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
      res.status,
    );
  }
  const body = (await res.json()) as Partial<TokenResponse>;
  if (!body.access_token || !body.refresh_token || !body.expires_in) {
    throw new CanvaError('Canva returned an incomplete token response.');
  }
  return body as TokenResponse;
}

/** Canva's callback: check the state, exchange the code, store the tokens. */
export async function completeCanvaConnect(
  code: string,
  state: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ connectedById: string | null }> {
  requireConfigured();
  const row = await prisma.canvaConnection.findUnique({ where: { key: CONNECTION_KEY } });
  if (
    !row?.pendingState ||
    !row.pendingVerifier ||
    row.pendingState !== hashState(state) ||
    !row.pendingExpiresAt ||
    row.pendingExpiresAt.getTime() < Date.now()
  ) {
    throw new CanvaError(
      'That Canva connect link expired or was already used. Start again from Administration.',
    );
  }
  const verifier = decryptSecret(row.pendingVerifier);
  const tokens = await tokenRequest(
    {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: env.CANVA_REDIRECT_URI!,
    },
    fetchImpl,
  );
  await prisma.canvaConnection.update({
    where: { key: CONNECTION_KEY },
    data: {
      accessToken: encryptSecret(tokens.access_token),
      refreshToken: encryptSecret(tokens.refresh_token),
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      scope: tokens.scope ?? CANVA_SCOPES,
      connectedAt: new Date(),
      pendingState: null,
      pendingVerifier: null,
      pendingExpiresAt: null,
      lastError: null,
    },
  });
  return { connectedById: row.connectedById };
}

/* ------------------------------------------------------------------ tokens */

export class CanvaNotConnectedError extends CanvaError {
  constructor() {
    super(
      'Canva is not connected. An administrator connects it from Administration → Integrations.',
    );
    this.name = 'CanvaNotConnectedError';
  }
}

/** A valid access token, refreshing (and rotating the refresh token) when needed. */
export async function canvaAccessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  requireConfigured();
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await prisma.canvaConnection.findUnique({ where: { key: CONNECTION_KEY } });
    if (!row?.accessToken || !row.refreshToken || !row.expiresAt)
      throw new CanvaNotConnectedError();
    if (row.expiresAt.getTime() - EXPIRY_SKEW_MS > Date.now())
      return decryptSecret(row.accessToken);

    let tokens: TokenResponse;
    try {
      tokens = await tokenRequest(
        { grant_type: 'refresh_token', refresh_token: decryptSecret(row.refreshToken) },
        fetchImpl,
      );
    } catch (err) {
      // Another request may have just rotated the token out from under us; re-read.
      const fresh = await prisma.canvaConnection.findUnique({ where: { key: CONNECTION_KEY } });
      if (fresh?.refreshToken && fresh.refreshToken !== row.refreshToken) continue;
      const message = err instanceof Error ? err.message : String(err);
      await prisma.canvaConnection.update({
        where: { key: CONNECTION_KEY },
        data: { lastError: message.slice(0, 500) },
      });
      logger.error({ err }, 'canva: token refresh failed');
      throw err;
    }
    const swapped = await prisma.canvaConnection.updateMany({
      where: { key: CONNECTION_KEY, refreshToken: row.refreshToken },
      data: {
        accessToken: encryptSecret(tokens.access_token),
        refreshToken: encryptSecret(tokens.refresh_token),
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        scope: tokens.scope ?? row.scope,
        lastError: null,
      },
    });
    if (swapped.count === 1) return tokens.access_token;
    // Lost the race: someone else stored a newer pair. Loop and read theirs.
  }
  throw new CanvaError('Canva token refresh kept colliding with another request. Try again.');
}

export interface CanvaStatus {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  scope: string | null;
  lastError: string | null;
}

export async function canvaStatus(): Promise<CanvaStatus> {
  const configured = isCanvaConfigured();
  const row = await prisma.canvaConnection.findUnique({ where: { key: CONNECTION_KEY } });
  return {
    configured,
    connected: Boolean(configured && row?.accessToken && row.refreshToken),
    connectedAt: row?.connectedAt ? row.connectedAt.toISOString() : null,
    scope: row?.scope ?? null,
    lastError: row?.lastError ?? null,
  };
}

export async function disconnectCanva(): Promise<void> {
  await prisma.canvaConnection.updateMany({
    where: { key: CONNECTION_KEY },
    data: {
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      scope: null,
      connectedAt: null,
      pendingState: null,
      pendingVerifier: null,
      pendingExpiresAt: null,
    },
  });
}
