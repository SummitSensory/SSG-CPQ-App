import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * Canva connect + token refresh, against a stub row and a stub token endpoint.
 * Fake credentials only; nothing reaches Canva.
 */

let ROW: Record<string, unknown> | null = null;

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    canvaConnection: {
      findUnique: async () => (ROW ? { ...ROW } : null),
      upsert: async ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        ROW = ROW ? { ...ROW, ...update } : { ...create };
        return ROW;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        ROW = { ...ROW, ...data };
        return ROW;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (!ROW || (where.refreshToken !== undefined && ROW.refreshToken !== where.refreshToken))
          return { count: 0 };
        ROW = { ...ROW, ...data };
        return { count: 1 };
      },
    },
  },
}));

beforeAll(() => {
  process.env.CANVA_CLIENT_ID = 'test-client';
  process.env.CANVA_CLIENT_SECRET = 'test-secret';
  process.env.CANVA_REDIRECT_URI = 'https://crm.test/integrations/canva/callback';
  process.env.CANVA_TOKEN_ENC_KEY = 'test-key-test-key-test-key-test-key-0001';
  process.env.CANVA_API_URL = 'https://api.canva.test/rest';
});

beforeEach(() => {
  ROW = null;
});

function tokenEndpoint(responses: Array<Record<string, unknown>>) {
  const bodies: URLSearchParams[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    const r = responses.shift();
    return new Response(JSON.stringify(r ?? {}), { status: r ? 200 : 400 });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

describe('canva oauth', () => {
  it('PKCE challenge is the S256 of the verifier', async () => {
    const { pkcePair } = await import('../../src/integrations/canva/oauth.js');
    const { verifier, challenge } = pkcePair();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('encrypts tokens at rest', async () => {
    const { encryptSecret, decryptSecret } = await import('../../src/integrations/canva/oauth.js');
    const enc = encryptSecret('secret-token');
    expect(enc).not.toContain('secret-token');
    expect(decryptSecret(enc)).toBe('secret-token');
  });

  it('connect: the verifier stays server-side and the state is single-use', async () => {
    const { beginCanvaConnect, completeCanvaConnect, canvaAccessToken } =
      await import('../../src/integrations/canva/oauth.js');
    const url = new URL(await beginCanvaConnect('user-admin'));
    expect(url.origin + url.pathname).toBe('https://www.canva.com/api/oauth/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    expect(url.searchParams.get('scope')).toContain('design:content:write');
    const state = url.searchParams.get('state')!;
    // Neither the verifier nor the raw state is stored in the clear.
    expect(String(ROW!.pendingState)).not.toBe(state);

    const { impl, bodies } = tokenEndpoint([
      { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 },
    ]);
    await completeCanvaConnect('code-1', state, impl);
    expect(bodies[0]!.get('grant_type')).toBe('authorization_code');
    expect(bodies[0]!.get('code_verifier')).toBeTruthy();
    expect(ROW!.pendingState).toBeNull();
    expect(await canvaAccessToken(impl)).toBe('at1');

    await expect(completeCanvaConnect('code-1', state, impl)).rejects.toThrow(
      /expired or was already used/,
    );
  });

  it('refreshes an expired token and stores the rotated refresh token', async () => {
    const { encryptSecret, decryptSecret, canvaAccessToken } =
      await import('../../src/integrations/canva/oauth.js');
    ROW = {
      key: 'default',
      accessToken: encryptSecret('old'),
      refreshToken: encryptSecret('rt-old'),
      expiresAt: new Date(Date.now() - 1000),
      scope: 's',
    };
    const { impl, bodies } = tokenEndpoint([
      { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 },
    ]);
    expect(await canvaAccessToken(impl)).toBe('at-new');
    expect(bodies[0]!.get('refresh_token')).toBe('rt-old');
    expect(decryptSecret(String(ROW!.refreshToken))).toBe('rt-new');
  });

  it('not connected is a plain error', async () => {
    const { canvaAccessToken } = await import('../../src/integrations/canva/oauth.js');
    await expect(canvaAccessToken()).rejects.toThrow(/Canva is not connected/);
  });
});
