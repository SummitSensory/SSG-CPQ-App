import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bomPhone, usDate, usDatesInText } from '../../src/handoff/bomDelivery.js';

/**
 * The browser's copies of the BOM print rules must agree with the server's.
 *
 * public/app.js cannot import from src/, so bomPhoneText, bomUsDate and
 * bomUsDatesInText are hand-kept mirrors of bomPhone, usDate and usDatesInText. They
 * print the on-screen delivery block and the browser's print-to-PDF fallback — a
 * document a vendor ships against — so a mirror that drifts is a sheet that says one
 * date on the screen and another in the Excel. The functions are lifted out of the
 * shipped file itself and run against the same inputs as the server versions.
 */

const app = readFileSync(join(__dirname, '..', '..', 'public', 'app.js'), 'utf8').split(/\r?\n/);

function clientFn<T extends (...a: never[]) => unknown>(name: string): T {
  const i = app.findIndex((l) => l.startsWith(`  function ${name}(`));
  const j = app.findIndex((l, k) => k > i && l === '  }');
  expect(i, `${name} not found in public/app.js`).toBeGreaterThanOrEqual(0);
  const src = app.slice(i, j + 1).join('\n');
  return new Function(`${src}\nreturn ${name};`)() as T;
}

const DATES = ['2026-09-22', '2026-11-06', '', 'TBD', '2026-09-22T12:00:00Z', '  2026-01-02  '];
const TEXTS = [
  'Schedule delivery on or after 2026-11-06',
  'Between 2026-11-06 and 2026-11-13',
  '2026-11-06',
  'Weekday mornings',
  'PO 12026-11-061',
  '',
  'Part 1234-56-78',
  'Suite 2026-01-15B',
  'SO-2026-000036',
  'Deliver 2026-11-06T10:00',
  'Code 2026-13-45',
  'Ref A2026-11-06',
  'Lot 2026-11-06-3',
  'Bin 2026-11-06_A',
  '(2026-11-06), then 2026-11-13.',
  '2026-11-06 2026-11-13',
];
const PHONES = [
  '17708519515',
  '+1 (323) 496-0544',
  '303-748-8082',
  '+44 20 7946 0958',
  '303-748-8082 ext 12',
  '748-8082',
  '',
];

describe('public/app.js BOM print helpers match the server', () => {
  it('bomUsDate === usDate', () => {
    const f = clientFn<(v: string) => string>('bomUsDate');
    for (const d of DATES) expect(f(d), d).toBe(usDate(d));
  });

  it('bomUsDatesInText === usDatesInText', () => {
    const f = clientFn<(v: string) => string>('bomUsDatesInText');
    for (const t of TEXTS) expect(f(t), t).toBe(usDatesInText(t));
  });

  it('bomPhoneText === bomPhone().text', () => {
    const f = clientFn<(v: string) => string>('bomPhoneText');
    for (const p of PHONES) expect(f(p), p).toBe(bomPhone(p).text);
  });
});
