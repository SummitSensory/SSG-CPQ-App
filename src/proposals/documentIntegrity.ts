import { versionTotals } from './analytics.js';

/**
 * Does the document a client asked us to send match the proposal we hold?
 *
 * Two send paths take the rendered proposal as an HTML string from the browser and
 * turn it into a PDF the business is bound by:
 *
 *   POST /render/esign/proposals/versions/:versionId/send   → the signed contract
 *   POST /render/proposals/versions/:versionId/monday-file  → the deal board's copy
 *
 * The stated reason is sound: the customer signs exactly what the rep previewed. But
 * nothing checked that the previewed document agrees with the stored proposal. A
 * stale tab, a half-applied freight true-up, or a caller posting hand-edited HTML
 * straight to the endpoint all produce a signed PDF whose total is not the total in
 * the database — and from then on the contract, the QuickBooks invoice and the
 * reports disagree with no record of which is right.
 *
 * The check is deliberately narrow: find the server's grand total, formatted the way
 * the document formats money, and require it to appear in the HTML. It does not try
 * to parse the document or re-render it server-side (that would be a rewrite of the
 * proposal renderer, and the browser is the renderer of record here). It catches the
 * case that costs money — a document showing a different bottom line — and stays
 * silent about layout, wording and every other difference.
 */

/** `123456` → `1,234.56`, matching the builder's own formatting. */
export function formatMinor(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}.${cents}`;
}

/** Strip tags and normalise whitespace and non-breaking spaces before matching. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/**
 * The same text with every space removed, then also without thousands separators.
 *
 * A template that prints the total across several elements — `<b>5,125</b>.50`, or a
 * currency symbol in its own span — leaves a space where the tag was. Matching only
 * the spaced form would refuse a document that is perfectly correct, which is a worse
 * failure than the one this check exists to prevent. Both normalisations only ever
 * make a match MORE likely; a document showing a different bottom line still fails
 * all of them.
 */
function variants(html: string): string[] {
  const spaced = textOf(html);
  const tight = spaced.replace(/\s/g, '');
  return [spaced, tight, tight.replace(/,/g, '')];
}

export interface TotalCheck {
  ok: boolean;
  expectedMinor: number;
  expected: string;
}

/**
 * True when the server's grand total appears in the submitted document.
 *
 * A zero total is exempt: a proposal with no priced lines is a legitimate document
 * (a specification, an options sheet) and "0.00" appears in too many places for the
 * match to mean anything.
 */
export function checkDocumentTotal(html: string, items: unknown, sections: unknown): TotalCheck {
  const totals = versionTotals(items, sections);
  const expectedMinor = Math.round(totals.total);
  const expected = formatMinor(expectedMinor);
  if (expectedMinor === 0) return { ok: true, expectedMinor, expected };
  const forms = variants(String(html ?? ''));
  const plain = expected.replace(/,/g, '');
  const ok = forms.some((f) => f.includes(expected)) || forms.some((f) => f.includes(plain));
  return { ok, expectedMinor, expected };
}
