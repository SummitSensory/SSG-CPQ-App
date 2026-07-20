import { jwtVerify } from 'jose';
import { env } from '../../config/env.js';

/**
 * Verify a monday webhook. monday signs each delivery with a JWT in the
 * Authorization header, signed with the account signing secret (HS256).
 */
export async function verifyMondayWebhook(authHeader: string | undefined): Promise<boolean> {
  if (!authHeader || !env.MONDAY_SIGNING_SECRET) return false;
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  try {
    await jwtVerify(token, new TextEncoder().encode(env.MONDAY_SIGNING_SECRET));
    return true;
  } catch {
    return false;
  }
}
