/**
 * Money out of a board cell.
 *
 * Board cells are typed by whoever built the column, so the same figure arrives as
 * "$4,250.00", "4250", "4,250.00 USD" or "". Anything that is not a number after the
 * currency furniture is stripped returns null — "not answered" — which is different
 * from 0, and the difference is the entire point of the queue.
 *
 * Its own module because both board readers need it — the deal-row pull
 * (freightPull.ts) and the freight-request subitems (subitemFreight.ts) — and the
 * first of those calls the second.
 */
export function parseBoardMoney(value: string | null | undefined): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const cleaned = text.replace(/[$,\s]/g, '').replace(/[A-Za-z]+$/, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const amount = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}
