import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockEnv: { IPINFO_TOKEN?: string } = { IPINFO_TOKEN: 'test-token' };
vi.mock('../../src/config/env.js', () => ({
  get env() {
    return mockEnv;
  },
}));

import { resolveIpLocation } from '../../src/integrations/geolocation.js';

describe('resolveIpLocation', () => {
  it('resolves a public IP to "City, Country"', async () => {
    mockEnv.IPINFO_TOKEN = 'test-token';
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ city: 'Castle Rock', country: 'US' }), {
        status: 200,
      })) as typeof fetch;
    const location = await resolveIpLocation('24.9.44.164', fakeFetch);
    expect(location).toBe('Castle Rock, United States');
  });

  it('returns null when no token is configured, without making a request', async () => {
    mockEnv.IPINFO_TOKEN = undefined;
    const fakeFetch = vi.fn();
    const location = await resolveIpLocation('24.9.44.164', fakeFetch as unknown as typeof fetch);
    expect(location).toBeNull();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('returns null for a missing IP', async () => {
    mockEnv.IPINFO_TOKEN = 'test-token';
    const location = await resolveIpLocation(null);
    expect(location).toBeNull();
  });

  it('skips the lookup for private/local addresses', async () => {
    mockEnv.IPINFO_TOKEN = 'test-token';
    const fakeFetch = vi.fn();
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '::1']) {
      const location = await resolveIpLocation(ip, fakeFetch as unknown as typeof fetch);
      expect(location).toBeNull();
    }
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('returns null when ipinfo reports a bogon address', async () => {
    mockEnv.IPINFO_TOKEN = 'test-token';
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ bogon: true }), { status: 200 })) as typeof fetch;
    const location = await resolveIpLocation('0.0.0.1', fakeFetch);
    expect(location).toBeNull();
  });

  it('returns null on a non-OK response rather than throwing', async () => {
    mockEnv.IPINFO_TOKEN = 'test-token';
    const fakeFetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const location = await resolveIpLocation('24.9.44.164', fakeFetch);
    expect(location).toBeNull();
  });

  it('returns null when the request throws', async () => {
    mockEnv.IPINFO_TOKEN = 'test-token';
    const fakeFetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const location = await resolveIpLocation('24.9.44.164', fakeFetch);
    expect(location).toBeNull();
  });
});
