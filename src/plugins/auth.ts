import type { FastifyRequest } from 'fastify';
import { verifyAccessToken, type TokenClaims } from '../auth/tokens.js';
import { UnauthorizedError } from '../lib/errors.js';

/** Extract & verify the bearer token. No placeholder/bypass auth in any path. */
export async function authenticate(req: FastifyRequest): Promise<TokenClaims> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing bearer token');
  }
  return verifyAccessToken(header.slice('Bearer '.length));
}
