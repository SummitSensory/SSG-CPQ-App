import { test, expect } from '@playwright/test';

// Full-stack e2e: requires the API running against a seeded Postgres and a
// SYSTEM_ADMIN bearer token in E2E_TOKEN. Skipped automatically when unset.
const token = process.env.E2E_TOKEN;

test.describe('signature field layout', () => {
  test.skip(!token, 'set E2E_TOKEN and run against a live stack');

  test('saves a placement, then reads it back as the effective layout', async ({ request }) => {
    const auth = { Authorization: 'Bearer ' + token };

    const saved = await request.put('/signature-field-layout', {
      headers: auth,
      data: { offsets: { ssgSigAcceptanceDate: { top: -6, left: 4 } } },
    });
    expect(saved.ok()).toBeTruthy();
    expect((await saved.json()).offsets).toMatchObject({
      ssgSigAcceptanceDate: { top: -6, left: 4 },
    });

    const effective = await request.get('/signature-field-layout/effective', { headers: auth });
    expect(effective.ok()).toBeTruthy();
    const body = await effective.json();
    expect(body.offsets).toMatchObject({ ssgSigAcceptanceDate: { top: -6, left: 4 } });
    expect(body.slotIds).toContain('ssgSigAcceptanceDate');

    // Leave the shared singleton the way this suite found it.
    await request.put('/signature-field-layout', { headers: auth, data: { offsets: {} } });
  });

  test('refuses an offset outside the printable range and an unknown slot id', async ({
    request,
  }) => {
    const auth = { Authorization: 'Bearer ' + token };

    const tooFar = await request.put('/signature-field-layout', {
      headers: auth,
      data: { offsets: { ssgSigAcceptanceDate: { top: 9999, left: 0 } } },
    });
    expect(tooFar.status()).toBe(400);

    const unknown = await request.put('/signature-field-layout', {
      headers: auth,
      data: { offsets: { notARealSlot: { top: 0, left: 0 } } },
    });
    expect(unknown.status()).toBe(400);
  });
});
