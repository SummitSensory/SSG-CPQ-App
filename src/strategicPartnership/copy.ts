/**
 * The Canva master's text fields, and the copy that fills them.
 *
 * The copy is customer-facing prose, so it is not hard-wired here: it lives in the
 * StrategicPartnershipSettings row and is edited from Administration as an ordered
 * list of { field, template } rows — a row can be reworded, reordered, or added when
 * the Canva master gains a field. What IS here is the shipped default (the wording
 * from the financial model's Canva_Field_Map sheet, verbatim) and the renderer that
 * turns a template into text.
 *
 * Templates use {{token}} placeholders. The token set is closed: a template naming a
 * token that does not exist is refused when it is saved, so a typo cannot reach a
 * customer as a literal "{{custmerShortName}}".
 */
import {
  type PartnershipOutputs,
  DEFAULT_SCALE_CENTERS,
  formatPercentBps,
  formatWholeDollars,
  formatWholeHours,
} from './calculate.js';

export interface CopyField {
  /** The Canva brand template's data field name, e.g. COVER_PREPARED_FOR. */
  field: string;
  template: string;
}

export interface PartnershipContent {
  /** Canva design title for each generated proposal. */
  titleTemplate: string;
  /** The scale scenario's center counts (the COMBINED_VALUE_n rows and the chart). */
  scaleCenters: number[];
  /**
   * The brand template's chart field, when it has one. Unset means "the template's
   * only chart field, if it has exactly one".
   */
  chartField?: string | null;
  fields: CopyField[];
}

/** Image fields on the master. Not copy: filled with uploaded assets. */
export const IMAGE_FIELDS = [
  'CUSTOMER_LOGO',
  'PROJECT_IMAGE_1',
  'PROJECT_IMAGE_2',
  'PROJECT_IMAGE_3',
  'PROJECT_IMAGE_4',
  'PROJECT_IMAGE_5',
] as const;
export type ImageField = (typeof IMAGE_FIELDS)[number];

export const DEFAULT_TITLE_TEMPLATE =
  '{{customerShortName}} + Summit Strategic Partnership Proposal';

/**
 * Canva_Field_Map, rows 4-30 (text rows only), as shipped — with one correction.
 * The workbook's EXEC_SUMMARY_INTRO was `"The "&CustomerFullName&...`, which with its
 * own sample name ("The Treetop ABA Therapy Center") printed "The The Treetop…"; the
 * reviewed client PDF reads "The Treetop ABA Therapy Center And Summit…". So the
 * default starts at the full name, and the full name carries its own article.
 */
export const DEFAULT_COPY_FIELDS: readonly CopyField[] = [
  { field: 'COVER_CUSTOMER_PLUS_SUMMIT', template: '{{customerShortName}} + Summit' },
  {
    field: 'COVER_PREPARED_FOR',
    template: 'Prepared Exclusively For {{executiveName}}, {{executiveTitle}}',
  },
  {
    field: 'EXEC_SUMMARY_INTRO',
    template:
      '{{customerFullName}} And Summit Sensory Gym Have The Opportunity To Establish A Repeatable Strategic Partnership That Standardizes Sensory-Rich Therapy Environments Across Future Locations While Improving Cost Predictability, Project Visibility, And Internal Efficiency.',
  },
  {
    field: 'EXEC_SUMMARY_CUSTOMER_PLATFORM',
    template:
      'Give {{customerShortName}} Teams A Consistent Sensory Environment Platform That Supports Clinical Programming, Family Experience, And Brand Continuity.',
  },
  {
    field: 'EXEC_SUMMARY_GROWTH',
    template:
      'Establish A Partnership Designed To Support {{customerShortName}}’s Growth With More Consistent Scope, Budgeting, Documentation, And Executive Visibility.',
  },
  {
    field: 'STRATEGIC_RATIONALE_INTRO',
    template:
      'A Standardized Sensory Environment Partnership Brings Together {{customerShortName}}’s Clinical Expertise And Summit’s Purpose-Built Sensory Gym Solutions To Create Consistent, High-Quality Therapy Spaces Across Current And Future Centers.',
  },
  {
    field: 'BRAND_CONSISTENCY_COPY',
    template:
      'Establish A Recognizable {{customerShortName}} Environment Standard Across Locations.\nDeliver A Consistent Look, Feel, And Experience For Families And Teams.\nReinforce Trust Through A Cohesive, Signature Sensory Environment.',
  },
  {
    field: 'PARTNERSHIP_OPPORTUNITY_INTRO',
    template:
      'Summit Sensory Gym Can Serve As A Specialized Partner For Sensory Gym And Related Environment Components, Helping {{customerShortName}} Create A Repeatable Model For New Centers And Renovations. Together, We Can Streamline Planning, Standardize Solutions, And Support Consistent, High-Quality Sensory Spaces Across {{customerShortName}}’s Growing Network.',
  },
  { field: 'STANDARD_PROJECT_VALUE', template: '{{standardProjectValue}}' },
  { field: 'PARTNER_PROJECT_VALUE', template: '{{partnerProjectValue}}' },
  { field: 'PER_CENTER_SAVINGS', template: '{{savingsPerCenter}}' },
  { field: 'PM_HOURS_RETURNED', template: '{{pmHoursReturnedPerCenter}} Hours' },
  { field: 'PM_VALUE_PER_CENTER', template: '{{pmCapacityValuePerCenter}}' },
  {
    field: 'COMBINED_VALUE_10',
    template: '{{scale1.centers}} Centers     {{scale1.combinedValue}}',
  },
  {
    field: 'COMBINED_VALUE_20',
    template: '{{scale2.centers}} Centers     {{scale2.combinedValue}}',
  },
  {
    field: 'COMBINED_VALUE_30',
    template: '{{scale3.centers}} Centers     {{scale3.combinedValue}}',
  },
  {
    field: 'COMBINED_VALUE_50',
    template: '{{scale4.centers}} Centers     {{scale4.combinedValue}}',
  },
  { field: 'THREE_YEAR_EQUIPMENT_SAVINGS', template: '{{threeYearEquipmentSavings}}' },
  { field: 'FIVE_YEAR_EQUIPMENT_SAVINGS', template: '{{fiveYearEquipmentSavings}}' },
  { field: 'THREE_YEAR_COMBINED_VALUE', template: '{{threeYearCombinedValue}}' },
  { field: 'FIVE_YEAR_COMBINED_VALUE', template: '{{fiveYearCombinedValue}}' },
];

export function defaultContent(): PartnershipContent {
  return {
    titleTemplate: DEFAULT_TITLE_TEMPLATE,
    scaleCenters: [...DEFAULT_SCALE_CENTERS],
    chartField: null,
    fields: DEFAULT_COPY_FIELDS.map((f) => ({ ...f })),
  };
}

export interface CopyContext {
  customerShortName: string;
  customerFullName: string;
  executiveName: string;
  executiveTitle: string;
  industry: string;
  partnerDiscountBps: number;
  pmHourValueMinor: bigint;
  outputs: PartnershipOutputs;
}

const MAX_SCALE_ROWS = 8;

/** Every token a template may use, with a one-line description for the editor. */
export function tokenCatalog(): Array<{ token: string; description: string }> {
  const base: Array<[string, string]> = [
    ['customerShortName', 'Customer short name'],
    ['customerFullName', 'Customer full legal / brand name'],
    ['executiveName', 'Executive name'],
    ['executiveTitle', 'Executive title'],
    ['industry', 'Industry / segment'],
    ['partnerDiscount', 'Partner discount, e.g. 17.5%'],
    ['pmHourValue', 'Internal PM hourly value, whole dollars'],
    ['standardProjectValue', 'Standard project value, whole dollars'],
    ['partnerProjectValue', 'Partner project value, whole dollars'],
    ['savingsPerCenter', 'Equipment savings per center, whole dollars'],
    ['pmHoursReturnedPerCenter', 'PM hours returned per center, whole hours'],
    ['pmCapacityValuePerCenter', 'PM capacity value per center, whole dollars'],
    ['combinedValuePerCenter', 'Combined economic value per center, whole dollars'],
    ['threeYearEquipmentSavings', '3-year equipment savings, whole dollars'],
    ['fiveYearEquipmentSavings', '5-year equipment savings, whole dollars'],
    ['threeYearPmCapacityValue', '3-year PM capacity value, whole dollars'],
    ['fiveYearPmCapacityValue', '5-year PM capacity value, whole dollars'],
    ['threeYearCombinedValue', '3-year combined economic value, whole dollars'],
    ['fiveYearCombinedValue', '5-year combined economic value, whole dollars'],
    ['threeYearCumulativeCenters', 'Centers opened by the end of year 3'],
    ['fiveYearCumulativeCenters', 'Centers opened by the end of year 5'],
  ];
  const out = base.map(([token, description]) => ({ token, description }));
  for (let i = 1; i <= MAX_SCALE_ROWS; i++) {
    out.push({ token: `scale${i}.centers`, description: `Scale scenario row ${i}: centers` });
    out.push({
      token: `scale${i}.equipmentSavings`,
      description: `Scale scenario row ${i}: equipment savings`,
    });
    out.push({
      token: `scale${i}.pmCapacityValue`,
      description: `Scale scenario row ${i}: PM capacity value`,
    });
    out.push({
      token: `scale${i}.combinedValue`,
      description: `Scale scenario row ${i}: combined value`,
    });
  }
  return out;
}

const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Tokens a template names that do not exist. Empty means the template is valid. */
export function unknownTokens(template: string): string[] {
  const known = new Set(tokenCatalog().map((t) => t.token));
  const bad = new Set<string>();
  for (const m of template.matchAll(TOKEN_RE)) {
    const name = m[1] ?? '';
    if (!known.has(name)) bad.add(name);
  }
  return [...bad];
}

export class CopyRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopyRenderError';
  }
}

function tokenValues(ctx: CopyContext): Map<string, string> {
  const o = ctx.outputs;
  const v = new Map<string, string>([
    ['customerShortName', ctx.customerShortName],
    ['customerFullName', ctx.customerFullName],
    ['executiveName', ctx.executiveName],
    ['executiveTitle', ctx.executiveTitle],
    ['industry', ctx.industry],
    ['partnerDiscount', formatPercentBps(ctx.partnerDiscountBps)],
    ['pmHourValue', formatWholeDollars(ctx.pmHourValueMinor)],
    ['standardProjectValue', formatWholeDollars(o.standardProjectValueMinor)],
    ['partnerProjectValue', formatWholeDollars(o.partnerProjectValueMinor)],
    ['savingsPerCenter', formatWholeDollars(o.savingsPerCenterMinor)],
    ['pmHoursReturnedPerCenter', formatWholeHours(o.pmHoursReturnedPerCenterHundredths)],
    ['pmCapacityValuePerCenter', formatWholeDollars(o.pmCapacityValuePerCenterMinor)],
    ['combinedValuePerCenter', formatWholeDollars(o.combinedValuePerCenterMinor)],
    ['threeYearEquipmentSavings', formatWholeDollars(o.threeYearEquipmentSavingsMinor)],
    ['fiveYearEquipmentSavings', formatWholeDollars(o.fiveYearEquipmentSavingsMinor)],
    ['threeYearPmCapacityValue', formatWholeDollars(o.threeYearPmCapacityValueMinor)],
    ['fiveYearPmCapacityValue', formatWholeDollars(o.fiveYearPmCapacityValueMinor)],
    ['threeYearCombinedValue', formatWholeDollars(o.threeYearCombinedValueMinor)],
    ['fiveYearCombinedValue', formatWholeDollars(o.fiveYearCombinedValueMinor)],
    ['threeYearCumulativeCenters', String(o.threeYearCumulativeCenters)],
    ['fiveYearCumulativeCenters', String(o.fiveYearCumulativeCenters)],
  ]);
  o.scaleScenario.forEach((row, idx) => {
    const n = idx + 1;
    v.set(`scale${n}.centers`, String(row.centers));
    v.set(`scale${n}.equipmentSavings`, formatWholeDollars(row.equipmentSavingsMinor));
    v.set(`scale${n}.pmCapacityValue`, formatWholeDollars(row.pmCapacityValueMinor));
    v.set(`scale${n}.combinedValue`, formatWholeDollars(row.combinedValueMinor));
  });
  return v;
}

/**
 * Fill one template. A token that exists in the catalog but has no value in this
 * context (a scale row beyond the configured scenario) is an error rather than an
 * empty string — a blank where a dollar figure should be is worse than a refusal.
 */
export function renderTemplate(template: string, ctx: CopyContext): string {
  const values = tokenValues(ctx);
  return template.replace(TOKEN_RE, (_whole, name: string) => {
    const value = values.get(name);
    if (value === undefined) {
      throw new CopyRenderError(
        `The copy uses {{${name}}}, which has no value for this proposal. Check the scale scenario rows in Strategic Partnership settings.`,
      );
    }
    return value;
  });
}

/** Every configured text field, rendered. Later rows win on a duplicated field name. */
export function renderTextFields(
  content: PartnershipContent,
  ctx: CopyContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of content.fields) out[f.field] = renderTemplate(f.template, ctx);
  return out;
}
