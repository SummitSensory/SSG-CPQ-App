import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PROPOSAL-004 — the access token is a stateless JWT carrying the role, so a
 * deactivated user and a demoted user both kept their old authority until the token
 * expired. requireAuth now checks live account state and trusts the DATABASE role
 * rather than the token's copy of it.
 */
const findUnique = vi.fn();
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { user: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));
const verifyAccessToken = vi.fn();
vi.mock('../../src/auth/tokens.js', () => ({
  verifyAccessToken: (t: string) => verifyAccessToken(t),
}));

const { requireAuth, clearAccountCache } = await import('../../src/plugins/authz.js');

const req = (token = 'x') =>
  ({ headers: { authorization: `Bearer ${token}` } }) as unknown as Parameters<
    typeof requireAuth
  >[0];
const reply = {} as unknown as Parameters<typeof requireAuth>[1];

describe('requireAuth live account state', () => {
  beforeEach(() => {
    findUnique.mockReset();
    verifyAccessToken.mockReset();
    clearAccountCache();
  });

  it('accepts an active user and attaches the principal', async () => {
    verifyAccessToken.mockResolvedValue({ sub: 'u1', role: 'SALES_REP' });
    findUnique.mockResolvedValue({ isActive: true, role: 'SALES_REP' });
    const r = req();
    await requireAuth(r, reply);
    expect(r.user).toEqual({ sub: 'u1', role: 'SALES_REP' });
  });

  it('refuses a token belonging to a deactivated user', async () => {
    verifyAccessToken.mockResolvedValue({ sub: 'u1', role: 'SALES_REP' });
    findUnique.mockResolvedValue({ isActive: false, role: 'SALES_REP' });
    await expect(requireAuth(req(), reply)).rejects.toThrow();
  });

  it('refuses a token for a user who no longer exists', async () => {
    verifyAccessToken.mockResolvedValue({ sub: 'gone', role: 'SALES_REP' });
    findUnique.mockResolvedValue(null);
    await expect(requireAuth(req(), reply)).rejects.toThrow();
  });

  it('uses the database role, not the role inside the token', async () => {
    verifyAccessToken.mockResolvedValue({ sub: 'u1', role: 'SYSTEM_ADMIN' });
    findUnique.mockResolvedValue({ isActive: true, role: 'READ_ONLY' });
    const r = req();
    await requireAuth(r, reply);
    expect(r.user?.role).toBe('READ_ONLY');
  });

  it('caches account state briefly instead of querying per request', async () => {
    verifyAccessToken.mockResolvedValue({ sub: 'u1', role: 'SALES_REP' });
    findUnique.mockResolvedValue({ isActive: true, role: 'SALES_REP' });
    await requireAuth(req(), reply);
    await requireAuth(req(), reply);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
