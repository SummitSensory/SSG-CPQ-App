import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { UnauthorizedError } from '../lib/errors.js';

const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshKey = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

export interface TokenClaims {
  sub: string;
  role: string;
}

async function sign(claims: TokenClaims, key: Uint8Array, ttl: number): Promise<string> {
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(key);
}

export const signAccessToken = (c: TokenClaims): Promise<string> =>
  sign(c, accessKey, env.JWT_ACCESS_TTL);
export const signRefreshToken = (c: TokenClaims): Promise<string> =>
  sign(c, refreshKey, env.JWT_REFRESH_TTL);

async function verify(token: string, key: Uint8Array): Promise<TokenClaims> {
  try {
    const { payload } = await jwtVerify(token, key);
    return { sub: String(payload.sub), role: String(payload.role) };
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
}

export const verifyAccessToken = (t: string): Promise<TokenClaims> => verify(t, accessKey);
export const verifyRefreshToken = (t: string): Promise<TokenClaims> => verify(t, refreshKey);
