import { describe, it, expect, beforeAll } from 'vitest';

// Integration: real JWT sign/verify round-trip through the auth module.
beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

describe('auth tokens', () => {
  it('signs and verifies an access token', async () => {
    const { signAccessToken, verifyAccessToken } = await import('../../src/auth/tokens.js');
    const token = await signAccessToken({ sub: 'user-1', role: 'USER' });
    const claims = await verifyAccessToken(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.role).toBe('USER');
  });

  it('rejects a tampered token', async () => {
    const { verifyAccessToken } = await import('../../src/auth/tokens.js');
    await expect(verifyAccessToken('not.a.token')).rejects.toThrow();
  });
});
