import { test, expect } from '@playwright/test';

// Full-stack e2e: requires the API running against a seeded Postgres and a
// SYSTEM_ADMIN bearer token in E2E_TOKEN. The anonymous checks always run.
//
// Catalog → BOM setup (public/catalog.js, src/routes/bomSetup.ts) and the order
// page's Arrange lines / save-for-future actions that write back to it.
const token = process.env.E2E_TOKEN;

test('BOM setup refuses an anonymous caller', async ({ request }) => {
  for (const [method, url] of [
    ['get', '/bom-setup/parts'],
    ['get', '/bom-setup/hardware-check'],
    ['get', '/bom-setup/export'],
  ] as const) {
    const res = await request[method](url);
    expect(res.status(), url).toBe(401);
  }
  const bulk = await request.patch('/bom-setup/parts', {
    data: { parts: ['P-1'], set: { bomGroup: '' } },
  });
  expect(bulk.status()).toBe(401);
  const arrange = await request.post('/orders/o1/bom/arrange', {
    data: { vendor: 'X', lineIds: ['l1'] },
  });
  expect(arrange.status()).toBe(401);
});

test.describe('BOM setup', () => {
  test.skip(!token, 'set E2E_TOKEN and run against a live stack');

  test('lists every part with its BOM settings and the automatic heading', async ({ request }) => {
    const res = await request.get('/bom-setup/parts', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.parts)).toBe(true);
    if (body.parts.length)
      expect(body.parts[0]).toEqual(
        expect.objectContaining({ part: expect.any(String), autoHeading: expect.any(String) }),
      );
  });

  test('explains every Hardware part', async ({ request }) => {
    const res = await request.get('/bom-setup/hardware-check', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const { rows } = await res.json();
    for (const r of rows) expect(r.printsUnderHardware || r.reasons.length > 0).toBe(true);
  });
});
