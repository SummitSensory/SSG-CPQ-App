import { describe, it, expect, beforeAll } from 'vitest';

/**
 * The two pieces that keep a large reference document (a product catalog) under a
 * Vercel function's ~4.5 MB response: the preview's page batches, and the signed
 * tickets Save PDF reads a parked PDF back with.
 */

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-xxxxxx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-xxxxx';
  process.env.DATABASE_URL ??= 'postgresql://a:b@localhost:5432/db';
});

const page = (mb: number) => ({
  width: 1,
  height: 1,
  dataUri: 'x'.repeat(Math.round(mb * 1024 * 1024)),
});

describe('pageBatch', () => {
  it('splits a catalog-sized document into batches under the response limit', async () => {
    const { pageBatch, PAGE_BATCH_BYTES } = await import('../../src/routes/referenceDocuments.js');
    const pages = Array.from({ length: 23 }, () => page(0.43));
    let from: number | null = 0;
    const sizes: number[] = [];
    while (from !== null) {
      const b: ReturnType<typeof pageBatch<(typeof pages)[number]>> = pageBatch(pages, from);
      expect(b.pages.reduce((n, p) => n + p.dataUri.length, 0)).toBeLessThanOrEqual(
        PAGE_BATCH_BYTES,
      );
      expect(b.total).toBe(23);
      sizes.push(b.pages.length);
      from = b.next;
    }
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(23);
    expect(sizes.length).toBeGreaterThan(1);
  });

  it('returns a small document whole, and always at least one page', async () => {
    const { pageBatch } = await import('../../src/routes/referenceDocuments.js');
    expect(pageBatch([page(0.1)], 0)).toMatchObject({ total: 1, next: null });
    const oversized = pageBatch([page(3.5), page(0.1)], 0);
    expect(oversized.pages).toHaveLength(1);
    expect(oversized.next).toBe(1);
    expect(pageBatch([page(0.1)], 5)).toMatchObject({ pages: [], next: null });
  });
});

describe('PDF part tickets', () => {
  const url = 'https://store.private.blob.vercel-storage.com/rendered-pdfs/abc-Big.pdf';

  it('round-trips a ticket it signed', async () => {
    const { issueTicket, readTicket } = await import('../../src/render/pdfDelivery.js');
    expect(readTicket(issueTicket(url))).toBe(url);
  });

  it('refuses an expired or altered ticket', async () => {
    const { issueTicket, readTicket } = await import('../../src/render/pdfDelivery.js');
    expect(readTicket(issueTicket(url, Date.now() - 11 * 60_000))).toBeNull();
    const [payload, mac] = issueTicket(url).split('.');
    const swapped = Buffer.from(
      JSON.stringify({
        u: url.replace('rendered-pdfs', 'purchase-orders'),
        exp: Date.now() + 60_000,
      }),
    ).toString('base64url');
    expect(readTicket(`${swapped}.${mac}`)).toBeNull();
    expect(readTicket(String(payload))).toBeNull();
    expect(readTicket('')).toBeNull();
  });
});
