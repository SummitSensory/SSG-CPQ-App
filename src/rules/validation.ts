import { z } from 'zod';
import { RULE_TYPES, RULE_OUTCOMES, type RuleType } from './types.js';

const nonNegInt = z.number().int().nonnegative();
const posInt = z.number().int().positive();
const productId = z.string().min(1);

const Target = z.object({
  productId: z.string().optional(),
  categoryId: z.string().optional(),
  kind: z.string().optional(),
});

/** Per-type parameter schemas — every threshold is admin-supplied, never defaulted by the engine. */
const PARAM_SCHEMAS: Record<RuleType, z.ZodTypeAny> = {
  REQUIRES: z.object({ productId }),
  EXCLUDES: z.object({ productId }),
  COMPATIBLE_WITH: z.object({ productId }),
  INCOMPATIBLE_WITH: z.object({ productId }),
  MIN_QUANTITY: z.object({ min: posInt }),
  MAX_QUANTITY: z.object({ max: posInt }),
  MIN_ROOM_DIMENSIONS: z.object({ minLengthIn: posInt, minWidthIn: posInt }),
  MIN_CEILING_HEIGHT: z.object({ minCeilingHeightIn: posInt }),
  CLEARANCE: z.object({ minClearanceIn: posInt }),
  STRUCTURAL: z.object({ factKey: z.string().min(1), expected: z.unknown().optional() }),
  INSTALLATION: z.object({ factKey: z.string().min(1), expected: z.unknown().optional() }),
  FREIGHT: z.object({ factKey: z.string().min(1), expected: z.unknown().optional() }),
  AUTO_INCLUDE_COMPONENT: z.object({ componentProductId: productId, perUnit: posInt.optional() }),
  AUTO_CALCULATED_COMPONENT: z.object({ componentProductId: productId, ratioNum: posInt, ratioDen: posInt }),
  SUGGESTED_ACCESSORY: z.object({ productId }),
  SUGGESTED_UPGRADE: z.object({ productId }),
  APPROVAL_REQUIRED: z.object({}).passthrough(),
  MISSING_INFORMATION: z.object({ infoKey: z.string().min(1), label: z.string().optional() }),
};

/** Which outcomes make sense for each rule type (blocks unapproved combinations). */
const ALLOWED_OUTCOMES: Record<RuleType, string[]> = {
  REQUIRES: ['BLOCK', 'WARN', 'REQUIRE_APPROVAL'],
  EXCLUDES: ['BLOCK', 'WARN'],
  COMPATIBLE_WITH: ['ALLOW'],
  INCOMPATIBLE_WITH: ['BLOCK', 'WARN'],
  MIN_QUANTITY: ['BLOCK', 'WARN'],
  MAX_QUANTITY: ['BLOCK', 'WARN'],
  MIN_ROOM_DIMENSIONS: ['BLOCK', 'WARN'],
  MIN_CEILING_HEIGHT: ['BLOCK', 'WARN'],
  CLEARANCE: ['BLOCK', 'WARN'],
  STRUCTURAL: ['BLOCK', 'WARN', 'REQUIRE_APPROVAL'],
  INSTALLATION: ['BLOCK', 'WARN', 'REQUIRE_APPROVAL'],
  FREIGHT: ['WARN', 'REQUIRE_APPROVAL'],
  AUTO_INCLUDE_COMPONENT: ['AUTO_ADD'],
  AUTO_CALCULATED_COMPONENT: ['AUTO_ADD'],
  SUGGESTED_ACCESSORY: ['RECOMMEND'],
  SUGGESTED_UPGRADE: ['RECOMMEND'],
  APPROVAL_REQUIRED: ['REQUIRE_APPROVAL'],
  MISSING_INFORMATION: ['REQUEST_INFORMATION'],
};

export const RuleDefinitionInput = z.object({
  key: z.string().trim().regex(/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/, 'key: lowercase, hyphen/dot separated'),
  type: z.enum(RULE_TYPES),
  outcome: z.enum(RULE_OUTCOMES),
  target: Target.default({}),
  params: z.record(z.unknown()).default({}),
  message: z.string().max(500).optional(),
  approvalRole: z.string().optional(),
  description: z.string().max(2000).optional(),
});
export type RuleDefinitionInput = z.infer<typeof RuleDefinitionInput>;

export interface RuleValidationError {
  field: string;
  message: string;
}

/** Validate a rule definition for its type: params shape + allowed outcome. */
export function validateRuleDefinition(input: RuleDefinitionInput): RuleValidationError[] {
  const errors: RuleValidationError[] = [];

  if (!ALLOWED_OUTCOMES[input.type].includes(input.outcome)) {
    errors.push({ field: 'outcome', message: `outcome ${input.outcome} is not allowed for ${input.type}` });
  }

  const paramResult = PARAM_SCHEMAS[input.type].safeParse(input.params);
  if (!paramResult.success) {
    for (const i of paramResult.error.issues) {
      errors.push({ field: 'params.' + i.path.join('.'), message: i.message });
    }
  }

  if (input.type === 'APPROVAL_REQUIRED' && !input.approvalRole) {
    errors.push({ field: 'approvalRole', message: 'APPROVAL_REQUIRED needs an approvalRole' });
  }

  return errors;
}
