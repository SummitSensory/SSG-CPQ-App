import { describe, it, expect, vi, beforeAll } from 'vitest';

/**
 * The proposal preview's Print loads the server-rendered PDF into a hidden frame as a
 * blob: URL and prints that frame (printPdf in public/app.js). With no frame-src the
 * CSP falls back to default-src 'self', which refuses blob: frames — Print would then
 * silently do nothing. This pins the directive, and that it widens nothing else.
 */
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: new Proxy(
    {},
    {
      get: () =>
        new Proxy(() => Promise.resolve(null), {
          get: () => () => Promise.resolve(null),
        }),
    },
  ),
}));

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

describe('Content-Security-Policy', () => {
  it("allows blob: frames (the preview's Print) and nothing broader", async () => {
    const { buildApp } = await import('../../src/app.js');
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/health' });
    const csp = String(res.headers['content-security-policy'] ?? '');
    const directives = Object.fromEntries(
      csp
        .split(';')
        .map((d) => d.trim().split(/\s+/))
        .filter((d) => d[0])
        .map(([name, ...values]) => [name, values]),
    );
    expect(directives['frame-src']).toEqual(["'self'", 'blob:']);
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['script-src']).toEqual(["'self'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    await app.close();
  }, 30_000);
});
