import { describe, it, expect } from 'vitest';
import { safeReturnPath, scriptSafeJson } from '../../src/routes/sso.js';
import { isBlobStoreUrl } from '../../src/lib/fileStore.js';
import { financeRecipientProblem } from '../../src/routes/finance.js';
import { secretsEqual, isBearerSecret } from '../../src/lib/secretCompare.js';
import { loadEnv, resetLinkBaseUrl, weakJwtSecrets } from '../../src/config/env.js';

describe('safeReturnPath', () => {
  it.each([
    ['/orders/123', '/orders/123'],
    ['/a?b=1#c', '/a?b=1#c'],
    ['/', '/'],
  ])('keeps %s', (input, out) => {
    expect(safeReturnPath(input)).toBe(out);
  });

  it.each([
    'https://evil.example/',
    '//evil.example/',
    '/' + String.fromCharCode(92) + 'evil.example/',
    '/\t/evil.example/',
    '/\n/evil.example',
    'javascript:alert(1)',
    'evil',
    '',
  ])('drops %j', (input) => {
    expect(safeReturnPath(input)).toBe('/');
  });

  it('drops a non-string', () => {
    expect(safeReturnPath(undefined)).toBe('/');
  });
});

describe('scriptSafeJson', () => {
  it('cannot close a script element, and round-trips', () => {
    const lsps = String.fromCharCode(0x2028, 0x2029);
    const value = { to: '/</script><script>x</script>&' + lsps };
    const out = scriptSafeJson(value);
    for (const ch of ['<', '>', '&', ...lsps]) expect(out).not.toContain(ch);
    expect(JSON.parse(out)).toEqual(value);
  });
});

describe('isBlobStoreUrl', () => {
  it.each([
    'https://abc.private.blob.vercel-storage.com/x.pdf',
    'https://abc.public.blob.vercel-storage.com/x.pdf',
  ])('accepts %s', (u) => expect(isBlobStoreUrl(u)).toBe(true));

  it.each([
    'https://attacker.example/x.pdf',
    'http://abc.blob.vercel-storage.com/x.pdf',
    'https://blob.vercel-storage.com.attacker.example/x.pdf',
    'https://abc.blob.vercel-storage.com@attacker.example/x.pdf',
    'https://user:pw@abc.blob.vercel-storage.com/x.pdf',
    'not a url',
  ])('refuses %s', (u) => expect(isBlobStoreUrl(u)).toBe(false));
});

describe('financeRecipientProblem', () => {
  const partner = 'contact@ryancapital.com';
  const company = 'Orders@SummitSensory.com';
  const check = (to?: string, cc?: string) => financeRecipientProblem(to, cc, partner, company);

  it('allows the default partner, a colleague at the partner, and company/partner copies', () => {
    expect(check()).toBeNull();
    expect(check('other@RyanCapital.com')).toBeNull();
    expect(check(undefined, 'rep@summitsensory.com, other@ryancapital.com')).toBeNull();
  });

  it('refuses any other recipient', () => {
    expect(check('someone@attacker.example')).toMatch(/finance partner/);
    expect(check(undefined, 'rep@summitsensory.com, x@attacker.example')).toMatch(/copied/);
    expect(check(undefined, 'not-an-address')).toMatch(/not an email/);
  });
});

describe('secret comparison', () => {
  it('matches only the exact secret', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
    expect(secretsEqual('abd', 'abc')).toBe(false);
    expect(secretsEqual('ab', 'abc')).toBe(false);
    expect(isBearerSecret('Bearer s3cret-value', 's3cret-value')).toBe(true);
    expect(isBearerSecret('s3cret-value', 's3cret-value')).toBe(false);
    expect(isBearerSecret(undefined, 's3cret-value')).toBe(false);
  });
});

describe('environment hardening', () => {
  const base = {
    DATABASE_URL: 'postgresql://a:b@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a'.repeat(16),
    JWT_REFRESH_SECRET: 'b'.repeat(16),
  };

  it('production flags JWT secrets shorter than 32 characters without refusing to boot', () => {
    // A short key is warned about at boot, never fatal: refusing to start would take
    // the live CRM down on the next deploy.
    const shortProd = loadEnv({ ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(weakJwtSecrets(shortProd)).toEqual(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']);
    const longProd = loadEnv({
      ...base,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
    } as NodeJS.ProcessEnv);
    expect(weakJwtSecrets(longProd)).toEqual([]);
    expect(weakJwtSecrets(loadEnv({ ...base } as NodeJS.ProcessEnv))).toEqual([]);
  });

  it('reset links come from configuration only, never a request', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
    };
    expect(resetLinkBaseUrl(loadEnv(prod as NodeJS.ProcessEnv))).toBeNull();
    expect(
      resetLinkBaseUrl(
        loadEnv({ ...prod, APP_BASE_URL: 'https://crm.example.com' } as NodeJS.ProcessEnv),
      ),
    ).toBe('https://crm.example.com');
    expect(resetLinkBaseUrl(loadEnv({ ...base } as NodeJS.ProcessEnv))).toBe(
      'http://localhost:3000',
    );
  });
});
