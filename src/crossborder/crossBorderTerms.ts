/**
 * The "Cross-Border Terms" printed on every Canadian proposal, as an admin-edited,
 * ordered list (CrossBorderSetting.crossBorderTerms) rather than wording hard-coded in
 * public/proposal-document.js.
 *
 * Two things keep an editable list from contradicting the facts on the proposal it
 * prints on:
 *
 *   - A `condition` decides which proposals a clause prints on. The clauses that
 *     used to be picked by code — the three tariff item 9979.00.00 variants, the three
 *     GST/HST variants, the diversion clause, the named host system — are ordinary
 *     entries with a condition, so an administrator can reword them without losing
 *     the rule that picks one.
 *   - A clause's text may carry {{token}} fields (CROSS_BORDER_TERM_TOKENS) that print
 *     the proposal's own customs-entry values. A clause that says
 *     "{{tariffClassification}}" cannot state a different tariff number from the one
 *     recorded on the proposal, which is exactly how P-2026-000171 came to say
 *     9019.10.00 in Section C and 9979.00.00 in these terms.
 *
 * Conditions are evaluated, and tokens filled, in the document renderer, where every
 * fact they read is already on the model. This module only defines the vocabulary and
 * cleans what is stored.
 */

export type CrossBorderTermCondition =
  | 'ALWAYS'
  | 'TARIFF_9979_CLAIMED'
  | 'TARIFF_9979_NOT_CLAIMED'
  | 'TARIFF_9979_UNDETERMINED'
  | 'GST_STANDARD'
  | 'GST_RELIEF'
  | 'GST_UNDETERMINED'
  | 'IOR_SUMMIT'
  | 'IOR_NOT_SUMMIT'
  | 'HOST_SYSTEM_PRESENT';

export const CROSS_BORDER_TERM_CONDITIONS: CrossBorderTermCondition[] = [
  'ALWAYS',
  'TARIFF_9979_CLAIMED',
  'TARIFF_9979_NOT_CLAIMED',
  'TARIFF_9979_UNDETERMINED',
  'GST_STANDARD',
  'GST_RELIEF',
  'GST_UNDETERMINED',
  'IOR_SUMMIT',
  'IOR_NOT_SUMMIT',
  'HOST_SYSTEM_PRESENT',
];

/**
 * The fill-in fields a clause (or a Section C custom-text row) may use. The document
 * renderer resolves each from the proposal; an unanswered one prints "not yet
 * determined" rather than a blank.
 */
export const CROSS_BORDER_TERM_TOKENS = [
  'tariffClassification',
  'importerOfRecord',
  'customsBroker',
  'countryOfOrigin',
  'hostSystem',
  'fxRate',
  'fxDate',
] as const;

export interface CrossBorderTerm {
  id: string;
  title: string;
  /** Accepts the same **bold** / *italic* markup rt() renders elsewhere. */
  text: string;
  order: number;
  condition: CrossBorderTermCondition;
}

function isCondition(v: unknown): v is CrossBorderTermCondition {
  return typeof v === 'string' && (CROSS_BORDER_TERM_CONDITIONS as string[]).includes(v);
}

/**
 * Coerces the JSON column into a well-formed, order-sorted array. A clause with no
 * text is dropped (it would print a bare heading); an unknown condition degrades to
 * ALWAYS rather than silently hiding a clause from every proposal.
 */
export function normalizeCrossBorderTerms(raw: unknown): CrossBorderTerm[] {
  if (!Array.isArray(raw)) return [];
  const out: CrossBorderTerm[] = [];
  raw.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const text = typeof e.text === 'string' ? e.text.trim() : '';
    if (!text) return;
    out.push({
      id: typeof e.id === 'string' && e.id ? e.id : `term-${idx}`,
      title: typeof e.title === 'string' ? e.title.trim() : '',
      text,
      order: typeof e.order === 'number' && Number.isFinite(e.order) ? e.order : idx,
      condition: isCondition(e.condition) ? e.condition : 'ALWAYS',
    });
  });
  return out.sort((a, b) => a.order - b.order);
}
