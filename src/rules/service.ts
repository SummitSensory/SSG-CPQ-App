import { prisma } from '../lib/prisma.js';
import { ConflictError, ValidationError, NotFoundError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { evaluateConfiguration, ENGINE_VERSION } from './engine.js';
import { assertNoCycles } from './graph.js';
import { validateRuleDefinition, type RuleDefinitionInput } from './validation.js';
import type { RuleDef, Configuration, EvalResult } from './types.js';

/** Convert a persisted Rule + its current version into an engine RuleDef. */
function toRuleDef(rule: { id: string; type: string; outcome: string; currentVersion: number }, definition: Record<string, unknown>): RuleDef {
  return {
    id: rule.id,
    version: rule.currentVersion,
    type: rule.type as RuleDef['type'],
    outcome: rule.outcome as RuleDef['outcome'],
    target: (definition.target as RuleDef['target']) ?? {},
    params: (definition.params as Record<string, unknown>) ?? {},
    message: definition.message as string | undefined,
    approvalRole: definition.approvalRole as string | undefined,
  };
}

/** Load all ACTIVE rules at their current version as engine definitions. */
export async function getActiveRuleDefs(): Promise<RuleDef[]> {
  const rules = await prisma.rule.findMany({ where: { status: 'ACTIVE' } });
  const defs: RuleDef[] = [];
  for (const r of rules) {
    const v = await prisma.ruleVersion.findUnique({ where: { ruleId_version: { ruleId: r.id, version: r.currentVersion } } });
    if (v) defs.push(toRuleDef(r, v.definition as Record<string, unknown>));
  }
  return defs;
}

export async function createRule(input: RuleDefinitionInput, userId: string): Promise<{ id: string }> {
  const errors = validateRuleDefinition(input);
  if (errors.length) throw new ValidationError('Invalid rule: ' + errors.map((e) => `${e.field}: ${e.message}`).join('; '));

  const existing = await prisma.rule.findUnique({ where: { key: input.key } });
  if (existing) throw new ConflictError('Rule key already exists');

  const rule = await prisma.$transaction(async (tx) => {
    const created = await tx.rule.create({
      data: { key: input.key, type: input.type, outcome: input.outcome, status: 'DRAFT', currentVersion: 1, description: input.description ?? null, createdById: userId },
    });
    await tx.ruleVersion.create({
      data: { ruleId: created.id, version: 1, definition: input as object, changedById: userId, changeNote: 'created' },
    });
    return created;
  });
  await recordAudit({ actorId: userId, action: 'rules.create', entity: 'Rule', entityId: rule.id });
  return { id: rule.id };
}

/** Add a new immutable version to an existing rule (does not auto-activate). */
export async function addRuleVersion(ruleId: string, input: RuleDefinitionInput, userId: string, note?: string): Promise<number> {
  const errors = validateRuleDefinition(input);
  if (errors.length) throw new ValidationError('Invalid rule: ' + errors.map((e) => `${e.field}: ${e.message}`).join('; '));
  const rule = await prisma.rule.findUnique({ where: { id: ruleId } });
  if (!rule) throw new NotFoundError('Rule not found');

  const nextVersion = rule.currentVersion + 1;
  await prisma.$transaction([
    prisma.ruleVersion.create({ data: { ruleId, version: nextVersion, definition: input as object, changedById: userId, changeNote: note ?? null } }),
    prisma.rule.update({ where: { id: ruleId }, data: { currentVersion: nextVersion, outcome: input.outcome, type: input.type } }),
  ]);
  await recordAudit({ actorId: userId, action: 'rules.version', entity: 'Rule', entityId: ruleId, details: { version: nextVersion } });
  return nextVersion;
}

/**
 * Activate a rule (approved change). Rejects activation that would introduce a
 * circular product dependency across the active ruleset.
 */
export async function activateRule(ruleId: string, approverId: string): Promise<void> {
  const rule = await prisma.rule.findUnique({ where: { id: ruleId } });
  if (!rule) throw new NotFoundError('Rule not found');

  const activeDefs = await getActiveRuleDefs();
  const thisVersion = await prisma.ruleVersion.findUnique({ where: { ruleId_version: { ruleId, version: rule.currentVersion } } });
  if (!thisVersion) throw new NotFoundError('Rule version not found');
  const prospective = [...activeDefs.filter((d) => d.id !== ruleId), toRuleDef(rule, thisVersion.definition as Record<string, unknown>)];

  try {
    assertNoCycles(prospective);
  } catch (err) {
    throw new ConflictError(String((err as Error).message));
  }

  await prisma.$transaction([
    prisma.rule.update({ where: { id: ruleId }, data: { status: 'ACTIVE' } }),
    prisma.ruleVersion.update({ where: { ruleId_version: { ruleId, version: rule.currentVersion } }, data: { approvedById: approverId } }),
  ]);
  await recordAudit({ actorId: approverId, action: 'rules.activate', entity: 'Rule', entityId: ruleId, details: { version: rule.currentVersion } });
}

export async function retireRule(ruleId: string, userId: string): Promise<void> {
  const rule = await prisma.rule.findUnique({ where: { id: ruleId } });
  if (!rule) throw new NotFoundError('Rule not found');
  await prisma.rule.update({ where: { id: ruleId }, data: { status: 'RETIRED' } });
  await recordAudit({ actorId: userId, action: 'rules.retire', entity: 'Rule', entityId: ruleId });
}

/**
 * Evaluate a configuration against the current active ruleset. When persist is
 * true, an immutable snapshot records the exact rule versions used — so a
 * proposal's configuration remains reproducible even after rules change.
 */
export async function evaluate(config: Configuration, userId: string, opts: { persist?: boolean; subjectRef?: string } = {}): Promise<EvalResult & { engineVersion: string; snapshotId?: string }> {
  const defs = await getActiveRuleDefs();
  const result = evaluateConfiguration(defs, config);

  let snapshotId: string | undefined;
  if (opts.persist) {
    const snap = await prisma.ruleEvaluationSnapshot.create({
      data: {
        subjectRef: opts.subjectRef ?? null,
        engineVersion: ENGINE_VERSION,
        rulesUsed: result.rulesUsed as object,
        findings: result.findings as object,
        blocked: result.blocked,
        createdById: userId,
      },
    });
    snapshotId = snap.id;
  }
  return { ...result, engineVersion: ENGINE_VERSION, snapshotId };
}
