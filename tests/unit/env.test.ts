import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const base = {
  DATABASE_URL: 'postgresql://a:b@localhost:5432/db',
  JWT_ACCESS_SECRET: 'aaaaaaaaaaaaaaaa',
  JWT_REFRESH_SECRET: 'bbbbbbbbbbbbbbbb',
};

describe('env validation', () => {
  it('accepts a valid environment', () => {
    expect(loadEnv({ ...base } as NodeJS.ProcessEnv).PORT).toBe(3000);
  });
  it('throws on missing required vars', () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/Invalid environment/);
  });
  it('throws on an invalid DATABASE_URL', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: 'not-a-url' } as NodeJS.ProcessEnv)).toThrow();
  });
});
