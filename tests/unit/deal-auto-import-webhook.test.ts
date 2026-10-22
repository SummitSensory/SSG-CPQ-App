import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * The Deal Tracking create_item subscription is declared alongside the portal's, so
 * the nightly cron's syncWebhooks registers it (and repairs it if it is deleted in
 * monday). MONDAY_DEAL_AUTO_IMPORT=false takes it back out without a code change.
 */

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

async function specs() {
  vi.resetModules();
  const { desiredWebhooks } = await import('../../src/integrations/monday/webhookRegistration.js');
  return desiredWebhooks();
}

describe('desiredWebhooks — Deal Tracking create_item', () => {
  it('is declared when monday is configured', async () => {
    process.env.MONDAY_API_TOKEN = 'test-token';
    delete process.env.MONDAY_DEAL_AUTO_IMPORT;
    const deals = (await specs()).filter((s) => s.boardId === '6527740233');
    expect(deals).toEqual([expect.objectContaining({ event: 'create_item' })]);
  });

  it('is left out when switched off', async () => {
    process.env.MONDAY_API_TOKEN = 'test-token';
    process.env.MONDAY_DEAL_AUTO_IMPORT = 'false';
    expect((await specs()).some((s) => s.boardId === '6527740233')).toBe(false);
  });

  it('is left out with no monday token', async () => {
    delete process.env.MONDAY_API_TOKEN;
    expect((await specs()).some((s) => s.boardId === '6527740233')).toBe(false);
  });
});
