import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * AES-256-GCM encryption for OAuth tokens at rest. The key is derived from
 * QBO_TOKEN_ENC_KEY (env only — never source). Output format is
 * base64(iv[12] | ciphertext | tag[16]). Authentication tag guarantees the
 * stored value has not been tampered with.
 */
function key(): Buffer {
  if (!env.QBO_TOKEN_ENC_KEY) throw new Error('QBO_TOKEN_ENC_KEY not configured');
  // Normalize any provided key material to exactly 32 bytes.
  return createHash('sha256').update(env.QBO_TOKEN_ENC_KEY).digest();
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64');
}

export function decryptToken(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
