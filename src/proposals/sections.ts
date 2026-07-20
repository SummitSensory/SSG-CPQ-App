/** The catalogue of modular proposal sections. Order and inclusion are data. */
export const SECTION_TYPES = [
  'CUSTOMER_INFO', 'FACILITY_INFO', 'PROJECT_GOALS', 'EXECUTIVE_SUMMARY',
  'RECOMMENDED_CONFIGURATION', 'PRODUCT_DESCRIPTIONS', 'PRODUCT_IMAGES', 'DESIGN_RENDERINGS',
  'INCLUDED_ITEMS', 'OPTIONAL_ITEMS', 'ALTERNATE_ITEMS', 'PRICING_TABLE',
  'PAYMENT_SCHEDULE', 'ASSUMPTIONS', 'CUSTOMER_RESPONSIBILITIES', 'EXCLUSIONS',
  'ESTIMATED_TIMELINE', 'WARRANTY', 'TERMS_AND_CONDITIONS', 'SIGNATURES',
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export interface ProposalSection {
  id: string;
  type: SectionType;
  title: string;
  order: number;
  enabled: boolean;
  /** Optional predicate — section shows only when the condition holds. */
  condition?: { field: string; equals: unknown };
  body?: string;
  data?: Record<string, unknown>;
}

export interface ProposalItem {
  ref: string;
  productId: string;
  name: string;
  kind: 'INCLUDED' | 'OPTIONAL' | 'ALTERNATE';
  quantity: number;
  alternateForRef?: string;
}

export interface EvalFacts {
  [key: string]: unknown;
}

/** Resolve which sections render: enabled AND (no condition OR condition met). */
export function resolveVisibleSections(sections: ProposalSection[], facts: EvalFacts = {}): ProposalSection[] {
  return sections
    .filter((s) => s.enabled)
    .filter((s) => !s.condition || facts[s.condition.field] === s.condition.equals)
    .slice()
    .sort((a, b) => a.order - b.order);
}

/** Reorder sections by an explicit id order; unknown ids dropped, missing ones appended. */
export function reorderSections(sections: ProposalSection[], orderedIds: string[]): ProposalSection[] {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const out: ProposalSection[] = [];
  orderedIds.forEach((id, i) => {
    const s = byId.get(id);
    if (s) {
      out.push({ ...s, order: i });
      byId.delete(id);
    }
  });
  let n = out.length;
  for (const s of byId.values()) out.push({ ...s, order: n++ });
  return out;
}
