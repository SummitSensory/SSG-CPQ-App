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
    // The shipped default size for every slot, so the admin editor never needs its
    // own hardcoded copy of these numbers.
    expect(body.defaults.ssgSigAcceptanceSignature).toMatchObject({
      width: 220,
      height: 40,
      fontSize: 18,
    });

    // Leave the shared singleton the way this suite found it.
    await request.put('/signature-field-layout', { headers: auth, data: { offsets: {} } });
  });

  test('saves a size independently of position, and independently per box', async ({ request }) => {
    const auth = { Authorization: 'Bearer ' + token };

    const saved = await request.put('/signature-field-layout', {
      headers: auth,
      data: {
        offsets: {
          // Position only — never resized.
          ssgSigAcceptanceSignature: { top: 3, left: -2 },
          // Size only — never moved.
          ssgSigAcceptanceDate: { width: 200, height: 50, fontSize: 16 },
        },
      },
    });
    expect(saved.ok()).toBeTruthy();
    const body = (await saved.json()).offsets;
    expect(body.ssgSigAcceptanceSignature).toEqual({ top: 3, left: -2 });
    expect(body.ssgSigAcceptanceDate).toEqual({ width: 200, height: 50, fontSize: 16 });

    await request.put('/signature-field-layout', { headers: auth, data: { offsets: {} } });
  });

  test('refuses a placement/size outside its own bounds, and an unknown slot id', async ({
    request,
  }) => {
    const auth = { Authorization: 'Bearer ' + token };

    const tooFar = await request.put('/signature-field-layout', {
      headers: auth,
      data: { offsets: { ssgSigAcceptanceDate: { top: 9999, left: 0 } } },
    });
    expect(tooFar.status()).toBe(400);

    const tooWide = await request.put('/signature-field-layout', {
      headers: auth,
      data: { offsets: { ssgSigAcceptanceDate: { width: 99999 } } },
    });
    expect(tooWide.status()).toBe(400);

    const unknown = await request.put('/signature-field-layout', {
      headers: auth,
      data: { offsets: { notARealSlot: { top: 0, left: 0 } } },
    });
    expect(unknown.status()).toBe(400);
  });
});
