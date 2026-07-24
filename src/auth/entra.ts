import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { env, entraAllowedDomains } from '../config/env.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';

/**
 * Microsoft Entra ID (Azure AD) OpenID Connect, authorization-code flow for a
 * confidential client.
 *
 * The `state` parameter is a short-lived signed JWT carrying the nonce and the
 * post-login redirect, so the flow stays stateless across serverless
 * invocations — there is no server memory to hold a pending login in.
 */

const stateKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const STATE_TTL = 600; // 10 minutes to finish signing in

function tenant(): string {
  return env.ENTRA_TENANT_ID!;
}
export function authority(): string {
  return `https://login.microsoftonline.com/${tenant()}/v2.0`;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function keys(): ReturnType<typeof createRemoteJWKSet> {
  jwks ??= createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenant()}/discovery/v2.0/keys`),
  );
  return jwks;
}

export interface PendingLogin {
  nonce: string;
  returnTo: string;
}

export async function createState(returnTo = '/'): Promise<{ state: string; nonce: string }> {
  const nonce = randomBytes(16).toString('base64url');
  const state = await new SignJWT({ nonce, returnTo })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + STATE_TTL)
    .sign(stateKey);
  return { state, nonce };
}

export async function readState(state: string): Promise<PendingLogin> {
  try {
    const { payload } = await jwtVerify(state, stateKey);
    return { nonce: String(payload.nonce), returnTo: String(payload.returnTo ?? '/') };
  } catch {
    throw new UnauthorizedError('Sign-in request expired. Please try again.');
  }
}

export function authorizeUrl(state: string, nonce: string): string {
  const u = new URL(`https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`);
  u.searchParams.set('client_id', env.ENTRA_CLIENT_ID!);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', env.ENTRA_REDIRECT_URI!);
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('scope', 'openid profile email');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  return u.toString();
}

interface TokenResponse {
  id_token?: string;
  error_description?: string;
}

/** Exchange the authorization code for an ID token at the tenant's token endpoint. */
async function exchangeCode(code: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.ENTRA_CLIENT_ID!,
    client_secret: env.ENTRA_CLIENT_SECRET!,
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.ENTRA_REDIRECT_URI!,
    scope: 'openid profile email',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.id_token) {
    throw new UnauthorizedError(data.error_description ?? 'Microsoft rejected the sign-in.');
  }
  return data.id_token;
}

export interface EntraIdentity {
  email: string;
  name?: string;
  oid: string;
}

/**
 * Complete the flow: exchange the code, verify the ID token's signature,
 * issuer, audience and nonce, then enforce the email-domain allow-list.
 */
export async function completeLogin(code: string, expectedNonce: string): Promise<EntraIdentity> {
  const idToken = await exchangeCode(code);

  const { payload } = await jwtVerify(idToken, keys(), {
    issuer: authority(),
    audience: env.ENTRA_CLIENT_ID!,
  });

  if (payload.nonce !== expectedNonce)
    throw new UnauthorizedError('Sign-in could not be verified.');

  const raw = (payload.email ?? payload.preferred_username ?? payload.upn) as string | undefined;
  const email = raw?.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new ValidationError('Your Microsoft account has no email address attached.');
  }

  const domain = email.split('@')[1]!;
  const allowed = entraAllowedDomains();
  if (!allowed.includes(domain)) {
    throw new UnauthorizedError(`${email} is outside the organizations permitted to sign in here.`);
  }

  return {
    email,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    oid: String(payload.oid ?? payload.sub),
  };
}
