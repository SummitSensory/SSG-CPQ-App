import type {
  RuleDef, Configuration, ConfigLine, EvalContext, Finding, AutoAdd, EvalResult, RuleType,
} from './types.js';
import { ENGINE_VERSION } from './types.js';

export { ENGINE_VERSION };

/** Interpolate {tokens} in a message template from a facts object. */
function interpolate(template: string, facts: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => (k in facts ? String(facts[k]) : `{${k}}`));
}

function present(lines: ConfigLine[], productId: string): ConfigLine | undefined {
  return lines.find((l) => l.productId === productId);
}

function matchesTarget(line: ConfigLine, t: RuleDef['target']): boolean {
  if (t.productId && line.productId !== t.productId) return false;
  if (t.categoryId && line.categoryId !== t.categoryId) return false;
  if (t.kind && line.kind !== t.kind) return false;
  return true;
}

/** Lines a rule applies to. An empty target matches the whole configuration (returns a single null-subject pass). */
function subjectLines(lines: ConfigLine[], t: RuleDef['target']): Array<ConfigLine | null> {
  const hasTarget = Boolean(t.productId || t.categoryId || t.kind);
  if (!hasTarget) return [null];
  return lines.filter((l) => matchesTarget(l, t));
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function requireParam(rule: RuleDef, key: string): number {
  const v = num(rule.params[key]);
  if (v === undefined) {
    // The engine NEVER invents thresholds. A misconfigured rule is a config error, not an assumption.
    throw new Error(`Rule ${rule.id} (${rule.type}) missing numeric param "${key}"`);
  }
  return v;
}

function mk(
  rule: RuleDef,
  subjectProductId: string | undefined,
  facts: Record<string, unknown>,
  fallbackMsg: string,
): Finding {
  const message = rule.message ? interpolate(rule.message, facts) : fallbackMsg;
  return { ruleId: rule.id, ruleVersion: rule.version, type: rule.type, outcome: rule.outcome, subjectProductId, message, facts };
}

/**
 * Evaluate a configuration against a set of rule definitions.
 * Pure and deterministic — no I/O, no hard-coded engineering thresholds.
 */
export function evaluateConfiguration(rules: RuleDef[], config: Configuration): EvalResult {
  const lines = config.lines;
  const ctx: EvalContext = config.context ?? {};
  const room = ctx.room ?? {};
  const facts = ctx.facts ?? {};
  const provided = new Set(ctx.provided ?? []);

  const findings: Finding[] = [];
  const rawAdds: Array<{ productId: string; quantity: number; ruleId: string; ruleVersion: number }> = [];

  for (const rule of rules) {
    for (const subject of subjectLines(lines, rule.target)) {
      const sid = subject?.productId;
      const sqty = subject?.quantity ?? 0;

      switch (rule.type) {
        case 'REQUIRES': {
          if (!subject) break;
          const req = String(rule.params.productId ?? '');
          if (req && !present(lines, req)) {
            findings.push(mk(rule, sid, { subject: sid, required: req }, `${sid} requires ${req}, which is not in the configuration.`));
          }
          break;
        }
        case 'EXCLUDES': {
          if (!subject) break;
          const other = String(rule.params.productId ?? '');
          if (other && present(lines, other)) {
            findings.push(mk(rule, sid, { subject: sid, excluded: other }, `${sid} cannot be configured together with ${other}.`));
          }
          break;
        }
        case 'COMPATIBLE_WITH': {
          if (!subject) break;
          const other = String(rule.params.productId ?? '');
          if (other && present(lines, other)) {
            findings.push(mk(rule, sid, { subject: sid, compatibleWith: other }, `${sid} is confirmed compatible with ${other}.`));
          }
          break;
        }
        case 'INCOMPATIBLE_WITH': {
          if (!subject) break;
          const other = String(rule.params.productId ?? '');
          if (other && present(lines, other)) {
            findings.push(mk(rule, sid, { subject: sid, incompatibleWith: other }, `${sid} is not compatible with ${other}.`));
          }
          break;
        }
        case 'MIN_QUANTITY': {
          if (!subject) break;
          const min = requireParam(rule, 'min');
          if (sqty < min) findings.push(mk(rule, sid, { subject: sid, quantity: sqty, min }, `${sid} requires a minimum quantity of ${min} (has ${sqty}).`));
          break;
        }
        case 'MAX_QUANTITY': {
          if (!subject) break;
          const max = requireParam(rule, 'max');
          if (sqty > max) findings.push(mk(rule, sid, { subject: sid, quantity: sqty, max }, `${sid} exceeds the maximum quantity of ${max} (has ${sqty}).`));
          break;
        }
        case 'MIN_ROOM_DIMENSIONS': {
          if (!subject) break;
          const minL = requireParam(rule, 'minLengthIn');
          const minW = requireParam(rule, 'minWidthIn');
          if (room.lengthIn === undefined || room.widthIn === undefined) {
            findings.push(reqInfo(rule, sid, { need: 'room.lengthIn, room.widthIn' }, `Room dimensions are needed to validate ${sid}.`));
          } else if (room.lengthIn < minL || room.widthIn < minW) {
            findings.push(mk(rule, sid, { subject: sid, room, minLengthIn: minL, minWidthIn: minW }, `${sid} needs at least ${minL}x${minW} in; room is ${room.lengthIn}x${room.widthIn} in.`));
          }
          break;
        }
        case 'MIN_CEILING_HEIGHT': {
          if (!subject) break;
          const min = requireParam(rule, 'minCeilingHeightIn');
          if (room.ceilingHeightIn === undefined) {
            findings.push(reqInfo(rule, sid, { need: 'room.ceilingHeightIn' }, `Ceiling height is needed to validate ${sid}.`));
          } else if (room.ceilingHeightIn < min) {
            findings.push(mk(rule, sid, { subject: sid, ceilingHeightIn: room.ceilingHeightIn, min }, `${sid} needs ${min} in ceiling; room has ${room.ceilingHeightIn} in.`));
          }
          break;
        }
        case 'CLEARANCE': {
          if (!subject) break;
          const min = requireParam(rule, 'minClearanceIn');
          if (room.clearanceIn === undefined) {
            findings.push(reqInfo(rule, sid, { need: 'room.clearanceIn' }, `Clearance measurement is needed to validate ${sid}.`));
          } else if (room.clearanceIn < min) {
            findings.push(mk(rule, sid, { subject: sid, clearanceIn: room.clearanceIn, min }, `${sid} needs ${min} in clearance; only ${room.clearanceIn} in available.`));
          }
          break;
        }
        case 'STRUCTURAL':
        case 'INSTALLATION':
        case 'FREIGHT': {
          if (!subject) break;
          const factKey = String(rule.params.factKey ?? '');
          // No engineering assumptions: if the fact is absent, request it — never assume a value.
          if (factKey && !(factKey in facts)) {
            findings.push(reqInfo(rule, sid, { need: `facts.${factKey}` }, `${labelFor(rule.type)} information "${factKey}" is required for ${sid}.`));
          } else if (factKey && 'expected' in rule.params && facts[factKey] !== rule.params.expected) {
            findings.push(mk(rule, sid, { subject: sid, factKey, actual: facts[factKey], expected: rule.params.expected }, `${labelFor(rule.type)} check failed for ${sid}: ${factKey} is ${String(facts[factKey])}, expected ${String(rule.params.expected)}.`));
          }
          break;
        }
        case 'AUTO_INCLUDE_COMPONENT': {
          if (!subject) break;
          const comp = String(rule.params.componentProductId ?? '');
          const perUnit = num(rule.params.perUnit) ?? 1;
          if (comp) rawAdds.push({ productId: comp, quantity: sqty * perUnit, ruleId: rule.id, ruleVersion: rule.version });
          break;
        }
        case 'AUTO_CALCULATED_COMPONENT': {
          if (!subject) break;
          const comp = String(rule.params.componentProductId ?? '');
          const numr = requireParam(rule, 'ratioNum');
          const den = requireParam(rule, 'ratioDen');
          if (den <= 0) throw new Error(`Rule ${rule.id} ratioDen must be > 0`);
          // Integer ceil math — no floating-point drift.
          const qty = Math.ceil((sqty * numr) / den);
          if (comp && qty > 0) rawAdds.push({ productId: comp, quantity: qty, ruleId: rule.id, ruleVersion: rule.version });
          break;
        }
        case 'SUGGESTED_ACCESSORY': {
          if (!subject) break;
          const acc = String(rule.params.productId ?? '');
          if (acc && !present(lines, acc)) findings.push(mk(rule, sid, { subject: sid, accessory: acc }, `Consider adding accessory ${acc} for ${sid}.`));
          break;
        }
        case 'SUGGESTED_UPGRADE': {
          if (!subject) break;
          const up = String(rule.params.productId ?? '');
          if (up && !present(lines, up)) findings.push(mk(rule, sid, { subject: sid, upgrade: up }, `An upgrade (${up}) is available for ${sid}.`));
          break;
        }
        case 'APPROVAL_REQUIRED': {
          if (!subject) break;
          findings.push(mk(rule, sid, { subject: sid, role: rule.approvalRole ?? null }, `${sid} requires approval${rule.approvalRole ? ` from ${rule.approvalRole}` : ''}.`));
          break;
        }
        case 'MISSING_INFORMATION': {
          const key = String(rule.params.infoKey ?? '');
          if (key && !provided.has(key)) {
            findings.push(reqInfo(rule, sid, { infoKey: key, label: rule.params.label ?? key }, `Required information "${String(rule.params.label ?? key)}" is missing.`));
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // Dedupe automatic additions: one line per product; skip products already in the config.
  const existing = new Set(lines.map((l) => l.productId));
  const merged = new Map<string, AutoAdd>();
  for (const a of rawAdds) {
    if (existing.has(a.productId)) continue; // already present — never double-add
    const cur = merged.get(a.productId);
    if (cur) {
      cur.quantity = Math.max(cur.quantity, a.quantity);
      cur.sources.push({ ruleId: a.ruleId, ruleVersion: a.ruleVersion });
    } else {
      merged.set(a.productId, { productId: a.productId, quantity: a.quantity, sources: [{ ruleId: a.ruleId, ruleVersion: a.ruleVersion }] });
    }
  }
  const autoAdds = [...merged.values()];

  return {
    findings,
    autoAdds,
    requests: findings.filter((f) => f.outcome === 'REQUEST_INFORMATION'),
    approvals: findings.filter((f) => f.outcome === 'REQUIRE_APPROVAL'),
    recommendations: findings.filter((f) => f.outcome === 'RECOMMEND'),
    blocked: findings.some((f) => f.outcome === 'BLOCK'),
    rulesUsed: rules.map((r) => ({ ruleId: r.id, version: r.version })),
  };
}

function reqInfo(rule: RuleDef, sid: string | undefined, facts: Record<string, unknown>, fallback: string): Finding {
  // A missing-fact situation always surfaces as REQUEST_INFORMATION regardless of the rule's nominal outcome.
  const message = rule.message ? interpolate(rule.message, facts) : fallback;
  return { ruleId: rule.id, ruleVersion: rule.version, type: rule.type, outcome: 'REQUEST_INFORMATION', subjectProductId: sid, message, facts };
}

function labelFor(t: RuleType): string {
  if (t === 'STRUCTURAL') return 'Structural';
  if (t === 'INSTALLATION') return 'Installation';
  return 'Freight';
}
