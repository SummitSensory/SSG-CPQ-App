import { describe, it, expect } from 'vitest';
import { calculatePartnership } from '../../src/strategicPartnership/calculate.js';
import {
  CopyRenderError,
  DEFAULT_COPY_FIELDS,
  defaultContent,
  renderTemplate,
  renderTextFields,
  unknownTokens,
  type CopyContext,
} from '../../src/strategicPartnership/copy.js';
import { validateContent } from '../../src/strategicPartnership/settings.js';

const outputs = calculatePartnership({
  partnerDiscountBps: 1750,
  standardProjectValueMinor: 1_651_400n,
  pmHoursReturnedPerCenterHundredths: 4100,
  pmHourValueMinor: 7_500n,
  year1PlannedCenters: 10,
  year2PlannedCenters: 10,
  year3PlannedCenters: 10,
});

const ctx: CopyContext = {
  customerShortName: 'Treetop',
  customerFullName: 'The Treetop ABA Therapy Center',
  executiveName: 'Ari Treuhaft',
  executiveTitle: 'CEO',
  industry: 'ABA Therapy',
  partnerDiscountBps: 1750,
  pmHourValueMinor: 7_500n,
  outputs,
};

describe('Canva copy — the Canva_Field_Map defaults', () => {
  const fields = renderTextFields(defaultContent(), ctx);

  it('fills the cover and narrative the way the workbook did', () => {
    expect(fields.COVER_CUSTOMER_PLUS_SUMMIT).toBe('Treetop + Summit');
    expect(fields.COVER_PREPARED_FOR).toBe('Prepared Exclusively For Ari Treuhaft, CEO');
    // Matches the reviewed client PDF, not the workbook's doubled "The The".
    expect(fields.EXEC_SUMMARY_INTRO).toMatch(
      /^The Treetop ABA Therapy Center And Summit Sensory Gym/,
    );
    expect(fields.EXEC_SUMMARY_GROWTH).toContain('Support Treetop’s Growth');
    expect(fields.BRAND_CONSISTENCY_COPY!.split('\n')).toHaveLength(3);
  });

  it('fills the economics fields in $#,##0 form', () => {
    expect(fields.STANDARD_PROJECT_VALUE).toBe('$16,514');
    expect(fields.PARTNER_PROJECT_VALUE).toBe('$13,624');
    expect(fields.PER_CENTER_SAVINGS).toBe('$2,890');
    expect(fields.PM_HOURS_RETURNED).toBe('41 Hours');
    expect(fields.PM_VALUE_PER_CENTER).toBe('$3,075');
    expect(fields.COMBINED_VALUE_10).toBe('10 Centers     $59,650');
    expect(fields.COMBINED_VALUE_50).toBe('50 Centers     $298,248');
  });

  it('fills the 3-year and 5-year equipment savings fields', () => {
    expect(fields.THREE_YEAR_EQUIPMENT_SAVINGS).toBe('$86,699');
    expect(fields.FIVE_YEAR_EQUIPMENT_SAVINGS).toBe('$144,498');
    expect(fields.THREE_YEAR_COMBINED_VALUE).toBe('$178,949');
    expect(fields.FIVE_YEAR_COMBINED_VALUE).toBe('$298,248');
  });

  it('ships every text field on the master', () => {
    expect(DEFAULT_COPY_FIELDS.map((f) => f.field)).toContain('THREE_YEAR_EQUIPMENT_SAVINGS');
    expect(Object.keys(fields)).toHaveLength(DEFAULT_COPY_FIELDS.length);
  });

  it('the shipped defaults validate', () => {
    expect(() => validateContent(defaultContent())).not.toThrow();
  });
});

describe('templates are checked', () => {
  it('names unknown tokens', () => {
    expect(unknownTokens('Hi {{custmerShortName}} and {{customerShortName}}')).toEqual([
      'custmerShortName',
    ]);
    expect(unknownTokens('{{ scale2.combinedValue }}')).toEqual([]);
  });

  it('refuses to save a template with a typo', () => {
    const c = defaultContent();
    c.fields.push({ field: 'EXTRA', template: 'For {{custmerShortName}}' });
    expect(() => validateContent(c)).toThrow(/custmerShortName/);
  });

  it('refuses a duplicated field', () => {
    const c = defaultContent();
    c.fields.push({ field: 'COVER_PREPARED_FOR', template: 'x' });
    expect(() => validateContent(c)).toThrow(/listed twice/);
  });

  it('a scale row beyond the configured scenario is an error, not a blank', () => {
    expect(() => renderTemplate('{{scale5.combinedValue}}', ctx)).toThrow(CopyRenderError);
  });
});
