import { describe, it, expect } from 'vitest';
import { checkDocumentTotal, formatMinor } from '../../src/proposals/documentIntegrity.js';

/**
 * PROPOSAL-007 — the signed PDF and the deal-board PDF are built from HTML the
 * client posts, and nothing checked it against the stored proposal.
 */
describe('document total verification', () => {
  const items = [
    { lineType: 'PRODUCT', quantity: 2, rateMinor: 250_000 },
    { lineType: 'PRODUCT', quantity: 1, rateMinor: 125_50 },
  ];
  // 2 × 2,500.00 + 1 × 125.50 = 5,125.50
  const sections = [{ id: 'meta', data: {} }];

  it('formats minor units the way a document prints them', () => {
    expect(formatMinor(512_550)).toBe('5,125.50');
    expect(formatMinor(5)).toBe('0.05');
    expect(formatMinor(-512_550)).toBe('-5,125.50');
  });

  it('accepts a document showing the server total', () => {
    const html = '<table><tr><td>Total</td><td>$5,125.50</td></tr></table>';
    expect(checkDocumentTotal(html, items, sections).ok).toBe(true);
  });

  it('accepts the same figure without a thousands separator', () => {
    expect(checkDocumentTotal('<p>Total 5125.50</p>', items, sections).ok).toBe(true);
  });

  it('accepts the figure split across markup, as a template may print it', () => {
    const html = '<span>$</span><b>5,125</b><span>.50</span>';
    expect(checkDocumentTotal(html, items, sections).ok).toBe(true);
  });

  it('refuses a document whose total disagrees with the proposal', () => {
    const stale = '<table><tr><td>Total</td><td>$4,000.00</td></tr></table>';
    const check = checkDocumentTotal(stale, items, sections);
    expect(check.ok).toBe(false);
    expect(check.expected).toBe('5,125.50');
  });

  it('reflects a discount from the header, not just the line sum', () => {
    const discounted = [{ id: 'meta', data: { discountMode: 'AMT', discountAmountMinor: 12_550 } }];
    const check = checkDocumentTotal('<p>5,000.00</p>', items, discounted);
    expect(check.expected).toBe('5,000.00');
    expect(check.ok).toBe(true);
  });

  it('exempts a proposal with no priced lines', () => {
    expect(checkDocumentTotal('<p>Specification only</p>', [], sections).ok).toBe(true);
  });
});
