import { describe, it, expect } from 'vitest';
import { validateRuleDefinition, RuleDefinitionInput } from '../../src/rules/validation.js';

function parse(obj: unknown) {
  const r = RuleDefinitionInput.safeParse(obj);
  if (!r.success) return { input: null, parseErrors: r.error.issues };
  return { input: r.data, parseErrors: [] };
}

describe('rule definition validation', () => {
  it('accepts a well-formed MIN_CEILING_HEIGHT rule', () => {
    const { input } = parse({ key: 'ceiling-min', type: 'MIN_CEILING_HEIGHT', outcome: 'BLOCK', target: { productId: 'A' }, params: { minCeilingHeightIn: 108 } });
    expect(input).not.toBeNull();
    expect(validateRuleDefinition(input!)).toEqual([]);
  });

  it('rejects an outcome that is illegal for the type', () => {
    const { input } = parse({ key: 'bad-outcome', type: 'AUTO_INCLUDE_COMPONENT', outcome: 'BLOCK', params: { componentProductId: 'X' } });
    const errs = validateRuleDefinition(input!);
    expect(errs.some((e) => e.field === 'outcome')).toBe(true);
  });

  it('rejects missing required params for the type', () => {
    const { input } = parse({ key: 'no-min', type: 'MIN_QUANTITY', outcome: 'BLOCK', params: {} });
    const errs = validateRuleDefinition(input!);
    expect(errs.some((e) => e.field.startsWith('params'))).toBe(true);
  });

  it('rejects non-integer / negative thresholds', () => {
    const { input } = parse({ key: 'neg', type: 'MIN_QUANTITY', outcome: 'BLOCK', params: { min: -2 } });
    expect(validateRuleDefinition(input!).length).toBeGreaterThan(0);
  });

  it('requires an approvalRole for APPROVAL_REQUIRED', () => {
    const { input } = parse({ key: 'appr', type: 'APPROVAL_REQUIRED', outcome: 'REQUIRE_APPROVAL', params: {} });
    expect(validateRuleDefinition(input!).some((e) => e.field === 'approvalRole')).toBe(true);
  });

  it('rejects a malformed rule key', () => {
    const { parseErrors } = parse({ key: 'Bad Key!', type: 'EXCLUDES', outcome: 'BLOCK', params: { productId: 'B' } });
    expect(parseErrors.length).toBeGreaterThan(0);
  });
});
