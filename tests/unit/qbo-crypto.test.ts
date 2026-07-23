import { describe, it, expect, beforeAll } from 'vitest';

/** OAuth tokens must be encrypted at rest and tamper-evident. */
beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.QBO_CLIENT_ID ??= 'client-id';
  process.env.QBO_CLIENT_SECRET ??= 'client-secret';
  process.env.QBO_REDIRECT_URI ??= 'https://app.example.com/qbo/callback';
  process.env.QBO_TOKEN_ENC_KEY ??= '0123456789abcdef0123456789abcdef';
});

describe('QuickBooks token encryption', () => {
  it('round-trips a token through encrypt/decrypt', async () => {
    const { encryptToken, decryptToken } = await import('../../src/integrations/quickbooks/crypto.js');
    const secret = 'refresh-token-abc.def.ghi';
    const enc = encryptToken(secret);
    expect(enc).not.toContain(secret);
    expect(decryptToken(enc)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', async () => {
    const { encryptToken } = await import('../../src/integrations/quickbooks/crypto.js');
    expect(encryptToken('same')).not.toBe(encryptToken('same'));
  });

  it('rejects a tampered ciphertext (auth tag)', async () => {
    const { encryptToken, decryptToken } = await import('../../src/integrations/quickbooks/crypto.js');
    const enc = encryptToken('secret');
    const buf = Buffer.from(enc, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a tag bit
    expect(() => decryptToken(buf.toString('base64'))).toThrow();
  });
});
