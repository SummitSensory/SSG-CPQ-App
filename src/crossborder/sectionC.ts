/**
 * Section C — "Canadian Import Terms" — is an ordered, admin-editable list of rows,
 * not a fixed table of predefined fields. Bryan's own words when the fixed-table
 * version was proposed: "I want all of the fields that are being created to have the
 * ability to be edited. I don't want the text to be hardcoded into the software... I
 * need [to] add additional items to the list and be able to organize them in the
 * order I want."
 *
 * So there is no hardcoded list of Section C rows or their wording anywhere in this
 * codebase. `CrossBorderSetting.sectionCTemplate` is the org-wide, admin-edited,
 * reorderable starting list; `ProposalCustomsEntry.sectionCItems` is a specific
 * proposal's own list once someone has customized it (added a row, reordered,
 * reworded a TEXT row) — null means "still using the live admin template," exactly
 * the same default/override-once-touched shape `StandardNote`/`meta.footerNotes`
 * already use elsewhere in this app.
 *
 * A BOUND row is the one exception to "everything is admin text": its label and
 * whether/where it appears are editable, but its printed VALUE always comes from the
 * real structured field on ProposalCustomsEntry or the real computed duty/surtax/
 * brokerage total — never hand-typed, never frozen into this list. That is what keeps
 * "the Canadian duties, surtax and brokerage fees structured the way they are already
 * built" true even though the row that displays them can be renamed or moved.
 */

export type SectionCItemKind = 'BOUND' | 'TEXT';

/**
 * The known structured facts a BOUND row can point at. Adding a new one is a code
 * change (there has to be real data behind it); adding a new TEXT row never is.
 */
export type SectionCBoundField =
  | 'importerOfRecord'
  | 'customsBroker'
  | 'countryOfOrigin'
  | 'tariffClassificationCode'
  | 'tariff9979Claimed'
  | 'gstHstTreatment'
  | 'dutiesEstimate'
  | 'hostSystemModel';

export const SECTION_C_BOUND_FIELDS: SectionCBoundField[] = [
  'importerOfRecord',
  'customsBroker',
  'countryOfOrigin',
  'tariffClassificationCode',
  'tariff9979Claimed',
  'gstHstTreatment',
  'dutiesEstimate',
  'hostSystemModel',
];

export interface SectionCItem {
  id: string;
  kind: SectionCItemKind;
  /** Required when kind is 'BOUND', absent/ignored when kind is 'TEXT'. */
  boundField?: SectionCBoundField;
  label: string;
  /** Required when kind is 'TEXT'; ignored when kind is 'BOUND' (the value is live). */
  text?: string | null;
  order: number;
}

function isSectionCBoundField(v: unknown): v is SectionCBoundField {
  return typeof v === 'string' && (SECTION_C_BOUND_FIELDS as string[]).includes(v);
}

/**
 * Coerces whatever is in the JSON column into a well-formed, order-sorted array.
 * Malformed or unknown-shaped entries are dropped rather than thrown on — a stored
 * JSON blob predating a future field addition should degrade, not break every
 * Canadian proposal's document.
 */
export function normalizeSectionCItems(raw: unknown): SectionCItem[] {
  if (!Array.isArray(raw)) return [];
  const items: SectionCItem[] = [];
  raw.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const kind = e.kind === 'TEXT' ? 'TEXT' : e.kind === 'BOUND' ? 'BOUND' : null;
    if (!kind) return;
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    if (!label) return;
    if (kind === 'BOUND' && !isSectionCBoundField(e.boundField)) return;
    items.push({
      id: typeof e.id === 'string' && e.id ? e.id : `item-${idx}`,
      kind,
      boundField: kind === 'BOUND' ? (e.boundField as SectionCBoundField) : undefined,
      label,
      text: kind === 'TEXT' ? (typeof e.text === 'string' ? e.text : null) : undefined,
      order: typeof e.order === 'number' && Number.isFinite(e.order) ? e.order : idx,
    });
  });
  return items.sort((a, b) => a.order - b.order);
}

/**
 * A proposal's own list, once it has one, wins outright — this mirrors how
 * meta.footerNotes fully replaces the standard-note default the moment it is set,
 * rather than merging with it. Otherwise the live admin template applies, so an
 * admin's wording/ordering edit reaches every proposal that has never diverged.
 *
 * `proposalItems` must be the RAW column value (null when nobody has ever touched
 * this proposal's list) rather than an already-normalized array: an operator can
 * deliberately empty a proposal's Section C down to zero rows, which is a real,
 * sticky "this proposal shows nothing" choice and must not be confused with "never
 * customized, fall back to the template." Checking `.length` instead of `== null`
 * would silently undo that choice on every re-render.
 */
export function resolveSectionCItems(
  proposalItems: unknown,
  templateItems: unknown,
): SectionCItem[] {
  if (proposalItems != null) return normalizeSectionCItems(proposalItems);
  return normalizeSectionCItems(templateItems);
}
