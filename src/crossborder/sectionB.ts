/**
 * Section B — "Delivery and Post-Importation Services" — carries an ordered,
 * admin-editable list of clarifying notes, the same add/remove/reorder shape as
 * Section C (src/crossborder/sectionC.ts), at Bryan's explicit request for that same
 * capability on Section B.
 *
 * `CrossBorderSetting.sectionBTemplate` is the org-wide, admin-edited, reorderable
 * starting list; `ProposalCustomsEntry.sectionBItems` is a specific proposal's own
 * list once someone has customized it — null means "still using the live admin
 * template," the same default/override-once-touched shape sectionCItems already
 * uses.
 *
 * Unlike Section C, a Section B item has no BOUND/TEXT distinction — every item is
 * free text. Section B's dollar lines (Third-Party Freight, Structure Crating &
 * Freight, and the rest) are fixed, computed rows driven by the pricing engine, not
 * candidates for an admin-editable list; there is nothing "live" for a Section B
 * item to bind to the way a Section C row can bind to Importer of Record or Country
 * of Origin.
 */

import { clampSubtextSizePt, SUBTEXT_SIZE_DEFAULT } from './sectionC.js';

export interface SectionBItem {
  id: string;
  label: string;
  /** Accepts the same bold/italic markup rt() renders everywhere else in this app
   *  (double asterisks for bold, single for italic) — no separate bold/italic flags. */
  text: string;
  order: number;
  /** Font size (points), clamped to SUBTEXT_SIZE_MIN..SUBTEXT_SIZE_MAX. */
  sizePt?: number;
}

/**
 * Coerces whatever is in the JSON column into a well-formed, order-sorted array.
 * Malformed or unknown-shaped entries are dropped rather than thrown on — a stored
 * JSON blob predating a future field addition should degrade, not break every
 * Canadian proposal's document.
 */
export function normalizeSectionBItems(raw: unknown): SectionBItem[] {
  if (!Array.isArray(raw)) return [];
  const items: SectionBItem[] = [];
  raw.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    if (!label) return;
    const text = typeof e.text === 'string' ? e.text : '';
    items.push({
      id: typeof e.id === 'string' && e.id ? e.id : `item-${idx}`,
      label,
      text,
      order: typeof e.order === 'number' && Number.isFinite(e.order) ? e.order : idx,
      sizePt: clampSubtextSizePt(e.sizePt) ?? SUBTEXT_SIZE_DEFAULT,
    });
  });
  return items.sort((a, b) => a.order - b.order);
}

/**
 * A proposal's own list, once it has one, wins outright — same rule as
 * resolveSectionCItems. `proposalItems` must be the RAW column value (null when
 * nobody has ever touched this proposal's list), not an already-normalized array: an
 * operator can deliberately empty a proposal's Section B notes down to zero items,
 * which is a real, sticky "this proposal shows nothing" choice and must not be
 * confused with "never customized, fall back to the template."
 */
export function resolveSectionBItems(
  proposalItems: unknown,
  templateItems: unknown,
): SectionBItem[] {
  if (proposalItems != null) return normalizeSectionBItems(proposalItems);
  return normalizeSectionBItems(templateItems);
}
