export const RULE_TYPES = [
  'REQUIRES', 'EXCLUDES', 'COMPATIBLE_WITH', 'INCOMPATIBLE_WITH',
  'MIN_QUANTITY', 'MAX_QUANTITY', 'MIN_ROOM_DIMENSIONS', 'MIN_CEILING_HEIGHT',
  'CLEARANCE', 'STRUCTURAL', 'INSTALLATION', 'FREIGHT',
  'AUTO_INCLUDE_COMPONENT', 'AUTO_CALCULATED_COMPONENT', 'SUGGESTED_ACCESSORY', 'SUGGESTED_UPGRADE',
  'APPROVAL_REQUIRED', 'MISSING_INFORMATION',
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const RULE_OUTCOMES = [
  'ALLOW', 'BLOCK', 'WARN', 'REQUIRE_APPROVAL', 'AUTO_ADD', 'RECOMMEND', 'REQUEST_INFORMATION',
] as const;
export type RuleOutcome = (typeof RULE_OUTCOMES)[number];

/** A rule's evaluation-time definition (comes from RuleVersion.definition). */
export interface RuleDef {
  id: string;
  version: number;
  type: RuleType;
  outcome: RuleOutcome;
  /** Which line(s) this rule applies to. Empty target = whole configuration. */
  target: { productId?: string; categoryId?: string; kind?: string };
  params: Record<string, unknown>;
  message?: string;
  approvalRole?: string;
}

export interface ConfigLine {
  productId: string;
  categoryId?: string;
  kind?: string;
  quantity: number;
}

export interface EvalContext {
  room?: { lengthIn?: number; widthIn?: number; ceilingHeightIn?: number; clearanceIn?: number };
  /** Admin/user-supplied structural, installation and freight facts. */
  facts?: Record<string, unknown>;
  /** Keys of information the user has supplied (for MISSING_INFORMATION). */
  provided?: string[];
}

export interface Configuration {
  lines: ConfigLine[];
  context?: EvalContext;
}

export interface Finding {
  ruleId: string;
  ruleVersion: number;
  type: RuleType;
  outcome: RuleOutcome;
  subjectProductId?: string;
  /** Human-readable explanation of WHY the rule fired. */
  message: string;
  /** The facts that triggered the rule. */
  facts: Record<string, unknown>;
}

export interface AutoAdd {
  productId: string;
  quantity: number;
  sources: Array<{ ruleId: string; ruleVersion: number }>;
}

export interface EvalResult {
  findings: Finding[];
  autoAdds: AutoAdd[];
  requests: Finding[];
  approvals: Finding[];
  recommendations: Finding[];
  blocked: boolean;
  /** Every rule version evaluated — persisted so a proposal can reproduce its result. */
  rulesUsed: Array<{ ruleId: string; version: number }>;
}

export const ENGINE_VERSION = '1.0.0';
